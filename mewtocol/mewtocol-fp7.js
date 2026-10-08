'use strict';
// Panasonic FP7 dynamic Modbus program (FP7 Modbus Configurator): read the tag list
// (device name + unit key) from the PLC, then poll values + status and output telemetry JSON.
const fs = require('fs');
const path = require('path');
const MewtocolClient = require('../lib/client');
const FP7 = require('../lib/fp7');
const { parseKeyMap } = require('../lib/dll');

module.exports = function (RED) {
    function toInt(v, def) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : def;
    }

    function mapFromConfig(config) {
        const m = {};
        for (const k of Object.keys(FP7.DEFAULT_MAP)) {
            const v = config['map_' + k];
            if (v !== undefined && v !== '') m[k] = v;
        }
        return m;
    }

    function loadCatalog(file, node) {
        if (!file) return new FP7.KeyCatalog();
        try {
            return FP7.KeyCatalog.fromFile(file);
        } catch (e) {
            if (node) node.warn('Key catalogue ' + file + ' not loaded (' + e.message + '), using built-in keys');
            return new FP7.KeyCatalog();
        }
    }

    function MewtocolFp7Node(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.host = String(config.host || '').trim();
        node.port = toInt(config.port, 9094);
        node.station = String(config.station || 'EE').trim() || 'EE';
        node.format = config.format || 'device';
        node.keymap = config.keymap || '';
        node.decimals = config.decimals === undefined || config.decimals === '' ? 'auto' : config.decimals;
        node.onDisconnect = config.ondisconnect || 'null';
        node.readStatus = config.readstatus !== false;
        node.refresh = parseInt(config.refresh, 10) >= 0 ? parseInt(config.refresh, 10) : 600; // s, 0 = never
        node.map = mapFromConfig(config);
        node.catalogFile = String(config.keysfile || '').trim();
        node.catalog = loadCatalog(node.catalogFile, node);
        node.cfg = null;
        node.loading = null;

        const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
        node.cacheFile = path.join(userDir, 'mewtocol-fp7', (node.host || 'fp7').replace(/[^\w.-]/g, '_') + '_' + node.port + '.json');

        node.client = new MewtocolClient({
            host: node.host,
            port: node.port,
            timeout: toInt(config.timeout, 5000),
            frameMode: config.framemode === 'extended' ? 'extended' : 'standard',
            keepAlive: config.keepalive !== false
        });

        let statusKey = '';
        function status(fill, shape, text) {
            const k = fill + shape + text;
            if (k === statusKey) return;
            statusKey = k;
            node.status(fill ? { fill, shape, text } : {});
        }
        function summary() {
            if (!node.cfg) return 'no config';
            const devices = new Set(node.cfg.tags.map(t => t.device)).size;
            return node.cfg.tags.length + ' tags, ' + devices + ' devices';
        }

        function saveCache(cfg) {
            try {
                fs.mkdirSync(path.dirname(node.cacheFile), { recursive: true });
                fs.writeFileSync(node.cacheFile, JSON.stringify(cfg, null, 2));
                fs.writeFileSync(node.cacheFile.replace(/\.json$/, '.csv'), FP7.configToCsv(cfg));
            } catch (e) {
                node.warn('Cannot save tag list to ' + node.cacheFile + ': ' + e.message);
            }
        }

        function loadConfig(force) {
            if (node.loading) return node.loading;
            const job = (async () => {
                status('yellow', 'ring', 'reading tag list');
                let cfg;
                try {
                    cfg = await FP7.readConfig(node.client, { station: node.station, map: node.map, details: true });
                    saveCache(cfg);
                } catch (e) {
                    // PLC unreachable at start-up: fall back to the last tag list read
                    if (!force && !node.cfg && fs.existsSync(node.cacheFile)) {
                        node.warn('Tag list read failed (' + e.message + '), using ' + node.cacheFile);
                        cfg = JSON.parse(fs.readFileSync(node.cacheFile, 'utf8'));
                        cfg.ts = 0; // re-read as soon as the PLC answers
                    } else throw e;
                }
                FP7.resolveKeys(cfg, node.catalog, parseKeyMap(node.keymap));
                node.cfg = cfg;
                status('green', 'dot', summary());
                return cfg;
            })();
            node.loading = job.finally(() => { node.loading = null; });
            return node.loading;
        }

        function stale() {
            if (!node.cfg) return true;
            if (!node.cfg.ts) return true;
            return node.refresh > 0 && Date.now() - node.cfg.ts > node.refresh * 1000;
        }

        function errorOut(msg, err, send, done) {
            const e = RED.util.cloneMessage(msg || {});
            e.error = err.message || String(err);
            e.errorCode = err.code;
            if (err.plcCode !== undefined) e.plcErrorCode = err.plcCode;
            send([null, null, e]);
            status('red', 'dot', String(e.error).slice(0, 32));
            done(err);
        }

        if (!node.host) {
            status('red', 'ring', 'no IP address');
        } else {
            loadConfig(false).catch((e) => {
                status('red', 'ring', 'tags: ' + (e.code || e.message).toString().slice(0, 26));
                node.warn('FP7 tag list not loaded: ' + e.message);
            });
        }

        node.on('input', async function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };
            const topic = String(msg.topic || '').toLowerCase();
            const isPoll = !(topic === 'reload' || topic === 'config' || msg.reload === true);
            // a poll is still running (slow PLC / poll interval shorter than the read time):
            // drop this one instead of queueing it, so data never lags behind and memory stays flat
            if (isPoll && node.polling) {
                node.skipped = (node.skipped || 0) + 1;
                status('yellow', 'ring', 'busy: ' + node.skipped + ' poll(s) skipped');
                return done();
            }
            if (isPoll) node.polling = true;
            try {
                if (topic === 'reload' || msg.reload === true) {
                    await loadConfig(true);
                    return emitConfig();
                }
                if (stale()) {
                    try {
                        await loadConfig(false);
                    } catch (e) {
                        if (!node.cfg) throw e;
                        node.warn('Tag list refresh failed, keeping the previous list: ' + e.message);
                    }
                }
                if (topic === 'config') return emitConfig();
                const cfg = node.cfg;
                if (msg.keyMap) FP7.resolveKeys(cfg, node.catalog, parseKeyMap(msg.keyMap));
                const ts = Date.now();
                const values = await FP7.readValues(node.client, cfg, {
                    station: node.station,
                    status: node.readStatus,
                    onDisconnect: node.onDisconnect,
                    decimals: msg.decimals !== undefined ? msg.decimals : node.decimals
                });
                if (msg.keyMap) FP7.resolveKeys(cfg, node.catalog, parseKeyMap(node.keymap));
                const format = msg.format || node.format;
                msg.payload = FP7.buildPayload(values, { format, onDisconnect: node.onDisconnect, ts, connectKey: node.readStatus ? 'connect' : null });
                msg.fp7 = {
                    host: node.host, port: node.port, ts, tags: values.length,
                    devices: new Set(cfg.tags.map(t => t.device)).size,
                    disconnected: values.filter(v => v.connect === false).length,
                    configTs: cfg.ts,
                    skipped: node.skipped || 0
                };
                status('green', 'dot', summary() + ' @ ' + new Date(ts).toLocaleTimeString());
                send([msg, null, null]);
                done();
            } catch (err) {
                errorOut(msg, err, send, done);
            } finally {
                if (isPoll) node.polling = false;
            }

            function emitConfig() {
                msg.payload = node.cfg;
                msg.csv = FP7.configToCsv(node.cfg);
                msg.filename = node.cacheFile;
                send([null, msg, null]);
                done();
            }
        });

        node.on('close', function (removed, done) {
            node.client.close().then(() => done(), () => done());
        });
    }

    RED.nodes.registerType('mewtocol-fp7', MewtocolFp7Node);

    // editor helper: read the tag list from the edit dialog
    RED.httpAdmin.get('/mewtocol-fp7/tags', RED.auth.needsPermission('mewtocol-fp7.read'), async function (req, res) {
        const host = String(req.query.host || '').trim();
        if (!/^[A-Za-z0-9.\-:_]+$/.test(host)) return res.status(400).json({ error: 'invalid host' });
        const client = new MewtocolClient({
            host, port: toInt(req.query.port, 9094), timeout: 8000, keepAlive: false,
            frameMode: req.query.framemode === 'extended' ? 'extended' : 'standard'
        });
        try {
            const map = {};
            for (const k of Object.keys(FP7.DEFAULT_MAP)) if (req.query['map_' + k]) map[k] = req.query['map_' + k];
            const cfg = await FP7.readConfig(client, { station: req.query.station || 'EE', map });
            FP7.resolveKeys(cfg, loadCatalog(String(req.query.keysfile || '').trim()), {});
            const devices = [...new Set(cfg.tags.map(t => t.device))];
            const keys = [...new Set(cfg.tags.map(t => t.keyName))];
            res.json({ tags: cfg.tags.length, devices, keys });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            client.close();
        }
    });
};
