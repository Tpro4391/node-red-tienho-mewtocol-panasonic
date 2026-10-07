'use strict';
const { registerCommandNode, pick, meta } = require('./common');

module.exports = function (RED) {
    // RT - read PLC status
    registerCommandNode(RED, 'mewtocol-rt', function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        return client.readStatus(station).then(function (status) {
            meta(msg, { command: 'RT', station: station });
            return status;
        });
    });
};
