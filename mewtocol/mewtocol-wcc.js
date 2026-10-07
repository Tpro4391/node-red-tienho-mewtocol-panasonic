'use strict';
const { registerCommandNode, wordWriter } = require('./common');

module.exports = function (RED) {
    // WCC - write 16-bit words from msg.payload
    registerCommandNode(RED, 'mewtocol-wcc', wordWriter('WCC', true));
};
