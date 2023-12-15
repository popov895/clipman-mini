'use strict';

const ExtensionUtils = imports.misc.extensionUtils;

var _ = (text, context) => {
    return context ? ExtensionUtils.pgettext(context, text) : ExtensionUtils.gettext(text);
};
