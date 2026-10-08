'use strict';
/**
 * Panasonic Data Logger Light (DLL) support.
 *
 *  - read the logging configuration from the device (same command as Configurator DL: "<EE#3A")
 *  - decode it into plain JSON (files, registered points, data style, scale, unit)
 *  - save / load the configuration as JSON or CSV
 *  - read the current values (DT area) and build telemetry payloads (e.g. for ThingsBoard)
 *
 * DT layout (DLL manual 11.1.1): file N, registration k  ->  DT[(N-1)*1000 + (k-1)*2], 2 words per point.
 * Read limit 26 words per command, write limit 23 words.
 *
 * Setting memory layout (128 KB, reverse engineered from Configurator DL Ver.2.30, little endian):
 *   0x0000  "Configurator DL" / version string, 0x0040 device name
 *   0x0080  16 trigger records  x 0x50  (name[32] ...)
 *   0x5080  16 logging files    x 0x50  (name[32], 0x24 trigger no, 0x26 saved files, 0x27 new file timing)
 *   0x64D0  300 points          x 0x50  (see decodePoint)
 */
const { MewtocolError } = require('./protocol');

const CONFIG_SIZE = 0x20000;
const TRIGGER = { base: 0x80, size: 0x50, count: 16 };
const FILE = { base: 0x5080, size: 0x50, count: 16 };
const POINT = { base: 0x64d0, size: 0x50, count: 300 };
const READ_LIMIT = 26;
const WRITE_LIMIT = 23;

/** Index = "Date style" code in the Configurator list. */
const DATA_STYLES = [
    { name: 'DEC1W', type: 'int16', words: 1 },
    { name: 'DEC1W(Unsigned)', type: 'uint16', words: 1 },
    { name: 'HEX4 digits', type: 'hex16', words: 1 },
    { name: 'DEC2W', type: 'int32', words: 2 },
    { name: 'DEC2W(Unsigned)', type: 'uint32', words: 2 },
    { name: 'HEX8 digits', type: 'hex32', words: 2 },
    { name: 'Real number', type: 'float32', words: 2 }
];
const COM_NAMES = { 1: 'COM1(RS232C)', 2: 'COM2(RS485)' };
const DEVICE_NAMES = { 3: 'Holding Register' };

/* ------------------------------------------------------------------ helpers */

let sjis = null;
try { sjis = new TextDecoder('shift_jis'); } catch (e) { /* Node without full ICU */ }

function cstr(buf) {
    const end = buf.indexOf(0);
    const raw = end < 0 ? buf : buf.subarray(0, end);
    if (sjis) return sjis.decode(raw);
    // minimal fallback: degree sign used for "°C"
    return raw.toString('latin1').replace(/\x81\x8b/g, '°');
}

function hex8(n) { return n.toString(16).toUpperCase().padStart(8, '0'); }

/** DT address of a point. */
function dtAddress(fileNo, regNo) {
    return (fileNo - 1) * 1000 + (regNo - 1) * 2;
}

function decimalsOf(scale) {
    const s = String(scale);
    if (/e-(\d+)$/.test(s)) return +RegExp.$1;
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
}

/* ------------------------------------------------------------------ decode setting memory */

function decodePoint(r, slot, files) {
    const fileNo = r[0x22];
    const regNo = r.readUInt16LE(0x20);
    const code = r[0x2d];
    const style = DATA_STYLES[code] || { name: 'code ' + code, type: 'unknown', words: r[0x36] ? 2 : 1 };
    const dev = r[0x27];
    const addr = r.readUInt16LE(0x28);
    const file = files.find(f => f.no === fileNo);
    const scale = Math.round(r.readFloatLE(0x38) * 1e6) / 1e6;
    const devAddr = dev.toString(16).padStart(2, '0') + addr.toString(16).toUpperCase().padStart(4, '0');
    return {
        slot,
        fileNo,
        fileName: file ? file.name : '',
        regNo,
        name: cstr(r.subarray(0, 32)),
        unit: cstr(r.subarray(0x44, 0x50)),
        dataStyle: style.name,
        dataStyleCode: code,
        dataType: style.type,
        words: style.words,
        scaleOn: r[0x37] === 1,
        scale,
        com: COM_NAMES[r[0x23]] || 'COM' + r[0x23],
        unitNo: r[0x24],
        device: DEVICE_NAMES[dev] || 'device ' + dev,
        deviceAddress: devAddr,
        logging: r[0x35] === 1 ? 'Inst. value' : 'code ' + r[0x35],
        dt: dtAddress(fileNo, regNo)
    };
}

/** Decode the 128 KB setting memory into a configuration object. */
function decodeConfig(buf, extra) {
    if (!Buffer.isBuffer(buf) || buf.length < POINT.base + POINT.size * POINT.count) {
        throw new MewtocolError('DLL setting memory too short', 'EPROTO');
    }
    const triggers = [];
    for (let i = 0; i < TRIGGER.count; i++) {
        const r = buf.subarray(TRIGGER.base + i * TRIGGER.size, TRIGGER.base + (i + 1) * TRIGGER.size);
        if (r[0]) triggers.push({ no: i + 1, name: cstr(r.subarray(0, 32)) });
    }
    const files = [];
    for (let i = 0; i < FILE.count; i++) {
        const r = buf.subarray(FILE.base + i * FILE.size, FILE.base + (i + 1) * FILE.size);
        if (!r[0]) continue;
        files.push({ no: i + 1, name: cstr(r.subarray(0, 32)), trigger: r[0x24], savedFiles: r[0x26], newFileTiming: r[0x27] });
    }
    const points = [];
    for (let i = 0; i < POINT.count; i++) {
        const o = POINT.base + i * POINT.size;
        const r = buf.subarray(o, o + POINT.size);
        if (r[0] && r[0x22] >= 1 && r[0x22] <= 16) points.push(decodePoint(r, i + 1, files));
    }
    for (const f of files) f.points = points.filter(p => p.fileNo === f.no).length;
    return Object.assign({
        format: 'mewtocol-dll-config/1',
        deviceName: cstr(buf.subarray(0x40, 0x50)),
        settingVersion: (cstr(buf.subarray(0, 0x10)) + ' ' + cstr(buf.subarray(0x10, 0x20))).trim(),
        readAt: new Date().toISOString(),
        triggers, files, points
    }, extra || {});
}

/* ------------------------------------------------------------------ device access */

/**
 * Read the DLL setting memory (128 KB) with the Configurator command "<EE#3A".
 * @param {import('./client')} client
 */
async function readSettingMemory(client, station) {
    const st = station || 'EE';
    const body = '3A' + hex8(0) + hex8(CONFIG_SIZE);
    const data = await client.request(st, { body, code: '3A', header: '<' });
    const buf = Buffer.from(data.slice(0, CONFIG_SIZE * 2), 'hex');
    if (buf.length < CONFIG_SIZE) throw new MewtocolError('DLL returned ' + buf.length + ' of ' + CONFIG_SIZE + ' bytes', 'EPROTO');
    return buf;
}

async function readConfig(client, opts) {
    opts = opts || {};
    const buf = await readSettingMemory(client, opts.station);
    return decodeConfig(buf, { host: client.host, port: client.port });
}

/** Group points into contiguous DT ranges of at most `limit` words. */
function planReads(points, limit) {
    limit = limit || READ_LIMIT;
    const addrs = [...new Set(points.map(p => p.dt))].sort((a, b) => a - b);
    const ranges = [];
    for (const a of addrs) {
        const last = ranges[ranges.length - 1];
        // every point occupies 2 words; extend the range while it stays contiguous and within the limit
        if (last && a === last.end + 1 && a + 1 - last.start + 1 <= limit) last.end = a + 1;
        else ranges.push({ start: a, end: a + 1 });
    }
    return ranges;
}

/** Decode one point from its two DT words. */
function decodeValue(point, w0, w1, opts) {
    const applyScale = !opts || opts.applyScale !== false;
    const b = Buffer.alloc(4);
    b.writeUInt16LE(w0, 0);
    b.writeUInt16LE(w1, 2);
    let v;
    switch (point.dataType) {
        case 'int16': v = b.readInt16LE(0); break;
        case 'uint16': v = w0; break;
        case 'hex16': return w0.toString(16).toUpperCase().padStart(4, '0');
        case 'int32': v = b.readInt32LE(0); break;
        case 'uint32': v = b.readUInt32LE(0); break;
        case 'hex32': return b.readUInt32LE(0).toString(16).toUpperCase().padStart(8, '0');
        case 'float32': v = Number(b.readFloatLE(0).toPrecision(7)); break;
        default: v = point.words === 2 ? b.readInt32LE(0) : b.readInt16LE(0);
    }
    if (applyScale && point.scaleOn && point.scale && point.scale !== 1) {
        v = Number((v * point.scale).toFixed(Math.min(10, decimalsOf(point.scale) + (point.dataType === 'float32' ? 4 : 0))));
    }
    return v;
}

/** Read the current value of every point. Returns [{point, value}]. */
async function readValues(client, config, opts) {
    opts = opts || {};
    const station = opts.station || 'EE';
    let points = config.points;
    if (opts.files && opts.files.length) points = points.filter(p => opts.files.includes(p.fileNo));
    const words = new Map();
    for (const r of planReads(points, opts.maxReadWords || READ_LIMIT)) {
        const w = await client.readWords('RD', station, 'D', r.start, r.end);
        w.forEach((x, i) => words.set(r.start + i, x));
    }
    return points.map(p => ({ point: p, value: decodeValue(p, words.get(p.dt), words.get(p.dt + 1), opts) }));
}

/* ------------------------------------------------------------------ payload */

/** Parse "°C=temp, kPa=press" (or an object) into a map. */
function parseKeyMap(spec) {
    if (!spec) return {};
    if (typeof spec === 'object') return Object.assign({}, spec);
    const map = {};
    for (const part of String(spec).split(/[\n,;]+/)) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && v) map[k] = v;
    }
    return map;
}

/**
 * Key of a value inside a device object.
 * keySource: 'unit' (default) | 'file' (logging file name).
 * The map may use the unit, the file name or "file:<no>" as key.
 */
function valueKey(point, keyMap, keySource) {
    const candidates = keySource === 'file'
        ? [point.fileName, 'file:' + point.fileNo, point.unit]
        : [point.unit, point.fileName, 'file:' + point.fileNo];
    for (const c of candidates) if (c && keyMap[c]) return keyMap[c];
    return (keySource === 'file' ? point.fileName : point.unit) || point.fileName || 'file' + point.fileNo;
}

/**
 * Build the telemetry payload.
 * format: 'device'      { "AM-1-1": { "m3": 1, "m3/h": 2 } }                      (default)
 *         'thingsboard' { "AM-1-1": [ { "ts": 1700000000000, "values": {...} } ] }  (ThingsBoard gateway API)
 *         'flat'        { "AM-1-1.m3": 1, ... }
 *         'list'        [ { name, key, value, unit, file, dt } ]
 */
function buildPayload(values, opts) {
    opts = opts || {};
    const keyMap = parseKeyMap(opts.keyMap);
    const format = opts.format || 'device';
    const ts = opts.ts || Date.now();
    if (format === 'list') {
        return values.map(({ point, value }) => ({
            name: point.name, key: valueKey(point, keyMap, opts.keySource), value, unit: point.unit,
            file: point.fileName, fileNo: point.fileNo, regNo: point.regNo, dt: point.dt
        }));
    }
    const devices = {};
    for (const { point, value } of values) {
        const name = point.name || 'file' + point.fileNo + '-' + point.regNo;
        const dev = devices[name] || (devices[name] = {});
        let key = valueKey(point, keyMap, opts.keySource);
        if (Object.prototype.hasOwnProperty.call(dev, key)) key = key + '_' + point.fileNo; // same key twice for one device
        dev[key] = value;
    }
    if (format === 'flat') {
        const flat = {};
        for (const [d, vals] of Object.entries(devices)) for (const [k, v] of Object.entries(vals)) flat[d + (opts.separator || '.') + k] = v;
        return flat;
    }
    if (format === 'thingsboard') {
        const out = {};
        for (const [d, vals] of Object.entries(devices)) out[d] = [{ ts, values: vals }];
        return out;
    }
    return devices;
}

/* ------------------------------------------------------------------ JSON / CSV persistence */

const CSV_COLUMNS = ['fileNo', 'fileName', 'regNo', 'name', 'unit', 'dataStyle', 'dataStyleCode', 'dataType', 'words',
    'scaleOn', 'scale', 'dt', 'com', 'unitNo', 'device', 'deviceAddress', 'logging', 'slot'];

function configToCsv(config) {
    const q = (v) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const p of config.points) lines.push(CSV_COLUMNS.map(c => q(p[c])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',' || c === ';') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
}

/** Build a configuration from CSV (columns as written by configToCsv; extra columns are ignored). */
function csvToConfig(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new MewtocolError('Empty CSV', 'EPARAM');
    const head = rows[0].map(h => h.trim());
    const col = (n) => head.indexOf(n);
    for (const need of ['fileNo', 'regNo', 'name']) if (col(need) < 0) throw new MewtocolError('CSV column "' + need + '" missing', 'EPARAM');
    const points = rows.slice(1).map((r) => {
        const get = (n) => (col(n) >= 0 ? (r[col(n)] || '').trim() : '');
        const fileNo = +get('fileNo'), regNo = +get('regNo');
        let code = get('dataStyleCode') === '' ? NaN : +get('dataStyleCode');
        if (Number.isNaN(code)) code = DATA_STYLES.findIndex(s => s.name === get('dataStyle') || s.type === get('dataType'));
        const style = DATA_STYLES[code] || DATA_STYLES[0];
        const scaleOn = /^(1|true|yes)$/i.test(get('scaleOn'));
        return {
            slot: +get('slot') || undefined, fileNo, fileName: get('fileName'), regNo, name: get('name'), unit: get('unit'),
            dataStyle: style.name, dataStyleCode: code < 0 ? 0 : code, dataType: style.type, words: style.words,
            scaleOn, scale: get('scale') === '' ? 1 : +get('scale'),
            com: get('com'), unitNo: +get('unitNo') || undefined, device: get('device'), deviceAddress: get('deviceAddress'),
            logging: get('logging'), dt: dtAddress(fileNo, regNo)
        };
    }).filter(p => p.fileNo >= 1 && p.fileNo <= 16 && p.regNo >= 1 && p.regNo <= 300);
    const files = [];
    for (const p of points) if (!files.find(f => f.no === p.fileNo)) files.push({ no: p.fileNo, name: p.fileName, points: 0 });
    for (const f of files) f.points = points.filter(p => p.fileNo === f.no).length;
    return { format: 'mewtocol-dll-config/1', source: 'csv', readAt: new Date().toISOString(), triggers: [], files, points };
}

/** Parse a configuration from JSON text / object or CSV text. */
function parseConfig(input) {
    if (input && typeof input === 'object' && Array.isArray(input.points)) return normalise(input);
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
    const t = text.replace(/^﻿/, '').trim();
    if (t.startsWith('{')) return normalise(JSON.parse(t));
    return csvToConfig(text);
}

function normalise(cfg) {
    for (const p of cfg.points) {
        if (p.dt === undefined) p.dt = dtAddress(p.fileNo, p.regNo);
        if (!p.dataType) {
            const s = DATA_STYLES[p.dataStyleCode] || DATA_STYLES[0];
            p.dataType = s.type; p.words = s.words;
        }
    }
    return cfg;
}

/* ------------------------------------------------------------------ test fixture support */

/** Build a 128 KB setting memory image (used by tests and simulators). */
function encodeConfig(cfg) {
    const buf = Buffer.alloc(CONFIG_SIZE);
    buf.write('Configurator DL', 0, 'latin1');
    buf.write('Ver.2.30.0000', 0x10, 'latin1');
    buf.write(cfg.deviceName || 'DLL-TEST', 0x40, 'latin1');
    (cfg.triggers || []).forEach(t => buf.write(t.name, TRIGGER.base + (t.no - 1) * TRIGGER.size, 'latin1'));
    for (const f of cfg.files || []) {
        const o = FILE.base + (f.no - 1) * FILE.size;
        buf.write(f.name, o, 'latin1');
        buf[o + 0x24] = f.trigger || 1; buf[o + 0x26] = f.savedFiles || 100; buf[o + 0x27] = f.newFileTiming || 1;
    }
    cfg.points.forEach((p, i) => {
        const o = POINT.base + ((p.slot || i + 1) - 1) * POINT.size;
        Buffer.from(p.name, 'latin1').copy(buf, o, 0, 31);
        buf.writeUInt16LE(p.regNo, o + 0x20);
        buf[o + 0x22] = p.fileNo; buf[o + 0x23] = 2; buf[o + 0x24] = p.unitNo || 1; buf[o + 0x27] = 3;
        buf.writeUInt16LE(p.address || 0x200, o + 0x28);
        buf[o + 0x2d] = p.dataStyleCode; buf[o + 0x35] = 1;
        buf[o + 0x36] = (DATA_STYLES[p.dataStyleCode] || DATA_STYLES[0]).words === 2 ? 1 : 0;
        buf[o + 0x37] = p.scaleOn ? 1 : 0;
        buf.writeFloatLE(p.scale === undefined ? 1 : p.scale, o + 0x38);
        Buffer.from((p.unit || '').replace('°', '\x81\x8b'), 'latin1').copy(buf, o + 0x44, 0, 11);
    });
    return buf;
}

module.exports = {
    CONFIG_SIZE, READ_LIMIT, WRITE_LIMIT, DATA_STYLES,
    dtAddress, decodeConfig, readSettingMemory, readConfig, planReads, decodeValue, readValues,
    parseKeyMap, valueKey, buildPayload, configToCsv, csvToConfig, parseConfig, encodeConfig
};
