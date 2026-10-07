'use strict';
const { registerCommandNode, wordWriter } = require('./common');

module.exports = function (RED) {
    // WD - write 16-bit words from msg.payload
    registerCommandNode(RED, 'mewtocol-wd', wordWriter('WD', true));
};
