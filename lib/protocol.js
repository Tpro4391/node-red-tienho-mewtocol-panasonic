'use strict';
/**
 * MEWTOCOL-COM protocol helpers (pure functions, no I/O).
 *
 * Frame (host -> PLC):  <header><station>#<command><data><BCC>CR
 * Frame (PLC -> host):  <header><station>$<cmd2><data><BCC>CR   (normal)
 *                       <header><station>!<errcode2><BCC>CR     (error)
 * header '%' = standard frame (max 118 chars), '<' = extended frame (max 2048 chars).
 * Multi-frame responses end every frame but the last with '&' before CR.
 */

const FRAME_MODES = {
    standard: { header: '%', maxLength: 118 },
    extended: { header: '<', maxLength: 2048 }
};

const PLC_ERRORS = {
    21: 'NACK error', 22: 'WACK error', 23: 'Source MEWTOCOL station number overlap',
    24: 'Transmission error', 25: 'Link unit hardware error', 26: 'MEWTOCOL station number setting error',
    27: 'Frame-over error', 28: 'No response error', 29: 'Buffer close error', 30: 'Time-out error',
    32: 'Transmission impossible error', 33: 'Communication stop', 36: 'No local station error',
    38: 'Other communication errors', 40: 'BCC error', 41: 'Format error', 42: 'Not-support error',
    43: 'Procedure error', 50: 'Link setting error', 51: 'Simultaneous operation error',
    52: 'Sending disable error', 53: 'Busy error', 60: 'Parameter error', 61: 'Data error',
    62: 'Registration error', 63: 'Mode error', 65: 'Protect error', 66: 'Address error',
    67: 'No data error', 72: 'Time-out error', 73: 'Time-out error'
};

class MewtocolError extends Error {
    /**
     * @param {string} message
     * @param {string} code  EPARAM | EPLC | ETIMEDOUT | EBCC | EPROTO | ECONN | EQUEUEFULL | ECLOSED
     * @param {object} [extra]
     */
    constructor(message, code, extra) {
        super(message);
        this.name = 'MewtocolError';
        this.code = code;
        if (extra) Object.assign(this, extra);
    }
}

function paramError(msg) { return new MewtocolError(msg, 'EPARAM'); }

/** Block check code: XOR of all characters, 2 uppercase hex digits. */
function bcc(str) {
    let x = 0;
    for (let i = 0; i < str.length; i++) x ^= str.charCodeAt(i);
    return x.toString(16).toUpperCase().padStart(2, '0');
}

function plcErrorText(code) {
    return PLC_ERRORS[code] || 'Unknown error';
}

/** Normalise station number to the 2-character field. Accepts 1..99 or "EE" (global). */
function formatStation(station) {
    if (typeof station === 'string') {
        const s = station.trim().toUpperCase();
        if (s === 'EE') return 'EE';
        if (!/^\d{1,2}$/.test(s)) throw paramError('Invalid station "' + station + '" (expected 1-99 or EE)');
        station = Number(s);
    }
    if (!Number.isInteger(station) || station < 1 || station > 99) {
        throw paramError('Invalid station "' + station + '" (expected 1-99 or EE)');
    }
    return String(station).padStart(2, '0');
}

function toInt(value, name, min, max) {
    if (typeof value === 'string') value = value.trim();
    if (value === '' || value === null || value === undefined) throw paramError('Missing ' + name);
    const n = Number(value);
    if (!Number.isInteger(n)) throw paramError('Invalid ' + name + ' "' + value + '" (integer expected)');
    if (n < min || n > max) throw paramError(name + ' ' + n + ' out of range ' + min + '-' + max);
    return n;
}

function pad(n, width) { return String(n).padStart(width, '0'); }

/** Build a complete command frame (including trailing CR). */
function buildFrame(header, station, body, useBcc) {
    const head = header + station + '#' + body;
    return head + (useBcc ? bcc(head) : '**') + '\r';
}

/** Build the "send next frame" request used for multi-frame responses. */
function buildNextFrameRequest(header, station, useBcc) {
    const head = header + station;
    return head + (useBcc ? bcc(head) : '**') + '&\r';
}

/**
 * Split one received frame (without CR) into its parts.
 * @returns {{body:string, bccText:string, continued:boolean}}
 */
function splitFrame(raw) {
    let continued = false;
    if (raw.endsWith('&')) { continued = true; raw = raw.slice(0, -1); }
    if (raw.length < 3) throw new MewtocolError('Malformed frame "' + raw + '"', 'EPROTO');
    return { body: raw.slice(0, -2), bccText: raw.slice(-2), continued };
}

function checkBcc(body, bccText) {
    return bccText === '**' || bcc(body) === bccText.toUpperCase();
}

/* ---------------------------------------------------------------- word encoding */

/** Hex string (4 chars per word, low byte first) -> array of uint16. */
function decodeWords(hex) {
    if (hex.length % 4 !== 0 || /[^0-9A-Fa-f]/.test(hex)) {
        throw new MewtocolError('Invalid word data "' + hex + '"', 'EPROTO');
    }
    const out = new Array(hex.length / 4);
    for (let i = 0, j = 0; i < hex.length; i += 4, j++) {
        out[j] = parseInt(hex.substr(i + 2, 2) + hex.substr(i, 2), 16);
    }
    return out;
}

/** Array of uint16 -> hex string (low byte first). */
function encodeWords(words) {
    let s = '';
    for (const w of words) {
        const h = (w & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        s += h.substr(2, 2) + h.substr(0, 2);
    }
    return s;
}

const DATA_TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32', 'hex', 'bits', 'string'];
const WORDS_PER_VALUE = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, hex: 1, bits: 1 };

const _buf = Buffer.alloc(4);

/** Convert raw uint16 words into values of the requested type (32-bit: low word first). */
function wordsToValues(words, type) {
    type = type || 'int16';
    switch (type) {
        case 'int16': return words.map(w => (w & 0x8000 ? w - 0x10000 : w));
        case 'uint16': return words.slice();
        case 'hex': return words.map(w => w.toString(16).toUpperCase().padStart(4, '0'));
        case 'bits': {
            const bits = [];
            for (const w of words) for (let b = 0; b < 16; b++) bits.push((w >> b) & 1);
            return bits;
        }
        case 'string': {
            const bytes = [];
            for (const w of words) bytes.push(w & 0xFF, w >> 8);
            let end = bytes.indexOf(0);
            if (end < 0) end = bytes.length;
            return Buffer.from(bytes.slice(0, end)).toString('latin1');
        }
        case 'int32': case 'uint32': case 'float32': {
            if (words.length % 2 !== 0) throw paramError(type + ' needs an even number of words');
            const out = [];
            for (let i = 0; i < words.length; i += 2) {
                _buf.writeUInt16LE(words[i], 0);
                _buf.writeUInt16LE(words[i + 1], 2);
                out.push(type === 'int32' ? _buf.readInt32LE(0)
                    : type === 'uint32' ? _buf.readUInt32LE(0)
                        : Math.fround(_buf.readFloatLE(0)));
            }
            return out;
        }
        default: throw paramError('Unknown data type "' + type + '"');
    }
}

/** Convert values (number | array | string) into uint16 words. */
function valuesToWords(values, type) {
    type = type || 'int16';
    if (type === 'string') {
        if (typeof values !== 'string') throw paramError('string data type expects a string payload');
        const bytes = Buffer.from(values, 'latin1');
        const words = [];
        for (let i = 0; i < bytes.length; i += 2) words.push(bytes[i] | ((bytes[i + 1] || 0) << 8));
        return words;
    }
    if (Buffer.isBuffer(values)) values = Array.from(values);
    if (!Array.isArray(values)) values = [values];
    if (values.length === 0) throw paramError('No data to write');
    const words = [];
    const num = (v) => {
        if (typeof v === 'boolean') return v ? 1 : 0;
        const n = typeof v === 'string' && type === 'hex' ? parseInt(v, 16) : Number(v);
        if (typeof v === 'string' && v.trim() === '') throw paramError('Invalid value ""');
        if (!Number.isFinite(n)) throw paramError('Invalid value "' + v + '"');
        return n;
    };
    switch (type) {
        case 'int16': case 'uint16': case 'hex':
            for (const v of values) {
                const n = num(v);
                const lo = type === 'int16' ? -32768 : 0;
                const hi = type === 'int16' ? 32767 : 65535;
                if (!Number.isInteger(n) || n < lo || n > hi) throw paramError('Value ' + v + ' out of ' + type + ' range');
                words.push(n & 0xFFFF);
            }
            return words;
        case 'bits': {
            if (values.length % 16 !== 0) throw paramError('bits data type expects a multiple of 16 values');
            for (let i = 0; i < values.length; i += 16) {
                let w = 0;
                for (let b = 0; b < 16; b++) if (num(values[i + b])) w |= (1 << b);
                words.push(w);
            }
            return words;
        }
        case 'int32': case 'uint32': case 'float32':
            for (const v of values) {
                const n = num(v);
                if (type === 'int32') {
                    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw paramError('Value ' + v + ' out of int32 range');
                    _buf.writeInt32LE(n, 0);
                } else if (type === 'uint32') {
                    if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw paramError('Value ' + v + ' out of uint32 range');
                    _buf.writeUInt32LE(n, 0);
                } else {
                    _buf.writeFloatLE(n, 0);
                }
                words.push(_buf.readUInt16LE(0), _buf.readUInt16LE(2));
            }
            return words;
        default: throw paramError('Unknown data type "' + type + '"');
    }
}

/* ---------------------------------------------------------------- address helpers */

const AREAS = {
    register: ['D', 'L', 'F'],        // RD / WD
    contactRead: ['X', 'Y', 'R', 'L'], // RCC
    contactWrite: ['Y', 'R', 'L'],     // WCC / WCS
    contactBitRead: ['X', 'Y', 'R', 'L', 'T', 'C'], // RCS / RCP
    contactBitWrite: ['Y', 'R', 'L']
};

function checkArea(area, allowed) {
    const a = String(area || '').trim().toUpperCase();
    if (!allowed.includes(a)) throw paramError('Invalid area "' + area + '". Valid areas: ' + allowed.join(','));
    return a;
}

/**
 * Contact bit address -> 4 character field.
 * X/Y/R/L: decimal word (max 3 digits) + hex bit, e.g. "100A" (= word 100, bit 10), "1A", "5".
 * T/C: decimal number (max 4 digits).
 */
function formatBitAddress(area, address) {
    let s = String(address === undefined || address === null ? '' : address).trim().toUpperCase();
    if (s === '') throw paramError('Missing address');
    if (area === 'T' || area === 'C') {
        if (!/^\d{1,4}$/.test(s)) throw paramError('Invalid ' + area + ' address "' + address + '" (0-9999)');
        return s.padStart(4, '0');
    }
    if (!/^\d{0,3}[0-9A-F]$/.test(s)) {
        throw paramError('Invalid ' + area + ' address "' + address + '" (word + hex bit, e.g. 100A)');
    }
    return s.padStart(4, '0');
}

/** Parse "X100A" / "R1F" / "T5" into {area, field}. */
function parseBitAddress(spec) {
    const s = String(spec).trim().toUpperCase();
    const m = /^([XYRLTC])(.+)$/.exec(s);
    if (!m) throw paramError('Invalid contact address "' + spec + '" (e.g. X100A, R1F, T5)');
    return { area: m[1], field: formatBitAddress(m[1], m[2]) };
}

/* ---------------------------------------------------------------- frame size helpers */

/** Max number of data words in a single response frame. */
function maxReadWords(frameMode) {
    const max = FRAME_MODES[frameMode].maxLength;
    return Math.floor((max - 9) / 4); // header(1)+station(2)+$(1)+code(2)+BCC(2)+CR(1)=9
}

/** Max number of data words for a write command whose fixed body length is `fixed`. */
function maxWriteWords(frameMode, fixed) {
    const max = FRAME_MODES[frameMode].maxLength;
    return Math.floor((max - 4 - fixed - 3) / 4); // header+station+'#'=4, BCC+CR=3
}

/**
 * Split an inclusive address range into chunks of at most `size` items.
 * @returns {Array<[number, number]>}
 */
function chunkRange(start, end, size) {
    const out = [];
    for (let s = start; s <= end; s += size) out.push([s, Math.min(end, s + size - 1)]);
    return out;
}

/* ---------------------------------------------------------------- command bodies */
// Each builder returns { body, code } where code is the 2 char response command code.

const commands = {
    RD(area, start, end) {
        return { body: 'RD' + area + pad(start, 5) + pad(end, 5), code: 'RD' };
    },
    WD(area, start, words) {
        const end = start + words.length - 1;
        return { body: 'WD' + area + pad(start, 5) + pad(end, 5) + encodeWords(words), code: 'WD' };
    },
    RCC(area, start, end) {
        return { body: 'RCC' + area + pad(start, 4) + pad(end, 4), code: 'RC' };
    },
    WCC(area, start, words) {
        const end = start + words.length - 1;
        return { body: 'WCC' + area + pad(start, 4) + pad(end, 4) + encodeWords(words), code: 'WC' };
    },
    RCS(area, field) {
        return { body: 'RCS' + area + field, code: 'RC' };
    },
    WCS(area, field, value) {
        return { body: 'WCS' + area + field + (value ? '1' : '0'), code: 'WC' };
    },
    RCP(list) { // list: [{area, field}]
        return { body: 'RCP' + list.length + list.map(a => a.area + a.field).join(''), code: 'RC' };
    },
    WCP(list) { // list: [{area, field, value}]
        return { body: 'WCP' + list.length + list.map(a => a.area + a.field + (a.value ? '1' : '0')).join(''), code: 'WC' };
    },
    RS(start, end) { return { body: 'RS' + pad(start, 4) + pad(end, 4), code: 'RS' }; },
    WS(start, words) { return { body: 'WS' + pad(start, 4) + pad(start + words.length - 1, 4) + encodeWords(words), code: 'WS' }; },
    RK(start, end) { return { body: 'RK' + pad(start, 4) + pad(end, 4), code: 'RK' }; },
    WK(start, words) { return { body: 'WK' + pad(start, 4) + pad(start + words.length - 1, 4) + encodeWords(words), code: 'WK' }; },
    RR(start, end) { return { body: 'RR0' + pad(start, 3) + pad(end, 3), code: 'RR' }; },
    RT() { return { body: 'RT', code: 'RT' }; }
};

/** Fixed (non-data) body length of write commands, used for chunking. */
const WRITE_FIXED = { WD: 13, WCC: 12, WS: 10, WK: 10 };

/** Decode the RT (read PLC status) response data part (after "RT"). */
function parseStatus(d) {
    if (d.length < 16) throw new MewtocolError('RT response too short', 'EPROTO');
    const operstatus = parseInt(d.substr(6, 2), 16);
    const errorflag = parseInt(d.substr(10, 2), 16);
    const bit = (v, n) => (v >> n) & 1;
    return {
        cputype: d.substr(0, 2),
        cpuversion: d.substr(2, 2),
        progcapacity: parseInt(d.substr(4, 2), 10),
        mode: bit(operstatus, 0) ? 'RUN' : 'PROG',
        operstatus: {
            operation_mode: bit(operstatus, 0),
            testrun_mode: bit(operstatus, 1),
            break_exec: bit(operstatus, 2),
            break_cond: bit(operstatus, 3),
            out_enable: bit(operstatus, 4),
            step_run: bit(operstatus, 5),
            msg_inst: bit(operstatus, 6),
            remote_mode: bit(operstatus, 7)
        },
        errorflag: {
            self_diag_error: bit(errorflag, 0),
            voltage_dip: bit(errorflag, 1),
            fuse_blow: bit(errorflag, 2),
            intelligent_unit_error: bit(errorflag, 3),
            io_verify: bit(errorflag, 4),
            vbatt_drop: bit(errorflag, 5),
            vbatt_drop_hold: bit(errorflag, 6),
            oper_error: bit(errorflag, 7)
        },
        selfdiag: parseInt(d.substr(14, 2) + d.substr(12, 2), 16)
    };
}

/** Parse contact bit characters ("0"/"1") into numbers. */
function parseBits(str, expected) {
    if (str.length < expected || /[^01]/.test(str.slice(0, expected))) {
        throw new MewtocolError('Invalid contact data "' + str + '"', 'EPROTO');
    }
    return Array.from(str.slice(0, expected), c => (c === '1' ? 1 : 0));
}

module.exports = {
    FRAME_MODES, PLC_ERRORS, DATA_TYPES, WORDS_PER_VALUE, AREAS, WRITE_FIXED,
    MewtocolError, bcc, plcErrorText, formatStation, toInt,
    buildFrame, buildNextFrameRequest, splitFrame, checkBcc,
    decodeWords, encodeWords, wordsToValues, valuesToWords,
    checkArea, formatBitAddress, parseBitAddress,
    maxReadWords, maxWriteWords, chunkRange,
    commands, parseStatus, parseBits
};
