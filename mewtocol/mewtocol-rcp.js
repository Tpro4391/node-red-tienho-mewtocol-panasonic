'use strict';
const { registerCommandNode, pick, meta } = require('./common');
const { normaliseAddressList } = require('../lib/client');

module.exports = function (RED) {
    // RCP - read up to N contact bits by address list, e.g. "X0, Y1A, R100F, T5"
    // (lists longer than 8 are split into several RCP commands automatically)
    registerCommandNode(RED, 'mewtocol-rcp', function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const list = normaliseAddressList(pick(msg, 'addresses', config.addresses));
        return client.readBits(station, list).then(function (bits) {
            meta(msg, { command: 'RCP', station: station, addresses: list });
            const values = config.boolean ? bits.map(b => b === 1) : bits;
            if (config.outputformat === 'object') {
                const obj = {};
                list.forEach((a, i) => { obj[a.toUpperCase()] = values[i]; });
                return obj;
            }
            return values;
        });
    });
};
