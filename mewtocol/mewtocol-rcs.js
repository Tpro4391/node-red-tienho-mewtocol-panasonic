'use strict';
const { registerCommandNode, pick, meta } = require('./common');

module.exports = function (RED) {
    // RCS - read a single contact bit (returns 0 / 1)
    registerCommandNode(RED, 'mewtocol-rcs', function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const area = pick(msg, 'area', config.area);
        const address = pick(msg, 'address', config.address);
        return client.readBit(station, area, address).then(function (v) {
            meta(msg, { command: 'RCS', station: station, area: area, address: String(address) });
            return config.boolean ? v === 1 : v;
        });
    });
};
