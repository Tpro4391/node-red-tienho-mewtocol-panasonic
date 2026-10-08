'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const MockPLC = require('./mock-plc');

const pkg = require('../package.json');
const nodeFiles = Object.values(pkg['node-red'].nodes).map(f => require('../' + f));

helper.init(require.resolve('node-red'));

let plc;
test.before(async () => {
    plc = new MockPLC();
    await plc.listen();
    await new Promise(r => helper.startServer(r));
});
test.after(async () => {
    await plc.close();
    await new Promise(r => helper.stopServer(r));
});
test.afterEach(async () => { await helper.unload(); });

function cfg(extra) {
    return Object.assign({ id: 'c1', type: 'mewtocol-client', host: '127.0.0.1', port: plc.port, timeout: 500 }, extra);
}

/** Load a flow with one command node wired to helper nodes "ok" and "err". */
async function run(nodeDef, msgs, extraCfg) {
    await helper.unload();
    const flow = [
        cfg(extraCfg),
        Object.assign({ id: 'n1', server: 'c1', station: 1, sendonerror: false, wires: [['ok'], ['err']] }, nodeDef),
        { id: 'ok', type: 'helper' }, { id: 'err', type: 'helper' }
    ];
    await helper.load(nodeFiles, flow);
    const n1 = helper.getNode('n1');
    const out = { ok: [], err: [] };
    helper.getNode('ok').on('input', m => out.ok.push(m));
    helper.getNode('err').on('input', m => out.err.push(m));
    for (const m of [].concat(msgs)) n1.receive(m);
    const expected = [].concat(msgs).length;
    const t0 = Date.now();
    while (out.ok.length + out.err.length < expected && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10));
    return out;
}

test('all node types load', async () => {
    const types = Object.keys(pkg['node-red'].nodes).length;
    assert.equal(types, 16);
    await helper.load(nodeFiles, [cfg()]);
    assert.ok(helper.getNode('c1').client);
});

test('RD reads registers with data types and legacy scalar output', async () => {
    plc.mem.D.fill(0, 0, 20);
    plc.mem.D[10] = 0xFFFF; plc.mem.D[11] = 5;
    let o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '10', endaddress: '11' }, { payload: 'go', topic: 't' });
    assert.deepEqual(o.ok[0].payload, [-1, 5]);
    assert.equal(o.ok[0].topic, 't');
    assert.equal(o.ok[0].mewtocol.command, 'RD');

    o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '10', endaddress: '10', datatype: 'uint16' }, {});
    assert.equal(o.ok[0].payload, 65535);

    o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '10', endaddress: '10', alwaysarray: true }, {});
    assert.deepEqual(o.ok[0].payload, [-1]);

    o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '10', endaddress: '11', datatype: 'int32' }, {});
    assert.equal(o.ok[0].payload, 5 * 65536 + 65535);
});

test('msg properties override config and 0 is honoured', async () => {
    plc.mem.D[0] = 123; plc.mem.D[5] = 456;
    const o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '5', endaddress: '5' },
        { startaddress: 0, endaddress: 0 });
    assert.equal(o.ok[0].payload, 123);
});

test('RS and RK send RS/RK (bug in 0.0.12: both sent RR)', async () => {
    plc.mem.SV[2] = 11; plc.mem.EV[2] = 22; plc.mem.SR[2] = 33;
    let o = await run({ type: 'mewtocol-rs', startaddress: '2', endaddress: '2' }, {});
    assert.equal(o.ok[0].payload, 11);
    o = await run({ type: 'mewtocol-rk', startaddress: '2', endaddress: '2' }, {});
    assert.equal(o.ok[0].payload, 22);
    o = await run({ type: 'mewtocol-rr', startaddress: '2', endaddress: '2' }, {});
    assert.equal(o.ok[0].payload, 33);
});

test('RCS / RCC / RCP / RT', async () => {
    plc.mem.R[100] = 1 << 10;
    plc.mem.X[3] = 0x00F0;
    let o = await run({ type: 'mewtocol-rcs', area: 'R', address: '100A' }, {});
    assert.equal(o.ok[0].payload, 1);
    o = await run({ type: 'mewtocol-rcs', area: 'R', address: '100A', boolean: true }, {});
    assert.equal(o.ok[0].payload, true);
    o = await run({ type: 'mewtocol-rcc', area: 'X', startaddress: '3', endaddress: '3', datatype: 'hex' }, {});
    assert.equal(o.ok[0].payload, '00F0');
    o = await run({ type: 'mewtocol-rcp', addresses: 'R100A, X34, X30', outputformat: 'object' }, {});
    assert.deepEqual(o.ok[0].payload, { R100A: 1, X34: 1, X30: 0 });
    o = await run({ type: 'mewtocol-rcp', addresses: '' }, { addresses: ['R100A', 'R1009'] });
    assert.deepEqual(o.ok[0].payload, [1, 0]);
    o = await run({ type: 'mewtocol-rt' }, {});
    assert.equal(o.ok[0].payload.mode, 'RUN');
    assert.equal(o.ok[0].payload.cputype, '05');
});

test('write nodes: WD, WCS, WCC, WS, WK', async () => {
    let o = await run({ type: 'mewtocol-wd', area: 'D', startaddress: '200', datatype: 'float32' }, { payload: [1.5, -2] });
    assert.equal(o.err.length, 0, o.err[0] && o.err[0].error);
    assert.deepEqual(o.ok[0].payload, [1.5, -2]);
    assert.equal(o.ok[0].mewtocol.end, 203);
    o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '200', endaddress: '203', datatype: 'float32' }, {});
    assert.deepEqual(o.ok[0].payload, [1.5, -2]);

    await run({ type: 'mewtocol-wcs', area: 'Y', address: '1F' }, { payload: true });
    assert.equal(plc.mem.Y[1], 0x8000);
    await run({ type: 'mewtocol-wcs', area: 'Y', address: '1F' }, { payload: 'off' });
    assert.equal(plc.mem.Y[1], 0);

    await run({ type: 'mewtocol-wcc', area: 'R', startaddress: '20', datatype: 'hex' }, { payload: ['ABCD'] });
    assert.equal(plc.mem.R[20], 0xABCD);
    await run({ type: 'mewtocol-ws', startaddress: '7' }, { payload: 300 });
    assert.equal(plc.mem.SV[7], 300);
    await run({ type: 'mewtocol-wk', startaddress: '7' }, { payload: 3 });
    assert.equal(plc.mem.EV[7], 3);
});

test('RAW node', async () => {
    plc.mem.D[0] = 1;
    const o = await run({ type: 'mewtocol-raw' }, { payload: '#RDD0000000000' });
    assert.equal(o.ok[0].payload, 'RD0100');
});

test('errors go to output 2 with error text and code, and to Catch', async () => {
    let o = await run({ type: 'mewtocol-rd', area: 'D', startaddress: '', endaddress: '' }, { payload: 1, foo: 'bar' });
    assert.equal(o.ok.length, 0);
    assert.equal(o.err[0].errorCode, 'EPARAM');
    assert.equal(o.err[0].foo, 'bar');
    assert.match(o.err[0].error, /Missing start address/);

    o = await run({ type: 'mewtocol-raw', sendonerror: true }, { payload: 'ZZ' });
    assert.equal(o.ok[0].payload, '');
    assert.equal(o.err[0].errorCode, 'EPLC');
    assert.equal(o.err[0].plcErrorCode, 42);
});

test('nodes of one config share a single TCP connection', async () => {
    const before = plc.connections;
    const flow = [cfg()];
    for (let i = 0; i < 5; i++) flow.push({ id: 'r' + i, type: 'mewtocol-rd', server: 'c1', station: 1, area: 'D', startaddress: String(i), endaddress: String(i), wires: [['ok'], []] });
    flow.push({ id: 'ok', type: 'helper' });
    await helper.load(nodeFiles, flow);
    const got = [];
    helper.getNode('ok').on('input', m => got.push(m));
    for (let k = 0; k < 4; k++) for (let i = 0; i < 5; i++) helper.getNode('r' + i).receive({});
    const t0 = Date.now();
    while (got.length < 20 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10));
    assert.equal(got.length, 20);
    assert.equal(plc.connections - before, 1);
});

test('a 0.0.12 flow (no new config fields) still works', async () => {
    plc.mem.D[1] = 9;
    const flow = [
        { id: 'c1', type: 'mewtocol-client', name: '', host: '127.0.0.1', port: String(plc.port), timeout: '500' },
        { id: 'n1', type: 'mewtocol-rd', name: '', server: 'c1', station: 1, area: 'D', startaddress: '1', endaddress: '1', sendonerror: true, wires: [['ok'], ['err']] },
        { id: 'ok', type: 'helper' }, { id: 'err', type: 'helper' }
    ];
    await helper.load(nodeFiles, flow);
    const p = new Promise(r => helper.getNode('ok').on('input', r));
    helper.getNode('n1').receive({ payload: true });
    assert.equal((await p).payload, 9);
});

test('missing config node gives a clean error instead of a crash', async () => {
    const flow = [
        { id: 'n1', type: 'mewtocol-rt', server: 'nope', station: 1, wires: [[], ['err']] },
        { id: 'err', type: 'helper' }
    ];
    await helper.load(nodeFiles, flow);
    const p = new Promise(r => helper.getNode('err').on('input', r));
    helper.getNode('n1').receive({});
    assert.equal((await p).errorCode, 'ECONFIG');
});
