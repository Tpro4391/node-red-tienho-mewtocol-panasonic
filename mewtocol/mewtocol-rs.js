'use strict';
const { registerCommandNode, wordReader } = require('./common');

module.exports = function (RED) {
    // RS - read 16-bit words
    registerCommandNode(RED, 'mewtocol-rs', wordReader('RS', false));
};
