'use strict';
/**
 * Panasonic FP7 "dynamic Modbus master" program (FP7 Modbus Configurator):
 * the PLC polls Modbus RTU devices according to configuration arrays in DT and stores
 * the results as REAL. This module reads those arrays over MEWTOCOL-COM (RD D...).
 *
 * Memory map (map v2, all arrays [0..999]):
 *   actives  DT1000   INT     0 = disabled, 1 = active
 *   ports    DT2000   UINT    1 = COM1, 2 = COM2
 *   idModbus DT3000   UINT    Modbus slave id
 *   addrs    DT4000   UINT    register address
 *   types    DT5000   UINT    1=Int16 2=UInt16 3=Int32 4=UInt32 5=Float
 *   divides  DT6000   UINT
 *   swaps    DT7000   UINT
 *   values   DT8000   REAL    2 words per tag (low word first)
 *   keys     DT10000  INT     measurement / unit key, -1 = not assigned (see fp7-keys.js)
 *   status   DT11000  INT     1 = OK, 0 = device does not answer, -1 = not read yet
 *   names    DT12000  STRING[32]  18 words per tag: [max length][length][16 words of characters]
 */
const fs = require('fs');
const P = require('./protocol');
const DEFAULT_KEYS = require('./fp7-keys');
const { MewtocolError } = P;

const DEFAULT_MAP = {
    tagCount: 1000,
    actives: 1000, ports: 2000, idModbus: 3000, addrs: 4000, types: 5000, divides: 6000, swaps: 7000,
    values: 8000, keys: 10000, status: 11000, names: 12000,
    nameStride: 18, nameHeader: 2, nameMax: 32
};
const TYPE_NAMES = { 1: 'Int16', 2: 'UInt16', 3: 'Int32', 4: 'UInt32', 5: 'Float' };
const MAX_DT = 99999; // MEWTOCOL-COM RD address field (5 digits)

/* ------------------------------------------------------------------ key catalogue */

class KeyCatalog {
    constructor(rows) {
        this.byCode = new Map();
        for (const r of rows || DEFAULT_KEYS) {
            const k = Array.isArray(r)
                ? { code: +r[0], key: String(r[1]), unit: r[2] || '', quantity: r[3] || '', group: r[4] || '', kind: r[5] || 'I', decimals: r[6] === '' || r[6] === undefined ? null : +r[6] }
                : r;
            if (Number.isFinite(k.code) && k.key) this.byCode.set(k.code, k);
        }
    }
    get(code) { return this.byCode.get(code) || null; }
    get size() { return this.byCode.size; }

    /** Load unit_keys.csv of FP7 Modbus Configurator (Code,Key,Unit,Quantity,Group,Kind,Decimals). */
    static fromCsv(text) {
        text = String(text).replace(/^﻿/, '');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const sep = (lines[0] || '').includes(';') && !(lines[0] || '').includes(',') ? ';' : ',';
        const rows = [];
        for (const line of lines.slice(1)) {
            const c = splitCsvLine(line, sep);
            const code = parseInt(c[0], 10);
            if (!Number.isFinite(code) || code <= 0 || !c[1]) continue;
            rows.push([code, c[1].trim(), (c[2] || '').trim(), (c[3] || '').trim(), (c[4] || '').trim(), (c[5] || 'I').trim(), c[6]]);
        }
        if (!rows.length) throw new MewtocolError('No keys found in catalogue CSV', 'EPARAM');
        return new KeyCatalog(rows);
    }

    static fromFile(file) { return KeyCatalog.fromCsv(fs.readFileSync(file, 'utf8')); }
}

function splitCsvLine(line, sep) {
    const out = [];
    let cell = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { out.push(cell); cell = ''; } else cell += ch;
    }
    out.push(cell);
    return out;
}

/* ------------------------------------------------------------------ helpers */

function toInt16(w) { return w & 0x8000 ? w - 0x10000 : w; }

function decodeName(words, map) {
    const header = map.nameHeader;
    let len = header >= 2 ? words[1] : header === 1 ? words[0] : map.nameMax;
    const bytes = [];
    for (const w of words.slice(header)) bytes.push(w & 0xFF, (w >> 8) & 0xFF);
    len = Math.max(0, Math.min(len, map.nameMax, bytes.length));
    let s = Buffer.from(bytes.slice(0, len)).toString('latin1');
    const z = s.indexOf('\0');
    if (z >= 0) s = s.slice(0, z);
    return s.trim();
}

/** Group sorted tag indices into read ranges; gaps of up to `maxGap` tags are read through. */
function planRanges(indices, maxGap) {
    const list = [...new Set(indices)].sort((a, b) => a - b);
    const out = [];
    for (const i of list) {
        const last = out[out.length - 1];
        if (last && i - last[1] - 1 <= maxGap) last[1] = i;
        else out.push([i, i]);
    }
    return out;
}

/** Read `count` words per tag for the given tag ranges. Returns Map(index -> words[]). */
async function readPerTag(client, station, base, perTag, ranges) {
    const out = new Map();
    for (const [a, b] of ranges) {
        const start = base + a * perTag;
        const end = base + (b + 1) * perTag - 1;
        if (end > MAX_DT) throw new MewtocolError('Address DT' + end + ' exceeds DT' + MAX_DT, 'EPARAM');
        const words = await client.readWords('RD', station, 'D', start, end);
        for (let i = a; i <= b; i++) out.set(i, words.slice((i - a) * perTag, (i - a + 1) * perTag));
    }
    return out;
}

function mergeMap(map) {
    const m = Object.assign({}, DEFAULT_MAP);
    for (const k of Object.keys(map || {})) {
        const v = parseInt(map[k], 10);
        if (Number.isFinite(v) && v >= 0) m[k] = v;
    }
    return m;
}

/* ------------------------------------------------------------------ configuration */

/**
 * Read the tag configuration: active flags, then key + name (+ optional Modbus details) of the active tags.
 * @returns {Promise<{ts:number, tags:Array}>}
 */
async function readConfig(client, opts) {
    opts = opts || {};
    const station = opts.station || 'EE';
    const map = mergeMap(opts.map);
    const n = map.tagCount;
    const actives = (await client.readWords('RD', station, 'D', map.actives, map.actives + n - 1)).map(toInt16);
    const idx = [];
    actives.forEach((a, i) => { if (a === 1 || opts.includeInactive) idx.push(i); });
    const tags = [];
    if (idx.length) {
        // 1-word arrays: read through long gaps (cheap); names are 18 words per tag: only small gaps
        const wide = planRanges(idx, opts.maxGap === undefined ? 100 : opts.maxGap);
        const narrow = planRanges(idx, opts.maxGap === undefined ? 4 : opts.maxGap);
        const keys = await readPerTag(client, station, map.keys, 1, wide);
        const names = opts.names === false ? new Map() : await readPerTag(client, station, map.names, map.nameStride, narrow);
        let details = null;
        if (opts.details) {
            details = {};
            for (const a of ['ports', 'idModbus', 'addrs', 'types', 'divides', 'swaps']) details[a] = await readPerTag(client, station, map[a], 1, wide);
        }
        for (const i of idx) {
            const t = {
                index: i,
                active: actives[i] === 1,
                name: names.has(i) ? decodeName(names.get(i), map) : '',
                key: toInt16(keys.get(i)[0])
            };
            if (details) {
                t.port = details.ports.get(i)[0];
                t.slaveId = details.idModbus.get(i)[0];
                t.address = details.addrs.get(i)[0];
                t.type = TYPE_NAMES[details.types.get(i)[0]] || details.types.get(i)[0];
                t.divide = details.divides.get(i)[0];
                t.swap = details.swaps.get(i)[0];
            }
            tags.push(t);
        }
    }
    return { ts: Date.now(), map, tags };
}

/**
 * Attach output keys to the tags: catalogue key name (kWh, I1, A_Nm3 ...) renamed through the key map.
 * keyMap entries may use the key code ("150=m3Air"), the key name ("A_Nm3=m3Air"), "index:5=x" or "Device.key=x".
 */
function resolveKeys(config, catalog, keyMap) {
    catalog = catalog || new KeyCatalog();
    keyMap = keyMap || {};
    for (const t of config.tags) {
        const k = t.key > 0 ? catalog.get(t.key) : null;
        t.keyName = k ? k.key : (t.key > 0 ? 'key' + t.key : 'tag' + t.index);
        t.unit = k ? k.unit : '';
        t.quantity = k ? k.quantity : '';
        t.decimals = k && k.decimals !== null ? k.decimals : null;
        const device = t.name || 'tag' + t.index;
        const candidates = [device + '.' + t.keyName, 'index:' + t.index, String(t.key), t.keyName];
        let out = null;
        for (const c of candidates) if (Object.prototype.hasOwnProperty.call(keyMap, c)) { out = keyMap[c]; break; }
        t.outKey = out || t.keyName;
        t.device = device;
    }
    return config;
}

/* ------------------------------------------------------------------ values */

/** Round a REAL read from the PLC: 'auto' = float32 precision (7 significant digits), or N decimals. */
function roundValue(v, decimals) {
    if (v === null || !Number.isFinite(v)) return v === null ? null : v;
    if (decimals === 'auto' || decimals === undefined || decimals === null || decimals === '') return Number(v.toPrecision(7));
    const d = Math.max(0, Math.min(10, parseInt(decimals, 10)));
    return Number(v.toFixed(d));
}

/**
 * Read values + status of the configured tags.
 * @returns {Promise<Array<{tag, value, status, connect}>>}
 */
async function readValues(client, config, opts) {
    opts = opts || {};
    const station = opts.station || 'EE';
    const map = config.map || mergeMap(opts.map);
    const tags = config.tags;
    if (!tags.length) return [];
    const ranges = planRanges(tags.map(t => t.index), opts.maxGap === undefined ? 32 : opts.maxGap);
    const vals = await readPerTag(client, station, map.values, 2, ranges);
    const stat = opts.status === false ? null : await readPerTag(client, station, map.status, 1, ranges);
    const onDisconnect = opts.onDisconnect || 'null';
    return tags.map((t) => {
        const w = vals.get(t.index);
        let value = P.wordsToValues([w[0], w[1]], 'float32')[0];
        const status = stat ? toInt16(stat.get(t.index)[0]) : null;
        const connect = status === 1 ? true : status === 0 ? false : null;
        if (connect !== true && stat && onDisconnect === 'null') value = null; // 0 = offline, -1 = not read yet
        else value = roundValue(value, opts.decimals === 'catalog' ? (t.decimals === null ? 'auto' : t.decimals) : opts.decimals);
        return { tag: t, value, status, connect };
    });
}

/**
 * Build the telemetry payload (same formats as the DLL node):
 *   device       { "AM-1-1": { "m3Air": 144370.4, "flowAir": 446.89, "connect": true } }
 *   thingsboard  { "AM-1-1": [ { "ts": 1700000000000, "values": {...} } ] }
 *   flat         { "AM-1-1.m3Air": 144370.4 }
 *   list         [ { device, key, value, connect, index, keyCode, keyName, unit } ]
 */
function buildPayload(values, opts) {
    opts = opts || {};
    const format = opts.format || 'device';
    const ts = opts.ts || Date.now();
    const connectKey = opts.connectKey === undefined ? 'connect' : opts.connectKey;
    if (format === 'list') {
        return values.map(({ tag, value, connect, status }) => ({
            device: tag.device, key: tag.outKey, value, connect, status, index: tag.index,
            keyCode: tag.key, keyName: tag.keyName, unit: tag.unit, quantity: tag.quantity
        }));
    }
    const devices = {};
    const online = {};
    for (const { tag, value, connect } of values) {
        const dev = devices[tag.device] || (devices[tag.device] = {});
        if (connect === false && opts.onDisconnect === 'omit') {
            online[tag.device] = false;
            continue;
        }
        if (connect !== null && connect !== undefined) online[tag.device] = online[tag.device] === false ? false : connect;
        let key = tag.outKey;
        if (Object.prototype.hasOwnProperty.call(dev, key)) { // same key twice for one device -> key_2, key_3 ...
            let n = 2;
            while (Object.prototype.hasOwnProperty.call(dev, key + '_' + n)) n++;
            key = key + '_' + n;
        }
        dev[key] = value;
    }
    // a device is connected only when every tag read from it answers
    if (connectKey) {
        for (const name of Object.keys(devices)) {
            devices[name][connectKey] = Object.prototype.hasOwnProperty.call(online, name) ? online[name] : null;
        }
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

/** Configuration summary as CSV text. */
function configToCsv(config) {
    const cols = ['index', 'device', 'key', 'keyName', 'outKey', 'unit', 'quantity', 'port', 'slaveId', 'address', 'type', 'divide', 'swap'];
    const q = (v) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + [cols.join(',')].concat(config.tags.map(t => cols.map(c => q(t[c])).join(','))).join('\r\n') + '\r\n';
}

module.exports = {
    DEFAULT_MAP, TYPE_NAMES, KeyCatalog, mergeMap, planRanges, decodeName, roundValue,
    readConfig, resolveKeys, readValues, buildPayload, configToCsv
};
