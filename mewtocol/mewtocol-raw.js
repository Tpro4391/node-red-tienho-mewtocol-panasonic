'use strict';
const { registerCommandNode, pick, meta } = require('./common');

module.exports = function (RED) {
    // Raw command: msg.payload = command body, e.g. "RDD0000000009" -> response text after '$'
    registerCommandNode(RED, 'mewtocol-raw', function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const command = pick(msg, 'command', msg.payload);
        return client.raw(station, command).then(function (resp) {
            meta(msg, { command: 'RAW', station: station, request: String(command) });
            return resp;
        });
    });
};
