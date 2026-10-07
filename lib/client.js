'use strict';
/**
 * High level MEWTOCOL-COM client: validated commands with automatic chunking
 * so every request/response fits into a single frame of the selected frame mode.
 */
const MewtocolConnection = require('./connection');
const P = require('./protocol');
const { MewtocolError } = P;

/** Word-oriented read commands: [builder, min addr, max addr, area list or null] */
const WORD_READ = {
    RD: { build: (a, s, e) => P.commands.RD(a, s, e), max: 99999, areas: P.AREAS.register },
    RCC: { build: (a, s, e) => P.commands.RCC(a, s, e), max: 9999, areas: P.AREAS.contactRead },
    RS: { build: (a, s, e) => P.commands.RS(s, e), max: 9999, areas: null },
    RK: { build: (a, s, e) => P.commands.RK(s, e), max: 9999, areas: null },
    RR: { build: (a, s, e) => P.commands.RR(s, e), max: 999, areas: null }
};

const WORD_WRITE = {
    WD: { build: (a, s, w) => P.commands.WD(a, s, w), max: 99999, areas: P.AREAS.register },
    WCC: { build: (a, s, w) => P.commands.WCC(a, s, w), max: 9999, areas: P.AREAS.contactWrite },
    WS: { build: (a, s, w) => P.commands.WS(s, w), max: 9999, areas: null },
    WK: { build: (a, s, w) => P.commands.WK(s, w), max: 9999, areas: null }
};

const BITS_PER_REQUEST = 8; // RCP / WCP limit

class MewtocolClient extends MewtocolConnection {
    /**
     * @param {object|string} options  options object, or (host, port, timeout) like jsmewtocol
     */
    constructor(options, port, timeout) {
        if (typeof options === 'string') options = { host: options, port, timeout };
        super(options);
    }

    /**
     * Read a range of 16-bit words.
     * @param {'RD'|'RCC'|'RS'|'RK'|'RR'} kind
     * @returns {Promise<number[]>} raw unsigned 16-bit words
     */
    async readWords(kind, station, area, start, end) {
        const def = WORD_READ[kind];
        if (!def) throw new MewtocolError('Unknown read command ' + kind, 'EPARAM');
        const st = P.formatStation(station);
        const a = def.areas ? P.checkArea(area, def.areas) : null;
        const s = P.toInt(start, 'start address', 0, def.max);
        const e = P.toInt(end, 'end address', 0, def.max);
        if (e < s) throw new MewtocolError('End address must be greater than or equal to start address', 'EPARAM');
        const words = [];
        for (const [cs, ce] of P.chunkRange(s, e, P.maxReadWords(this.frameMode))) {
            const data = await this.request(st, def.build(a, cs, ce));
            const w = P.decodeWords(data);
            if (w.length !== ce - cs + 1) {
                throw new MewtocolError('Expected ' + (ce - cs + 1) + ' words, PLC returned ' + w.length, 'EPROTO');
            }
            for (const x of w) words.push(x);
        }
        return words;
    }

    /**
     * Write consecutive 16-bit words starting at `start`.
     * @param {'WD'|'WCC'|'WS'|'WK'} kind
     * @returns {Promise<{start:number,end:number,count:number}>}
     */
    async writeWords(kind, station, area, start, words) {
        const def = WORD_WRITE[kind];
        if (!def) throw new MewtocolError('Unknown write command ' + kind, 'EPARAM');
        const st = P.formatStation(station);
        const a = def.areas ? P.checkArea(area, def.areas) : null;
        const s = P.toInt(start, 'start address', 0, def.max);
        if (!Array.isArray(words) || words.length === 0) throw new MewtocolError('No data to write', 'EPARAM');
        const e = s + words.length - 1;
        if (e > def.max) throw new MewtocolError('Write range ' + s + '-' + e + ' exceeds max address ' + def.max, 'EPARAM');
        const size = P.maxWriteWords(this.frameMode, P.WRITE_FIXED[kind]);
        for (let i = 0; i < words.length; i += size) {
            await this.request(st, def.build(a, s + i, words.slice(i, i + size)));
        }
        return { start: s, end: e, count: words.length };
    }

    /** RCS - read one contact bit. Returns 0 or 1. */
    async readBit(station, area, address) {
        const st = P.formatStation(station);
        const a = P.checkArea(area, P.AREAS.contactBitRead);
        const data = await this.request(st, P.commands.RCS(a, P.formatBitAddress(a, address)));
        return P.parseBits(data, 1)[0];
    }

    /** RCP - read many contact bits, e.g. ['X0', 'Y1A', 'R100F', 'T5']. Returns array of 0/1. */
    async readBits(station, addresses) {
        const st = P.formatStation(station);
        const list = normaliseAddressList(addresses).map(P.parseBitAddress);
        const out = [];
        for (let i = 0; i < list.length; i += BITS_PER_REQUEST) {
            const part = list.slice(i, i + BITS_PER_REQUEST);
            const data = await this.request(st, P.commands.RCP(part));
            for (const b of P.parseBits(data, part.length)) out.push(b);
        }
        return out;
    }

    /** WCS - write one contact bit (Y, R, L). */
    async writeBit(station, area, address, value) {
        const st = P.formatStation(station);
        const a = P.checkArea(area, P.AREAS.contactBitWrite);
        await this.request(st, P.commands.WCS(a, P.formatBitAddress(a, address), toBool(value)));
        return toBool(value) ? 1 : 0;
    }

    /** WCP - write many contact bits: [{address:'R10', value:true}, ...] */
    async writeBits(station, items) {
        const st = P.formatStation(station);
        if (!Array.isArray(items) || items.length === 0) throw new MewtocolError('No contacts to write', 'EPARAM');
        const list = items.map((it) => {
            const ad = P.parseBitAddress(it.address);
            if (!P.AREAS.contactBitWrite.includes(ad.area)) {
                throw new MewtocolError('Area ' + ad.area + ' is not writable (Y, R, L only)', 'EPARAM');
            }
            return Object.assign(ad, { value: toBool(it.value) });
        });
        for (let i = 0; i < list.length; i += BITS_PER_REQUEST) {
            await this.request(st, P.commands.WCP(list.slice(i, i + BITS_PER_REQUEST)));
        }
        return list.length;
    }

    /** RT - read PLC status. */
    async readStatus(station) {
        const data = await this.request(P.formatStation(station), P.commands.RT());
        return P.parseStatus(data);
    }

    /**
     * Send a raw command body, e.g. "RDD0000000009" (leading '#' optional).
     * Resolves with the response text after '$' (response code included).
     */
    async raw(station, body) {
        body = String(body || '').trim().replace(/^#/, '');
        if (!/^[A-Z]{2}[0-9A-Z]*$/.test(body)) throw new MewtocolError('Invalid raw command "' + body + '"', 'EPARAM');
        const max = P.FRAME_MODES[this.frameMode].maxLength;
        if (body.length + 7 > max) throw new MewtocolError('Raw command longer than frame limit (' + max + ')', 'EPARAM');
        return this.request(P.formatStation(station), { body, code: null });
    }

    /* ---------- jsmewtocol compatible API (int16 values, single value unwrapped) ---------- */
    RD(station, area, s, e) { return this.readWords('RD', station, area, s, e).then(legacy); }
    RCC(station, area, s, e) { return this.readWords('RCC', station, area, s, e).then(legacy); }
    RS(station, s, e) { return this.readWords('RS', station, null, s, e).then(legacy); }
    RK(station, s, e) { return this.readWords('RK', station, null, s, e).then(legacy); }
    RR(station, s, e) { return this.readWords('RR', station, null, s, e).then(legacy); }
    RCS(station, area, address) { return this.readBit(station, area, address); }
    RCP(station, addresses) { return this.readBits(station, addresses); }
    RT(station) { return this.readStatus(station); }
    destroy() { return this.close(); }
}

function legacy(words) {
    const v = P.wordsToValues(words, 'int16');
    return v.length > 1 ? v : v[0];
}

function normaliseAddressList(addresses) {
    if (typeof addresses === 'string') addresses = addresses.split(/[\s,;]+/);
    if (!Array.isArray(addresses)) throw new MewtocolError('Addresses must be an array or a comma separated string', 'EPARAM');
    const list = addresses.map(a => String(a).trim()).filter(Boolean);
    if (list.length === 0) throw new MewtocolError('No contact addresses given', 'EPARAM');
    return list;
}

function toBool(v) {
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes'].includes(s)) return true;
        if (['0', 'false', 'off', 'no', ''].includes(s)) return false;
        throw new MewtocolError('Invalid boolean value "' + v + '"', 'EPARAM');
    }
    return !!v;
}

MewtocolClient.normaliseAddressList = normaliseAddressList;
MewtocolClient.toBool = toBool;
module.exports = MewtocolClient;
