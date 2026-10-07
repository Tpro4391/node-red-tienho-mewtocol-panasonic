'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MockPLC = require('./mock-plc');
const MewtocolClient = require('../lib/client');

async function setup(plcOpts, clientOpts) {
    const plc = new MockPLC(plcOpts);
    const port = await plc.listen();
    const client = new MewtocolClient(Object.assign({ host: '127.0.0.1', port, timeout: 500, reconnectInterval: 50 }, clientOpts));
    return { plc, client };
}
async function teardown({ plc, client }) {
    await client.close();
    await plc.close();
}

test('reads and writes registers (all data types)', async () => {
    const ctx = await setup();
    const { client, plc } = ctx;
    try {
        plc.mem.D[100] = 0x1234;
        assert.deepEqual(await client.readWords('RD', 1, 'D', 100, 100), [0x1234]);
        await client.writeWords('WD', 1, 'D', 0, [1, 2, 3, 65535]);
        assert.deepEqual(plc.mem.D.slice(0, 4), [1, 2, 3, 65535]);
        assert.deepEqual(await client.RD(1, 'D', 0, 3), [1, 2, 3, -1]); // legacy int16 API
        assert.equal(await client.RD(1, 'D', 0, 0), 1);                // legacy scalar unwrap
        await client.writeWords('WD', 1, 'F', 10, [7]);
        assert.equal(plc.mem.F[10], 7);
        await client.writeWords('WD', 1, 'L', 10, [9]);
        assert.equal(plc.mem.LD[10], 9);
    } finally { await teardown(ctx); }
});

test('large ranges are chunked to single frames (standard and extended)', async () => {
    for (const frameMode of ['standard', 'extended']) {
        const ctx = await setup({ multiFrame: false }, { frameMode });
        const { client, plc } = ctx;
        try {
            const data = Array.from({ length: 1200 }, (_, i) => (i * 7) & 0xFFFF);
            await client.writeWords('WD', 1, 'D', 1000, data);
            assert.deepEqual(plc.mem.D.slice(1000, 2200), data);
            assert.deepEqual(await client.readWords('RD', 1, 'D', 1000, 2199), data);
            for (const f of plc.requests) assert.ok(f.length + 1 <= (frameMode === 'standard' ? 118 : 2048), frameMode + ' frame too long: ' + f.length);
            if (frameMode === 'extended') assert.ok(plc.requests.length <= 6, 'extended mode should need few requests, used ' + plc.requests.length);
        } finally { await teardown(ctx); }
    }
});

test('multi-frame responses are reassembled (raw command, 100 words)', async () => {
    const ctx = await setup({ chunk: 'random' });
    const { client, plc } = ctx;
    try {
        for (let i = 0; i < 100; i++) plc.mem.D[i] = i + 1;
        const resp = await client.raw(1, 'RDD0000000099');
        assert.equal(resp.slice(0, 2), 'RD');
        const words = require('../lib/protocol').decodeWords(resp.slice(2));
        assert.deepEqual(words, Array.from({ length: 100 }, (_, i) => i + 1));
    } finally { await teardown(ctx); }
});

test('contacts: RCS, RCP (>8 split), RCC, WCS, WCP, WCC', async () => {
    const ctx = await setup({ chunk: 3 });
    const { client, plc } = ctx;
    try {
        await client.writeBit(1, 'R', '100A', true);
        assert.equal((plc.mem.R[100] >> 10) & 1, 1);
        assert.equal(await client.readBit(1, 'R', '100A'), 1);
        assert.equal(await client.readBit(1, 'R', '1009'), 0);
        plc.mem.X[0] = 0b101;
        plc.mem.T[5] = 1;
        const list = ['X0', 'X1', 'X2', 'R100A', 'T5', 'Y0', 'Y1', 'Y2', 'Y3', 'C1'];
        assert.deepEqual(await client.readBits(1, list), [1, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
        assert.equal(plc.requests.filter(r => r.includes('#RCP')).length, 2);
        await client.writeBits(1, [{ address: 'Y0', value: 1 }, { address: 'Y1F', value: 'on' }]);
        assert.equal(plc.mem.Y[0], 1);
        assert.equal(plc.mem.Y[1], 0x8000);
        await client.writeWords('WCC', 1, 'R', 10, [0xAAAA, 0x5555]);
        assert.deepEqual(await client.readWords('RCC', 1, 'R', 10, 11), [0xAAAA, 0x5555]);
        await assert.rejects(client.writeBit(1, 'X', '0', 1), /Invalid area/);
    } finally { await teardown(ctx); }
});

test('RS / RK / WS / WK / RR / RT use the right commands', async () => {
    const ctx = await setup();
    const { client, plc } = ctx;
    try {
        plc.mem.SV[3] = 50; plc.mem.EV[3] = 20; plc.mem.SR[5] = 77;
        assert.deepEqual(await client.readWords('RS', 1, null, 3, 3), [50]);
        assert.deepEqual(await client.readWords('RK', 1, null, 3, 3), [20]);
        assert.deepEqual(await client.readWords('RR', 1, null, 5, 5), [77]);
        await client.writeWords('WS', 1, null, 0, [100, 200]);
        await client.writeWords('WK', 1, null, 0, [1]);
        assert.deepEqual(plc.mem.SV.slice(0, 2), [100, 200]);
        assert.equal(plc.mem.EV[0], 1);
        const st = await client.readStatus(1);
        assert.equal(st.mode, 'RUN');
        const cmds = plc.requests.map(r => r.slice(4, 6));
        assert.deepEqual(cmds, ['RS', 'RK', 'RR', 'WS', 'WK', 'RT']);
    } finally { await teardown(ctx); }
});

test('address 0 and station EE are valid', async () => {
    const ctx = await setup();
    try {
        ctx.plc.mem.D[0] = 42;
        assert.deepEqual(await ctx.client.readWords('RD', 'EE', 'D', 0, 0), [42]);
    } finally { await teardown(ctx); }
});

test('concurrent requests share ONE connection and never overlap', async () => {
    const ctx = await setup({ delay: 2, chunk: 'random' });
    const { client, plc } = ctx;
    try {
        for (let i = 0; i < 50; i++) plc.mem.D[i] = i * 3;
        const results = await Promise.all(Array.from({ length: 50 }, (_, i) => client.readWords('RD', 1, 'D', i, i)));
        results.forEach((r, i) => assert.deepEqual(r, [i * 3]));
        assert.equal(plc.connections, 1);
        assert.equal(plc.overlapViolations, 0);
    } finally { await teardown(ctx); }
});

test('PLC error responses are reported with code', async () => {
    const ctx = await setup();
    try {
        await assert.rejects(ctx.client.raw(1, 'ZZ'), (e) => e.code === 'EPLC' && e.plcCode === 42 && /Not-support/.test(e.message));
        await assert.rejects(ctx.client.readWords('RD', 1, 'D', 99990, 100010), (e) => e.code === 'EPARAM');
        await assert.rejects(ctx.client.readWords('RD', 1, 'D', 10, 5), /End address/);
        // connection is still usable afterwards
        assert.deepEqual(await ctx.client.readWords('RD', 1, 'D', 0, 0), [0]);
    } finally { await teardown(ctx); }
});

test('BCC errors in responses are detected', async () => {
    const ctx = await setup({ badBcc: true });
    try {
        await assert.rejects(ctx.client.readWords('RD', 1, 'D', 0, 0), (e) => e.code === 'EBCC');
    } finally { await teardown(ctx); }
});

test('BCC can be disabled', async () => {
    const ctx = await setup({ badBcc: true }, { bcc: false });
    try {
        assert.deepEqual(await ctx.client.readWords('RD', 1, 'D', 0, 0), [0]);
        assert.ok(ctx.plc.requests[0].endsWith('**'));
    } finally { await teardown(ctx); }
});

test('timeout rejects and the next request works on a fresh socket', async () => {
    const ctx = await setup({ silent: true }, { timeout: 150 });
    try {
        await assert.rejects(ctx.client.readWords('RD', 1, 'D', 0, 0), (e) => e.code === 'ETIMEDOUT');
        ctx.plc.opts.silent = false;
        assert.deepEqual(await ctx.client.readWords('RD', 1, 'D', 0, 0), [0]);
        assert.equal(ctx.plc.connections, 2);
    } finally { await teardown(ctx); }
});

test('reconnects transparently when the PLC drops the socket', async () => {
    const ctx = await setup({ dropAfter: 1 });
    try {
        for (let i = 0; i < 3; i++) {
            assert.deepEqual(await ctx.client.readWords('RD', 1, 'D', 0, 0), [0]);
            await new Promise(r => setTimeout(r, 60));
        }
        assert.ok(ctx.plc.connections >= 3);
    } finally { await teardown(ctx); }
});

test('stale socket closed mid-request is retried once', async () => {
    const ctx = await setup({ delay: 50 });
    try {
        await ctx.client.connect();
        const p = ctx.client.readWords('RD', 1, 'D', 0, 0);
        setTimeout(() => ctx.plc.dropAll(), 10);
        assert.deepEqual(await p, [0]);
    } finally { await teardown(ctx); }
});

test('unreachable PLC fails fast and queue is bounded', async () => {
    const plc = new MockPLC();
    const port = await plc.listen();
    await plc.close(); // nothing listens on this port anymore
    const client = new MewtocolClient({ host: '127.0.0.1', port, timeout: 300, maxQueue: 5, failFastWindow: 5000, keepAlive: false });
    try {
        await assert.rejects(client.readWords('RD', 1, 'D', 0, 0), (e) => e.code === 'ECONN');
        const t0 = Date.now();
        await assert.rejects(client.readWords('RD', 1, 'D', 0, 0), (e) => e.code === 'ECONN');
        assert.ok(Date.now() - t0 < 50, 'should fail fast');
        const many = Array.from({ length: 10 }, () => client.readWords('RD', 1, 'D', 0, 0).catch(e => e.code));
        const codes = await Promise.all(many);
        assert.ok(codes.includes('EQUEUEFULL'));
    } finally { await client.close(); }
});

test('keepAlive=false closes the socket when idle', async () => {
    const ctx = await setup({}, { keepAlive: false });
    try {
        await ctx.client.readWords('RD', 1, 'D', 0, 0);
        await new Promise(r => setTimeout(r, 50));
        assert.equal(ctx.plc.activeConnections, 0);
        await ctx.client.readWords('RD', 1, 'D', 0, 0);
    } finally { await teardown(ctx); }
});

test('close() rejects queued requests', async () => {
    const ctx = await setup({ delay: 100 });
    const ps = [0, 1, 2].map(() => ctx.client.readWords('RD', 1, 'D', 0, 0).catch(e => e.code));
    await new Promise(r => setTimeout(r, 20));
    await ctx.client.close();
    assert.deepEqual(await Promise.all(ps), ['ECLOSED', 'ECLOSED', 'ECLOSED']);
    await ctx.plc.close();
});

test('jsmewtocol-style constructor still works', async () => {
    const plc = new MockPLC();
    const port = await plc.listen();
    const client = new MewtocolClient('127.0.0.1', port, 500);
    try {
        plc.mem.SV[1] = 5;
        assert.equal(await client.RS(1, 1, 1), 5);
        assert.equal(await client.RCS(1, 'X', '0'), 0);
    } finally { await client.destroy(); await plc.close(); }
});

test('works with a PLC that accepts only ONE socket and a serial CPU', async () => {
    const ctx = await setup({ maxConnections: 1, serial: true, delay: 1 }, { maxQueue: 500 });
    try {
        for (let i = 0; i < 10; i++) ctx.plc.mem.D[i] = i;
        const r = await Promise.all(Array.from({ length: 200 }, () => ctx.client.RD(1, 'D', 0, 9)));
        assert.ok(r.every(x => x[9] === 9));
        assert.equal(ctx.plc.refused, 0);
    } finally { await teardown(ctx); }
});
