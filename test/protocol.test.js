'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/protocol');

test('BCC matches the Panasonic manual example', () => {
    assert.equal(P.bcc('%01#RCSX0000'), '1D');
    assert.equal(P.buildFrame('%', '01', 'RCSX0000', true), '%01#RCSX00001D\r');
    assert.equal(P.buildFrame('%', '01', 'RCSX0000', false), '%01#RCSX0000**\r');
});

test('station formatting', () => {
    assert.equal(P.formatStation(1), '01');
    assert.equal(P.formatStation('7'), '07');
    assert.equal(P.formatStation('ee'), 'EE');
    assert.equal(P.formatStation(99), '99');
    assert.throws(() => P.formatStation(0), /Invalid station/);
    assert.throws(() => P.formatStation(100), /Invalid station/);
    assert.throws(() => P.formatStation('abc'), /Invalid station/);
});

test('word encoding is little endian per word', () => {
    assert.equal(P.encodeWords([0x1234, 0x00FF]), '3412FF00');
    assert.deepEqual(P.decodeWords('3412FF00'), [0x1234, 0x00FF]);
    assert.throws(() => P.decodeWords('123'), /Invalid word data/);
});

test('data type conversions round-trip', () => {
    const cases = {
        int16: [-32768, -1, 0, 1, 32767],
        uint16: [0, 1, 65535],
        int32: [-2147483648, -100000, 0, 123456789],
        uint32: [0, 4294967295, 70000],
        float32: [0, 1.5, -273.25, 3.4028234663852886e38]
    };
    for (const [type, values] of Object.entries(cases)) {
        assert.deepEqual(P.wordsToValues(P.valuesToWords(values, type), type), values, type);
    }
    assert.deepEqual(P.wordsToValues([0x1234], 'hex'), ['1234']);
    assert.deepEqual(P.valuesToWords(['1234', 'ffff'], 'hex'), [0x1234, 0xFFFF]);
    assert.equal(P.wordsToValues(P.valuesToWords('HELLO', 'string'), 'string'), 'HELLO');
    const bits = P.wordsToValues([0x8001], 'bits');
    assert.equal(bits.length, 16);
    assert.equal(bits[0], 1); assert.equal(bits[15], 1); assert.equal(bits[1], 0);
    assert.deepEqual(P.valuesToWords(bits, 'bits'), [0x8001]);
});

test('32-bit values use low word first (Panasonic DDT order)', () => {
    assert.deepEqual(P.valuesToWords(0x12345678, 'uint32'), [0x5678, 0x1234]);
});

test('value validation', () => {
    assert.throws(() => P.valuesToWords(40000, 'int16'), /range/);
    assert.throws(() => P.valuesToWords(-1, 'uint16'), /range/);
    assert.throws(() => P.valuesToWords('abc', 'int16'), /Invalid value/);
    assert.throws(() => P.valuesToWords([], 'int16'), /No data/);
    assert.throws(() => P.wordsToValues([1, 2, 3], 'int32'), /even number/);
    assert.deepEqual(P.valuesToWords(true, 'uint16'), [1]);
});

test('contact bit addresses', () => {
    assert.equal(P.formatBitAddress('R', '100A'), '100A');
    assert.equal(P.formatBitAddress('X', '1a'), '001A');
    assert.equal(P.formatBitAddress('Y', 5), '0005');
    assert.equal(P.formatBitAddress('T', 12), '0012');
    assert.throws(() => P.formatBitAddress('R', '1000A'), /Invalid/);
    assert.throws(() => P.formatBitAddress('T', '1A'), /Invalid/);
    assert.deepEqual(P.parseBitAddress('r100f'), { area: 'R', field: '100F' });
});

test('command bodies', () => {
    assert.equal(P.commands.RD('D', 0, 9).body, 'RDD0000000009');
    assert.equal(P.commands.WD('D', 1, [1, 2]).body, 'WDD000010000201000200');
    assert.equal(P.commands.RCC('X', 0, 3).body, 'RCCX00000003');
    assert.equal(P.commands.RCS('R', '100A').body, 'RCSR100A');
    assert.equal(P.commands.WCS('Y', '0001', true).body, 'WCSY00011');
    assert.equal(P.commands.RCP([{ area: 'X', field: '0000' }, { area: 'Y', field: '001A' }]).body, 'RCP2X0000Y001A');
    assert.equal(P.commands.RS(0, 5).body, 'RS00000005');
    assert.equal(P.commands.RK(3, 3).body, 'RK00030003');
    assert.equal(P.commands.RR(0, 10).body, 'RR0000010');
    assert.equal(P.commands.WS(2, [100]).body, 'WS000200026400');
});

test('frame size limits', () => {
    assert.equal(P.maxReadWords('standard'), 27);
    assert.equal(P.maxReadWords('extended'), 509);
    // WD with 24 words must fit exactly in 118 chars
    const f = P.buildFrame('%', '01', P.commands.WD('D', 0, new Array(P.maxWriteWords('standard', P.WRITE_FIXED.WD)).fill(0)).body, true);
    assert.ok(f.length <= 118, 'frame length ' + f.length);
    assert.deepEqual(P.chunkRange(0, 60, 27), [[0, 26], [27, 53], [54, 60]]);
});

test('RT status decoding', () => {
    const s = P.parseStatus('0525328100203412');
    assert.equal(s.cputype, '05');
    assert.equal(s.cpuversion, '25');
    assert.equal(s.progcapacity, 32);
    assert.equal(s.mode, 'RUN');
    assert.equal(s.operstatus.remote_mode, 1);
    assert.equal(s.errorflag.vbatt_drop, 1);
    assert.equal(s.selfdiag, 0x1234);
});

test('frame split and BCC check', () => {
    const body = '%01$RC1';
    const raw = body + P.bcc(body);
    const parts = P.splitFrame(raw);
    assert.equal(parts.body, body);
    assert.ok(P.checkBcc(parts.body, parts.bccText));
    assert.ok(!P.checkBcc(parts.body, '00') || P.bcc(body) === '00');
    assert.equal(P.splitFrame(raw + '&').continued, true);
});
