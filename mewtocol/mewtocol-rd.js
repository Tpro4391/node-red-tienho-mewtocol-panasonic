'use strict';
const { registerCommandNode, wordReader } = require('./common');

module.exports = function (RED) {
    // RD - read 16-bit words
    registerCommandNode(RED, 'mewtocol-rd', wordReader('RD', true));
};
