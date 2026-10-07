'use strict';
const { registerCommandNode, wordWriter } = require('./common');

module.exports = function (RED) {
    // WK - write 16-bit words from msg.payload
    registerCommandNode(RED, 'mewtocol-wk', wordWriter('WK', false));
};
