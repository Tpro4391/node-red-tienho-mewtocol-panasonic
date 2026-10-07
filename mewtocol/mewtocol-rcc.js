'use strict';
const { registerCommandNode, wordReader } = require('./common');

module.exports = function (RED) {
    // RCC - read 16-bit words
    registerCommandNode(RED, 'mewtocol-rcc', wordReader('RCC', true));
};
