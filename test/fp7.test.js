'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MockPLC = require('./mock-plc');
const MewtocolClient = require('../lib/client');
const FP7 = require('../lib/fp7');

const M = FP7.DEFAULT_MAP;

/** Fill the mock PLC like the FP7 program does. tags: [index, name, key, value, status] */
function load(plc, tags) {
    const D = plc.mem.D;
    for (let i = 0; i < 1000; i++) { D[M.keys + i] = 0xFFFF; D[M.status + i] = 0xFFFF; }
    for (const [i, name, key, value, status] of tags) {
        D[M.actives + i] = 1;
        D[M.ports + i] = 1; D[M.idModbus + i] = 3; D[M.addrs + i] = 60 + i; D[M.types + i] = 5; D[M.divides + i] = 1;
        D[M.keys + i] = key & 0xFFFF;
        D[M.status + i] = status & 0xFFFF;
        const b = Buffer.alloc(4); b.writeFloatLE(value);
        D[M.values + 2 * i] = b.readUInt16LE(0); D[M.values + 2 * i + 1] = b.readUInt16LE(2);
        const base = M.names + i * M.nameStride;
        D[base] = 32; D[base + 1] = name.length;
        const raw = Buffer.alloc(32); raw.write(name, 'latin1');
        for (let k = 0; k < 16; k++) D[base + 2 + k] = raw[2 * k] | (raw[2 * k + 1] << 8);
    }
}

const TAGS = [
    [1, 'AM-1-1', 150, 144370.4, 1], [2, 'AM-1-1', 151, 446.89, 1], [3, 'AM-1-1', 300, 28.5, 1], [4, 'AM-1-1', 303, 497.8, 1],
    [6, 'AM-1-2', 150, 55115.8, 1], [7, 'AM-1-2', 151, 140.42, 1], [8, 'AM-1-2', 300, 23.2, 1], [9, 'AM-1-2', 303, 496.3, 1],
    [20, 'ADL400_VP', 7, 231.2, 1], [21, 'ADL400_VP', 8, 229.9, 1], [22, 'ADL400_VP', 1, 1520.4, 1],
    [40, 'OFFLINE', 1, 12, 0], [41, 'NOT_YET', 2, 0, -1], [55, 'NOKEY', -1, 7.5, 1], [56, 'TWICE', 300, 20, 1], [57, 'TWICE', 300, 21, 1]
];

async function setup(frameMode) {
    const plc = new MockPLC();
    load(plc, TAGS);
    plc.mem.D[M.actives + 30] = 0; // inactive slot inside the range
    const port = await plc.listen();
    const client = new MewtocolClient({ host: '127.0.0.1', port, timeout: 2000, frameMode: frameMode || 'standard' });
    return { plc, port, client };
}

test('planRanges merges small gaps', () => {
    assert.deepEqual(FP7.planRanges([1, 2, 3, 9, 30, 31], 5), [[1, 9], [30, 31]]);
    assert.deepEqual(FP7.planRanges([5], 0), [[5, 5]]);
});

test('rounding to REAL precision', () => {
    const f = Math.fround(144370.4);
    assert.notEqual(f, 144370.4);
    assert.equal(FP7.roundValue(f, 'auto'), 144370.4);
    assert.equal(FP7.roundValue(Math.fround(446.89), 'auto'), 446.89);
    assert.equal(FP7.roundValue(Math.fround(446.89), 1), 446.9);
    assert.equal(FP7.roundValue(null, 'auto'), null);
});

test('key catalogue: built-in and unit_keys.csv', () => {
    const c = new FP7.KeyCatalog();
    assert.equal(c.get(1).key, 'kWh');
    assert.equal(c.get(7).key, 'U1');
    assert.equal(c.get(150).key, 'A_Nm3');
    const csv = '﻿Code,Key,Unit,Quantity,Group,Kind,Decimals\r\n-1,NONE,,Chưa gán,Chung,I,0\r\n150,m3Air,Nm3,Air,Khí nén,C,1\r\n';
    const u = FP7.KeyCatalog.fromCsv(csv);
    assert.equal(u.get(150).key, 'm3Air');
    assert.equal(u.size, 1);
});

for (const frameMode of ['standard', 'extended']) {
    test('read tag list and values (' + frameMode + ' frame)', async () => {
        const { plc, client } = await setup(frameMode);
        try {
            const cfg = await FP7.readConfig(client, { station: 'EE', details: true });
            assert.equal(cfg.tags.length, TAGS.length);
            const t20 = cfg.tags.find(t => t.index === 20);
            assert.deepEqual([t20.name, t20.key, t20.port, t20.slaveId, t20.address, t20.type], ['ADL400_VP', 7, 1, 3, 80, 'Float']);
            FP7.resolveKeys(cfg, new FP7.KeyCatalog(), {});
            const values = await FP7.readValues(client, cfg, { station: 'EE', decimals: 'auto' });
            const payload = FP7.buildPayload(values, { format: 'device' });
            assert.deepEqual(payload['AM-1-1'], { A_Nm3: 144370.4, A_Nm3h: 446.89, TEMP: 28.5, P_kPa: 497.8, connect: true });
            assert.deepEqual(payload.ADL400_VP, { U1: 231.2, U2: 229.9, kWh: 1520.4, connect: true });
            assert.deepEqual(payload.OFFLINE, { kWh: null, connect: false });
            assert.deepEqual(payload.NOT_YET, { kW: null, connect: null });
            assert.deepEqual(payload.NOKEY, { tag55: 7.5, connect: true });
            assert.deepEqual(payload.TWICE, { TEMP: 20, TEMP_2: 21, connect: true });
            // only actives + per-tag ranges are read: no full 18000-word name scan
            const reads = plc.requests.filter(r => r.includes('RDD'));
            assert.ok(reads.length < (frameMode === 'standard' ? 90 : 20), reads.length + ' read commands');
        } finally {
            await client.close();
            await plc.close();
        }
    });
}

test('key map, formats and offline handling', async () => {
    const { plc, client } = await setup();
    try {
        const cfg = await FP7.readConfig(client, {});
        FP7.resolveKeys(cfg, new FP7.KeyCatalog(), { A_Nm3: 'm3Air', 151: 'flowAir', TEMP: 'temp', P_kPa: 'press', 'AM-1-2.temp': 'x', 'AM-1-2.TEMP': 'tempIn' });
        let values = await FP7.readValues(client, cfg, { decimals: 'auto' });
        let p = FP7.buildPayload(values, {});
        assert.deepEqual(p['AM-1-1'], { m3Air: 144370.4, flowAir: 446.89, temp: 28.5, press: 497.8, connect: true });
        assert.deepEqual(p['AM-1-2'], { m3Air: 55115.8, flowAir: 140.42, tempIn: 23.2, press: 496.3, connect: true });
        const tb = FP7.buildPayload(values, { format: 'thingsboard', ts: 5 });
        assert.deepEqual(tb['AM-1-2'][0].ts, 5);
        const flat = FP7.buildPayload(values, { format: 'flat' });
        assert.equal(flat['AM-1-1.m3Air'], 144370.4);
        const list = FP7.buildPayload(values, { format: 'list' });
        assert.equal(list.find(x => x.index === 20).keyName, 'U1');
        assert.deepEqual(FP7.buildPayload(values, { onDisconnect: 'omit' }).OFFLINE, { connect: false });
        values = await FP7.readValues(client, cfg, { onDisconnect: 'keep', decimals: 'auto' });
        assert.equal(FP7.buildPayload(values, {}).OFFLINE.kWh, 12);
        // one tag of a device offline -> whole device connect:false
        plc.mem.D[M.status + 2] = 0;
        values = await FP7.readValues(client, cfg, { decimals: 'auto' });
        p = FP7.buildPayload(values, {});
        assert.equal(p['AM-1-1'].connect, false);
        assert.equal(p['AM-1-1'].flowAir, null);
        assert.equal(p['AM-1-1'].m3Air, 144370.4);
        assert.match(FP7.configToCsv(cfg), /index,device,key,keyName,outKey/);
    } finally {
        await client.close();
        await plc.close();
    }
});

/* ------------------------------------------------------------------ Node-RED node */
const helper = require('node-red-node-test-helper');
helper.init(require.resolve('node-red'));
const fp7Node = require('../mewtocol/mewtocol-fp7.js');

test('mewtocol-fp7 node: tag list on deploy, telemetry, reload, cache when offline', async () => {
    const { plc, port, client } = await setup();
    await client.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp7-'));
    await new Promise(r => helper.startServer(r));
    helper.settings({ userDir: dir });
    try {
        const flow = [
            { id: 'n1', type: 'mewtocol-fp7', host: '127.0.0.1', port: String(port), timeout: '2000', station: 'EE',
              format: 'device', keymap: 'A_Nm3=m3Air\nA_Nm3h=flowAir\nTEMP=temp\nP_kPa=press', decimals: 'auto', refresh: '600',
              readstatus: true, ondisconnect: 'null', wires: [['out'], ['cfg'], ['err']] },
            { id: 'out', type: 'helper' }, { id: 'cfg', type: 'helper' }, { id: 'err', type: 'helper' }
        ];
        await helper.load(fp7Node, flow);
        const next = (id) => new Promise(r => helper.getNode(id).once('input', r));

        let p = next('out');
        helper.getNode('n1').receive({ topic: 'poll' });
        let msg = await p;
        assert.deepEqual(msg.payload['AM-1-1'], { m3Air: 144370.4, flowAir: 446.89, temp: 28.5, press: 497.8, connect: true });
        assert.deepEqual(msg.payload['AM-1-2'], { m3Air: 55115.8, flowAir: 140.42, temp: 23.2, press: 496.3, connect: true });
        assert.deepEqual(msg.payload.ADL400_VP, { U1: 231.2, U2: 229.9, kWh: 1520.4, connect: true });
        assert.equal(msg.fp7.tags, TAGS.length);
        assert.equal(msg.fp7.disconnected, 1);
        const cache = path.join(dir, 'mewtocol-fp7', '127.0.0.1_' + port + '.json');
        assert.ok(fs.existsSync(cache), 'tag list cached');

        // second poll must not re-read the tag list
        const before = plc.requests.length;
        p = next('out');
        helper.getNode('n1').receive({});
        await p;
        assert.ok(plc.requests.length - before <= 10, 'poll reads only values + status: ' + (plc.requests.length - before));

        // a poll while the previous one is still running is skipped, not queued
        plc.opts.delay = 100;
        p = next('out');
        helper.getNode('n1').receive({});
        helper.getNode('n1').receive({});
        helper.getNode('n1').receive({});
        msg = await p;
        await new Promise(r => setTimeout(r, 300));
        assert.equal(helper.getNode('n1').skipped, 2);
        assert.equal(helper.getNode('n1').client.queueLength, 0);
        plc.opts.delay = 0;

        // the configurator renames a device -> reload
        load(plc, [[20, 'ADL400_MAIN', 7, 231.2, 1]]);
        p = next('cfg');
        helper.getNode('n1').receive({ topic: 'reload' });
        msg = await p;
        assert.ok(msg.payload.tags.some(t => t.device === 'ADL400_MAIN'));
        assert.match(msg.csv, /ADL400_MAIN/);

        p = next('out');
        helper.getNode('n1').receive({ format: 'thingsboard' });
        msg = await p;
        assert.ok(Array.isArray(msg.payload.ADL400_MAIN));

        // PLC offline: start from the cached tag list, telemetry fails to output 3
        await helper.unload();
        await plc.close();
        await helper.load(fp7Node, flow);
        p = next('err');
        helper.getNode('n1').receive({ foo: 1 });
        msg = await p;
        assert.equal(msg.foo, 1);
        assert.ok(msg.error);
    } finally {
        await helper.unload();
        await new Promise(r => helper.stopServer(r));
        await plc.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
