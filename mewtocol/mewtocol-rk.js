'use strict';
const { registerCommandNode, wordReader } = require('./common');

module.exports = function (RED) {
    // RK - read 16-bit words
    registerCommandNode(RED, 'mewtocol-rk', wordReader('RK', false));
};
