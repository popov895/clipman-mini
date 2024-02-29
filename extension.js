'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SignalTracker from 'resource:///org/gnome/shell/misc/signalTracker.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Preferences } from './lib/preferences.js';
import { _ } from './lib/utils.js';

const Clipboard = GObject.registerClass(
class Clipboard extends GObject.Object {
    static [GObject.GTypeName] = `ClipmanMini_Clipboard`;

    static [GObject.signals] = {
        'destroy': {},
        'changed': {},
    };

    constructor() {
        super();

        this._sensitiveMimeTypes = [
            `x-kde-passwordManagerHint`,
        ];

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.get_display().get_selection();
        this._selection.connectObject(`owner-changed`, (...[, selectionType]) => {
            if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                this.emit(`changed`);
            }
        }, this);
    }

    destroy() {
        this.emit(`destroy`);
    }

    getText() {
        const mimeTypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        const hasSensitiveMimeType = mimeTypes.some((mimeType) => {
            return this._sensitiveMimeTypes.includes(mimeType);
        });
        if (hasSensitiveMimeType) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (...[, text]) => {
                resolve(text);
            });
        });
    }

    setText(text) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    clear() {
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, ``, GLib.Bytes.new(null));
    }
});

const HistoryMenuItem = GObject.registerClass(
class HistoryMenuItem extends PopupMenu.PopupMenuItem {
    static [GObject.properties] = {
        'maxTextLength': GObject.ParamSpec.int(
            `maxTextLength`, ``, ``,
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXINT32, 0
        ),
    };

    static [GObject.signals] = {
        'delete': {},
    };

    constructor(text) {
        super(``);

        this.text = text;
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this.setOrnament(PopupMenu.Ornament.NONE);

        this.add_child(new St.Bin({
            style_class: `popup-menu-item-expander`,
            x_expand: true,
        }));

        const deleteButton = new St.Button({
            can_focus: true,
            child: new St.Icon({
                icon_name: `edit-delete-symbolic`,
                style_class: `popup-menu-icon`,
            }),
            style_class: `clipman-menuitembutton`,
        });
        deleteButton.connectObject(`clicked`, () => {
            this.emit(`delete`);
        });

        const box = new St.BoxLayout({
            style_class: `clipman-menuitembuttonbox`,
        });
        box.add(deleteButton);
        this.add_child(box);

        this.connectObject(`notify::maxTextLength`, this._updateText.bind(this));
    }

    get maxTextLength() {
        return this._maxTextLength ?? 0;
    }

    set maxTextLength(maxTextLength) {
        if (this._maxTextLength === maxTextLength) {
            return;
        }

        this._maxTextLength = maxTextLength;
        this.notify(`maxTextLength`);
    }

    _createTextFormatter(text) {
        return {
            text,
            markBoundaryWhitespace() {
                this.text = GLib.markup_escape_text(this.text, -1);
                this.text = this.text.replaceAll(/^\s+|\s+$/g, (match1) => {
                    [[/ +/g, `␣`], [/\t+/g, `⇥`], [/\n+/g, `↵`]].forEach(([regExp, str]) => {
                        match1 = match1.replaceAll(regExp, (match2) => {
                            return `<span alpha='35%'>${str.repeat(match2.length)}</span>`;
                        });
                    });
                    return match1;
                });
                return this;
            },
            shrinkWhitespace() {
                this.text = this.text.replaceAll(/\s+/g, ` `);
                return this;
            },
            truncate(count) {
                if (this.text.length > count) {
                    this.text = this.text.substring(0, count - 1) + `…`;
                }
                return this;
            },
        };
    }

    _updateText() {
        this.label.clutter_text.set_markup(
            this._createTextFormatter(this.text)
                .truncate(this.maxTextLength)
                .markBoundaryWhitespace()
                .shrinkWhitespace()
                .text
        );
    }

    vfunc_key_press_event(event) {
        switch (event.get_key_symbol()) {
            case Clutter.KEY_space:
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter: {
                this.activate(Clutter.get_current_event());
                return Clutter.EVENT_STOP;
            }
            case Clutter.KEY_Delete:
            case Clutter.KEY_KP_Delete: {
                this.emit(`delete`);
                return Clutter.EVENT_STOP;
            }
            default:
                break;
        }

        return super.vfunc_key_press_event(event);
    }
});

const HistoryMenuSection = class extends PopupMenu.PopupMenuSection {
    constructor() {
        super();

        this.entry = new St.Entry({
            can_focus: true,
            hint_text: _(`Type to search...`),
            style_class: `clipman-searchentry`,
            x_expand: true,
        });
        this.entry.connectObject(
            `enter-event`, () => {
                this.entry.grab_key_focus();
                return Clutter.EVENT_PROPAGATE;
            },
            `notify::text`, this._onEntryTextChanged.bind(this)
        );
        const searchMenuItem = new PopupMenu.PopupBaseMenuItem({
            can_focus: false,
            reactive: false,
            style_class: `clipman-searchmenuitem`,
        });
        searchMenuItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        searchMenuItem.add(this.entry);
        this.addMenuItem(searchMenuItem);

        const placeholderLabel = new St.Label({
            text: _(`No Matches`),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._placeholderMenuItem = new PopupMenu.PopupMenuSection();
        this._placeholderMenuItem.actor.style_class = `popup-menu-item`;
        this._placeholderMenuItem.actor.visible = false;
        this._placeholderMenuItem.actor.add(placeholderLabel);
        this.addMenuItem(this._placeholderMenuItem);

        this.section = new PopupMenu.PopupMenuSection();
        this.section.box.connectObject(
            `actor-added`, (...[, actor]) => {
                if (actor instanceof HistoryMenuItem) {
                    this._onMenuItemAdded(actor);
                }
            },
            `actor-removed`, (...[, actor]) => {
                if (actor instanceof HistoryMenuItem) {
                    this._onMenuItemRemoved(actor);
                }
            }
        );
        this.scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
        });
        this.scrollView.add_actor(this.section.actor);
        this.scrollView.vscroll.adjustment.connectObject(`changed`, () => {
            Promise.resolve().then(() => {
                if (Math.floor(this.scrollView.vscroll.adjustment.upper) > this.scrollView.vscroll.adjustment.page_size) {
                    this.scrollView.vscrollbar_policy = St.PolicyType.ALWAYS;
                } else {
                    this.scrollView.vscrollbar_policy = St.PolicyType.EXTERNAL;
                }
            });
        });
        const menuSection = new PopupMenu.PopupMenuSection();
        menuSection.actor.add_actor(this.scrollView);
        this.addMenuItem(menuSection);

        this.actor.connectObject(`notify::mapped`, () => {
            if (!this.actor.mapped) {
                this.scrollView.vscroll.adjustment.value = 0;
                this.entry.text = ``;
            }
        });
    }

    _setParent(parent) {
        super._setParent(parent);

        this.section._setParent(parent);
    }

    _createFilter() {
        return {
            text: this.entry.text.toLowerCase(),
            isActive() {
                return this.text.length > 0;
            },
            apply(menuItem) {
                menuItem.actor.visible = menuItem.text.toLowerCase().includes(this.text);
            },
        };
    }

    _onEntryTextChanged() {
        const filter = this._createFilter();
        this.section._getMenuItems().forEach(filter.apply, filter);
        if (!filter.isActive()) {
            this._placeholderMenuItem.actor.visible = false;
        } else {
            this._placeholderMenuItem.actor.visible = this.section.isEmpty();
        }
    }

    _onMenuItemAdded(menuItem) {
        const filter = this._createFilter();
        if (filter.isActive()) {
            filter.apply(menuItem);
            if (menuItem.actor.visible) {
                this._placeholderMenuItem.actor.visible = false;
            }
        }

        menuItem.connectObject(`key-focus-in`, () => {
            const event = Clutter.get_current_event();
            if (event && event.type() === Clutter.EventType.KEY_PRESS) {
                AnimationUtils.ensureActorVisibleInScrollView(this.scrollView, menuItem);
            }
        });
    }

    _onMenuItemRemoved() {
        if (this._createFilter().isActive()) {
            this._placeholderMenuItem.actor.visible = this.section.isEmpty();
        }
    }
};

const PlaceholderMenuItem = class extends PopupMenu.PopupMenuSection {
    constructor(text, icon) {
        super();

        this.actor.style_class = `popup-menu-item`;

        const box = new St.BoxLayout({
            style_class: `clipman-placeholdermenuitembox`,
            vertical: true,
        });
        box.add_child(new St.Icon({
            gicon: icon,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: text,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this.actor.add(box);
    }
};

const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    constructor(extension) {
        super(0.5);

        this._extension = extension;

        this._buildIcon();
        this._buildMenu();

        this._clipboard = new Clipboard();
        this._clipboard.connectObject(`changed`, () => {
            if (!this._privateModeMenuItem.state) {
                this._clipboard.getText().then((text) => {
                    this._onClipboardTextChanged(text);
                });
            }
        });

        this._preferences = new Preferences(this._extension);
        this._preferences.connectObject(`notify::historySize`, this._onHistorySizeChanged.bind(this));

        this._addKeybindings();
        this._loadState();
        this._updateMenuLayout();
    }

    destroy() {
        this._removeKeybindings();
        this._saveState();

        this._clipboard.destroy();
        this._preferences.destroy();

        super.destroy();
    }

    _buildIcon() {
        this._mainIcon = new St.Icon({
            icon_name: `edit-paste-symbolic`,
            style_class: `system-status-icon`,
        });
        this.add_child(this._mainIcon);
    }

    _buildMenu() {
        this._emptyPlaceholder = new PlaceholderMenuItem(
            _(`History is Empty`),
            Gio.icon_new_for_string(`${this._extension.path}/icons/empty-symbolic.svg`)
        );
        this.menu.addMenuItem(this._emptyPlaceholder);

        this._privateModePlaceholder = new PlaceholderMenuItem(
            _(`Private Mode is On`),
            Gio.icon_new_for_string(`${this._extension.path}/icons/private-mode-symbolic.svg`)
        );
        this.menu.addMenuItem(this._privateModePlaceholder);

        this._historySection = new HistoryMenuSection();
        this._historySection.section.box.connectObject(
            `actor-added`, (...[, actor]) => {
                if (actor instanceof HistoryMenuItem) {
                    this._updateMenuLayout();
                }
            },
            `actor-removed`, (...[, actor]) => {
                if (actor instanceof HistoryMenuItem) {
                    this._updateMenuLayout();
                }
            }
        );
        this.menu.addMenuItem(this._historySection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._clearMenuItem = this.menu.addAction(_(`Clear History`), () => {
            this.menu.close();
            this._getMenuItems().erase();
        });

        this._privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(_(`Private Mode`), false);
        this._privateModeMenuItem._switch.bind_property_full(
            `state`,
            this._mainIcon,
            `opacity`,
            GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE,
            (...[, state]) => {
                return [true, state ? 255 / 2 : 255];
            },
            null
        );
        this._privateModeMenuItem.connectObject(`toggled`, (...[, state]) => {
            this.menu.close();
            if (!state) {
                this._updateCurrentMenuItem();
            }
            this._updateMenuLayout();
        });
        this.menu.addMenuItem(this._privateModeMenuItem);

        this.menu.addAction(_(`Settings`, `Open settings`), () => {
            this._extension.openPreferences();
        });

        this.menu.actor.connectObject(`captured-event`, (...[, event]) => {
            if (event.type() === Clutter.EventType.KEY_PRESS) {
                return this._onMenuKeyPressEvent(event);
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _getMenuItems() {
        const menuItems = this._historySection.section._getMenuItems();
        menuItems.erase = (start = 0, count = Infinity) => {
            menuItems.splice(start, count).forEach(this._destroyMenuItem, this);
        };
        menuItems.findByText = (text) => {
            return menuItems.find((menuItem) => {
                return menuItem.text === text;
            });
        };
        menuItems.isLast = (menuItem) => {
            return menuItems.length > 0 && menuItems[menuItems.length - 1] === menuItem;
        };

        return menuItems;
    }

    _createMenuItem(text) {
        const menuItem = new HistoryMenuItem(text);
        menuItem.connectObject(
            `activate`, () => {
                this.menu.close();
                this._clipboard.setText(menuItem.text);
            },
            `delete`, () => {
                if (this._getMenuItems().length === 1) {
                    this.menu.close();
                }
                this._destroyMenuItem(menuItem);
            },
            `destroy`, () => {
                if (this._currentMenuItem === menuItem) {
                    delete this._currentMenuItem;
                }
            }
        );

        return menuItem;
    }

    _destroyMenuItem(menuItem) {
        if (this._currentMenuItem === menuItem) {
            this._clipboard.clear();
        }

        if (menuItem.has_key_focus()) {
            const menuItems = this._getMenuItems();
            if (menuItems.length > 1) {
                menuItem.get_parent().navigate_focus(
                    menuItem,
                    menuItems.isLast(menuItem) ? St.DirectionType.UP : St.DirectionType.DOWN,
                    false
                );
            }
        }

        menuItem.destroy();
    }

    _updateCurrentMenuItem() {
        this._clipboard.getText().then((text) => {
            let currentMenuItem;
            if (text && text.length > 0) {
                const menuItems = this._getMenuItems();
                currentMenuItem = menuItems.findByText(text);
                if (currentMenuItem && menuItems[0] !== currentMenuItem) {
                    this._historySection.section.moveMenuItem(currentMenuItem, 0);
                }
            }

            if (this._currentMenuItem !== currentMenuItem) {
                this._currentMenuItem?.setOrnament(PopupMenu.Ornament.NONE);
                this._currentMenuItem = currentMenuItem;
                this._currentMenuItem?.setOrnament(PopupMenu.Ornament.DOT);
            }
        });
    }

    _updateMenuLayout() {
        const privateMode = this._privateModeMenuItem.state;
        this._privateModePlaceholder.actor.visible = privateMode;

        const isEmpty = this._getMenuItems().length === 0;
        this._emptyPlaceholder.actor.visible = !privateMode && isEmpty;
        this._historySection.actor.visible = !privateMode && !isEmpty;
        this._clearMenuItem.actor.visible = !privateMode && !isEmpty;
    }

    _updateMenuMinMaxSize() {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.findIndexForActor(this.menu.actor)
        );
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const minAvailableSize = Math.min(workArea.width, workArea.height) / scaleFactor;

        const [menuMaxWidth, menuMaxHeight] = [
            Math.round(minAvailableSize * 0.6),
            Math.round(minAvailableSize * 0.7),
        ];
        this.menu.actor.style = `max-width: ${menuMaxWidth}px; max-height: ${menuMaxHeight}px;`;

        const entryMinWidth = Math.min(300, Math.round(menuMaxWidth * 0.75));
        this._historySection.entry.style = `min-width: ${entryMinWidth}px;`;

        this._getMenuItems().forEach((menuItem) => {
            menuItem.maxTextLength = menuMaxWidth;
        });
    }

    _addKeybindings() {
        Main.wm.addKeybinding(
            this._preferences._keyToggleMenuShortcut,
            this._preferences._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => {
                this.menu.toggle();
            }
        );
        Main.wm.addKeybinding(
            this._preferences._keyTogglePrivateModeShortcut,
            this._preferences._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => {
                this._privateModeMenuItem.toggle();
            }
        );
        Main.wm.addKeybinding(
            this._preferences._keyClearHistoryShortcut,
            this._preferences._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => {
                if (this._clearMenuItem.actor.visible) {
                    this._clearMenuItem.activate(Clutter.get_current_event());
                }
            }
        );
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding(this._preferences._keyToggleMenuShortcut);
        Main.wm.removeKeybinding(this._preferences._keyTogglePrivateModeShortcut);
        Main.wm.removeKeybinding(this._preferences._keyClearHistoryShortcut);
    }

    _loadState() {
        this._privateModeMenuItem.setToggleState(panelIndicator.state.privateMode);

        if (panelIndicator.state.history.length > 0) {
            panelIndicator.state.history.forEach((entry) => {
                this._historySection.section.addMenuItem(
                    this._createMenuItem(entry.text)
                );
            });
            panelIndicator.state.history.length = 0;

            if (!this._privateModeMenuItem.state) {
                this._updateCurrentMenuItem();
            }

            this._updateMenuLayout();
        }
    }

    _saveState() {
        if (Main.sessionMode.currentMode !== `unlock-dialog`) {
            panelIndicator.state.privateMode = false;
        } else {
            panelIndicator.state.privateMode = this._privateModeMenuItem.state;
            panelIndicator.state.history = this._getMenuItems().map((menuItem) => {
                return {
                    text: menuItem.text,
                };
            });
        }
    }

    _onClipboardTextChanged(text) {
        let currentMenuItem;
        if (text && text.length > 0) {
            const menuItems = this._getMenuItems();
            currentMenuItem = menuItems.findByText(text);
            if (currentMenuItem) {
                if (menuItems[0] !== currentMenuItem) {
                    this._historySection.section.moveMenuItem(currentMenuItem, 0);
                }
            } else {
                menuItems.erase(this._preferences.historySize - 1);
                currentMenuItem = this._createMenuItem(text);
                this._historySection.section.addMenuItem(currentMenuItem, 0);
            }
        }

        if (this._currentMenuItem !== currentMenuItem) {
            this._currentMenuItem?.setOrnament(PopupMenu.Ornament.NONE);
            this._currentMenuItem = currentMenuItem;
            this._currentMenuItem?.setOrnament(PopupMenu.Ornament.DOT);
        }
    }

    _onHistorySizeChanged() {
        this._getMenuItems().erase(this._preferences.historySize);
    }

    _onMenuKeyPressEvent(event) {
        switch (event.get_key_symbol()) {
            case Clutter.KEY_Escape: {
                if (this._historySection.entry.clutter_text.has_key_focus() && this._historySection.entry.text.length > 0) {
                    this._historySection.entry.text = ``;
                    return Clutter.EVENT_STOP;
                }
                break;
            }
            case Clutter.KEY_slash: {
                if (this._historySection.actor.visible) {
                    this._historySection.entry.grab_key_focus();
                    this._historySection.entry.clutter_text.set_selection(-1, 0);
                    return Clutter.EVENT_STOP;
                }
                break;
            }
            default:
                break;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onOpenStateChanged(...[, open]) {
        if (open) {
            this.add_style_pseudo_class(`active`);

            Promise.resolve().then(() => {
                this._historySection.entry.grab_key_focus();
            });

            this._updateMenuMinMaxSize();
        } else {
            this.remove_style_pseudo_class(`active`);
        }
    }
});

const panelIndicator = {
    instance: null,
    state: {
        history: [],
        privateMode: false,
    },
};

export default class extends Extension {
    static {
        SignalTracker.registerDestroyableType(Clipboard);
        SignalTracker.registerDestroyableType(Preferences);
    }

    enable() {
        panelIndicator.instance = new PanelIndicator(this);
        Main.panel.addToStatusArea(`${this.metadata.name}`, panelIndicator.instance);
    }

    disable() {
        panelIndicator.instance.destroy();
        delete panelIndicator.instance;
    }
}
