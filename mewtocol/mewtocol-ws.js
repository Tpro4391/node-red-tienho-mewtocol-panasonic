'use strict';
const { registerCommandNode, wordWriter } = require('./common');

module.exports = function (RED) {
    // WS - write 16-bit words from msg.payload
    registerCommandNode(RED, 'mewtocol-ws', wordWriter('WS', false));
};
