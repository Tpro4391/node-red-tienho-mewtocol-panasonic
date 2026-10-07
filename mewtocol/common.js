'use strict';
/**
 * Shared runtime helpers for all MEWTOCOL command nodes.
 */
const P = require('../lib/protocol');

/** msg value wins over node config, but only when it is actually set (0 and false are valid values). */
function pick(msg, key, fallback) {
    const v = msg[key];
    return v === undefined || v === null || v === '' ? fallback : v;
}

function shortText(text, max) {
    text = String(text || '');
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Register a command node type.
 * @param RED
 * @param {string} type  node type name
 * @param {(client, msg, config, node) => Promise<*>} execute  returns the new msg.payload
 *        (return `undefined` to keep the incoming payload, e.g. for write nodes)
 */
function registerCommandNode(RED, type, execute) {
    function MewtocolCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.config = config;
        node.server = RED.nodes.getNode(config.server);
        node._statusKey = '';

        node.setStatus = function (status) {
            const key = JSON.stringify(status || {});
            if (key === node._statusKey) return; // avoid flooding the editor with identical updates
            node._statusKey = key;
            node.status(status || {});
        };

        if (node.server && typeof node.server.register === 'function') {
            node.server.register(node);
        } else {
            node.setStatus({ fill: 'red', shape: 'ring', text: 'no connection configured' });
        }

        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            if (!node.server || !node.server.client) {
                const err = new P.MewtocolError('No MEWTOCOL connection configured', 'ECONFIG');
                return fail(err);
            }
            let result;
            try {
                result = execute(node.server.client, msg, config, node);
            } catch (err) {
                return fail(err);
            }
            Promise.resolve(result).then(function (payload) {
                if (payload !== undefined) msg.payload = payload;
                node.server.refreshStatus(node);
                send([msg, null]);
                done();
            }, fail);

            function fail(err) {
                const text = (err && err.message) || String(err);
                const errMsg = RED.util.cloneMessage(msg);
                errMsg.error = text;
                errMsg.errorCode = err && err.code;
                if (err && err.plcCode !== undefined) errMsg.plcErrorCode = err.plcCode;
                if (config.sendonerror) {
                    msg.payload = '';
                    send([msg, errMsg]);
                } else {
                    send([null, errMsg]);
                }
                node.setStatus({ fill: 'red', shape: 'dot', text: shortText(text, 32) });
                done(err instanceof Error ? err : new Error(text));
            }
        });

        node.on('close', function (removed, done) {
            if (node.server && typeof node.server.deregister === 'function') node.server.deregister(node);
            node.setStatus({});
            done();
        });
    }
    RED.nodes.registerType(type, MewtocolCommandNode);
}

/** Attach a small description of the executed command to the message. */
function meta(msg, info) {
    msg.mewtocol = info;
}

/**
 * Factory for word read nodes (RD, RCC, RS, RK, RR).
 */
function wordReader(kind, hasArea) {
    return function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const area = hasArea ? pick(msg, 'area', config.area) : null;
        const start = pick(msg, 'startaddress', config.startaddress);
        const end = pick(msg, 'endaddress', config.endaddress);
        const datatype = pick(msg, 'datatype', config.datatype || 'int16');
        if (!P.DATA_TYPES.includes(datatype)) throw new P.MewtocolError('Unknown data type "' + datatype + '"', 'EPARAM');
        return client.readWords(kind, station, area, start, end).then(function (words) {
            const values = P.wordsToValues(words, datatype);
            meta(msg, { command: kind, station: station, area: area || undefined, start: Number(start), end: Number(end), datatype: datatype });
            if (Array.isArray(values) && values.length === 1 && !config.alwaysarray && datatype !== 'bits') return values[0];
            return values;
        });
    };
}

/**
 * Factory for word write nodes (WD, WCC, WS, WK).
 */
function wordWriter(kind, hasArea) {
    return function (client, msg, config) {
        const station = pick(msg, 'station', config.station);
        const area = hasArea ? pick(msg, 'area', config.area) : null;
        const start = pick(msg, 'startaddress', config.startaddress);
        const datatype = pick(msg, 'datatype', config.datatype || 'int16');
        const words = P.valuesToWords(msg.payload, datatype);
        return client.writeWords(kind, station, area, start, words).then(function (r) {
            meta(msg, { command: kind, station: station, area: area || undefined, start: r.start, end: r.end, count: r.count, datatype: datatype });
            return undefined; // keep payload
        });
    };
}

module.exports = { pick, registerCommandNode, wordReader, wordWriter, meta, shortText };
