'use strict';
const { registerCommandNode, pick, meta } = require('./common');

module.exports = function (RED) {
    // WCS - write a single contact bit from msg.payload (true/false, 1/0, "on"/"off")
    registerCommandNode(RED, 'mewtocol-wcs', function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const area = pick(msg, 'area', config.area);
        const address = pick(msg, 'address', config.address);
        return client.writeBit(station, area, address, msg.payload).then(function (v) {
            meta(msg, { command: 'WCS', station: station, area: area, address: String(address), value: v });
            return undefined;
        });
    });
};
