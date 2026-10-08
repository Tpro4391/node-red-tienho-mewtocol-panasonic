'use strict';
// Panasonic Data Logger Light (DLL): load the logging configuration once, then read
// the current values of all registered points and output telemetry JSON.
const fs = require('fs');
const path = require('path');
const MewtocolClient = require('../lib/client');
const DLL = require('../lib/dll');

module.exports = function (RED) {
    function toInt(v, def) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : def;
    }

    function MewtocolDllNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.host = String(config.host || '').trim();
        node.port = toInt(config.port, 9094);
        node.station = String(config.station || 'EE').trim() || 'EE';
        node.source = config.configsource || 'auto'; // auto | dll | file
        node.format = config.format || 'device';
        node.keysource = config.keysource || 'unit';
        node.keymap = config.keymap || '';
        node.applyScale = config.applyscale !== false;
        node.readStatus = config.readstatus !== false;
        node.onDisconnect = config.ondisconnect || 'null'; // null | keep | omit
        node.files = String(config.files || '').split(/[\s,;]+/).map(Number).filter(n => n >= 1 && n <= 16);
        node.cfg = null;
        node.loading = null;

        const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
        const defaultFile = path.join(userDir, 'mewtocol-dll', (node.host || 'dll').replace(/[^\w.-]/g, '_') + '.json');
        node.configFile = String(config.configfile || '').trim() || defaultFile;

        node.client = new MewtocolClient({
            host: node.host,
            port: node.port,
            timeout: toInt(config.timeout, 5000),
            frameMode: 'standard',
            keepAlive: config.keepalive !== false,
            maxReadWords: DLL.READ_LIMIT,
            maxWriteWords: DLL.WRITE_LIMIT
        });

        let statusKey = '';
        function status(fill, shape, text) {
            const k = fill + shape + text;
            if (k === statusKey) return;
            statusKey = k;
            node.status(fill ? { fill, shape, text } : {});
        }
        function summary() {
            return node.cfg ? node.cfg.points.length + ' points, ' + node.cfg.files.length + ' files' : 'no config';
        }

        function saveConfig(cfg) {
            try {
                fs.mkdirSync(path.dirname(node.configFile), { recursive: true });
                if (/\.csv$/i.test(node.configFile)) {
                    fs.writeFileSync(node.configFile, DLL.configToCsv(cfg));
                } else {
                    fs.writeFileSync(node.configFile, JSON.stringify(cfg, null, 2));
                    fs.writeFileSync(node.configFile.replace(/\.json$/i, '') + '.csv', DLL.configToCsv(cfg));
                }
            } catch (e) {
                node.warn('Cannot save DLL configuration to ' + node.configFile + ': ' + e.message);
            }
        }

        function loadFile() {
            const cfg = DLL.parseConfig(fs.readFileSync(node.configFile));
            cfg.loadedFrom = node.configFile;
            return cfg;
        }

        async function loadFromDll() {
            status('yellow', 'ring', 'reading DLL configuration');
            const cfg = await DLL.readConfig(node.client, { station: node.station });
            saveConfig(cfg);
            return cfg;
        }

        /** Load the configuration according to the selected source. force = always read the DLL. */
        function loadConfig(force) {
            if (node.loading) return node.loading;
            const job = (async () => {
                if (!force && node.source !== 'dll' && fs.existsSync(node.configFile)) {
                    node.cfg = loadFile();
                } else if (!force && node.source === 'file') {
                    throw new Error('Configuration file not found: ' + node.configFile);
                } else {
                    try {
                        node.cfg = await loadFromDll();
                    } catch (e) {
                        if (!force && fs.existsSync(node.configFile)) {
                            node.warn('DLL configuration read failed (' + e.message + '), using ' + node.configFile);
                            node.cfg = loadFile();
                        } else throw e;
                    }
                }
                status('green', 'dot', summary());
                return node.cfg;
            })();
            // clear the marker only after it was set (the job may finish synchronously when reading a file)
            node.loading = job.finally(() => { node.loading = null; });
            return node.loading;
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

        if (!node.host && node.source !== 'file') {
            status('red', 'ring', 'no IP address');
        } else {
            loadConfig(false).catch((e) => {
                status('red', 'ring', 'config: ' + (e.code || e.message).toString().slice(0, 26));
                node.warn('DLL configuration not loaded: ' + e.message);
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
                if (msg.config && (typeof msg.config === 'object' || typeof msg.config === 'string')) {
                    node.cfg = DLL.parseConfig(msg.config);
                    status('green', 'dot', summary());
                }
                if (topic === 'reload' || msg.reload === true) {
                    await loadConfig(true);
                    return emitConfig();
                }
                if (topic === 'config') {
                    if (!node.cfg) await loadConfig(false);
                    return emitConfig();
                }
                if (!node.cfg) await loadConfig(false);
                const cfg = node.cfg;
                const files = Array.isArray(msg.files) ? msg.files.map(Number) : node.files;
                const ts = Date.now();
                const values = await DLL.readValues(node.client, cfg, {
                    station: node.station, files, status: node.readStatus, onDisconnect: node.onDisconnect, applyScale: msg.applyScale !== undefined ? msg.applyScale !== false : node.applyScale
                });
                msg.payload = DLL.buildPayload(values, {
                    format: msg.format || node.format,
                    keyMap: msg.keyMap || node.keymap,
                    keySource: node.keysource,
                    onDisconnect: node.onDisconnect,
                    ts
                });
                msg.dll = { device: cfg.deviceName, host: node.host, ts, points: values.length, disconnected: values.filter(v => v.connect === false).length };
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
                msg.csv = DLL.configToCsv(node.cfg);
                msg.filename = node.configFile;
                send([null, msg, null]);
                done();
            }
        });

        node.on('close', function (removed, done) {
            node.client.close().then(() => done(), () => done());
        });
    }

    RED.nodes.registerType('mewtocol-dll', MewtocolDllNode);

    // editor helper: read the configuration of a DLL from the edit dialog
    RED.httpAdmin.get('/mewtocol-dll/config', RED.auth.needsPermission('mewtocol-dll.read'), async function (req, res) {
        const host = String(req.query.host || '').trim();
        if (!/^[A-Za-z0-9.\-:_]+$/.test(host)) return res.status(400).json({ error: 'invalid host' });
        const client = new MewtocolClient({ host, port: toInt(req.query.port, 9094), timeout: 8000, keepAlive: false });
        try {
            const cfg = await DLL.readConfig(client, { station: req.query.station || 'EE' });
            res.json({ deviceName: cfg.deviceName, files: cfg.files, units: [...new Set(cfg.points.map(p => p.unit).filter(Boolean))], points: cfg.points.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            client.close();
        }
    });
};
