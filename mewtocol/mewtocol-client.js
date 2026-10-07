'use strict';
// Node-RED MEWTOCOL connection (config) node.
// Owns ONE persistent, queued TCP connection that is shared by every node using it.
const MewtocolClient = require('../lib/client');

module.exports = function (RED) {
    function toInt(v, def) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : def;
    }

    function MewtocolClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name;
        node.host = (config.host || '').trim();
        node.port = toInt(config.port, 9094);
        node.timeout = toInt(config.timeout, 5000);
        node.framemode = config.framemode === 'extended' ? 'extended' : 'standard';
        node.bcc = config.bcc !== false;               // old flows: undefined -> true
        node.keepalive = config.keepalive !== false;   // old flows: undefined -> true
        node.users = new Set();

        node.client = new MewtocolClient({
            host: node.host,
            port: node.port,
            timeout: node.timeout,
            frameMode: node.framemode,
            bcc: node.bcc,
            keepAlive: node.keepalive,
            maxQueue: toInt(config.maxqueue, 100)
        });

        node.statusFor = function () {
            const c = node.client;
            switch (c.state) {
                case 'connected': return { fill: 'green', shape: 'dot', text: 'connected' };
                case 'connecting': return { fill: 'yellow', shape: 'ring', text: 'connecting' };
                case 'closed': return {};
                default:
                    if (!node.keepalive && !c.lastError) return { fill: 'grey', shape: 'ring', text: 'idle' };
                    return { fill: 'red', shape: 'ring', text: c.lastError ? 'disconnected: ' + (c.lastError.code || '') : 'disconnected' };
            }
        };

        node.refreshStatus = function (user) {
            const s = node.statusFor();
            if (user) user.setStatus(s);
            else node.users.forEach(u => u.setStatus(s));
        };

        node.register = function (user) {
            node.users.add(user);
            user.setStatus(node.statusFor());
            if (node.keepalive && node.users.size === 1 && node.host) {
                node.client.connect().catch(() => { /* reported through status */ });
            }
        };

        node.deregister = function (user) {
            node.users.delete(user);
        };

        node.client.on('state', function (state, err) {
            if (state === 'disconnected' && err && node.keepalive) {
                node.debug('MEWTOCOL ' + node.host + ':' + node.port + ' ' + err.message);
            }
            node.refreshStatus();
        });

        node.on('close', function (done) {
            node.users.clear();
            node.client.close().then(() => done(), () => done());
        });
    }

    RED.nodes.registerType('mewtocol-client', MewtocolClientNode);
};
