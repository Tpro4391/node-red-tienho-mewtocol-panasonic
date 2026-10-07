'use strict';
const { registerCommandNode, wordReader } = require('./common');

module.exports = function (RED) {
    // RR - read 16-bit words
    registerCommandNode(RED, 'mewtocol-rr', wordReader('RR', false));
};
