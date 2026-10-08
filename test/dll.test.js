'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MockPLC = require('./mock-plc');
const MewtocolClient = require('../lib/client');
const DLL = require('../lib/dll');

// A configuration shaped like a real DLL: one device per row, one logging file per quantity
const FIXTURE = {
    deviceName: 'DLL-TEST',
    triggers: [{ no: 1, name: '10min' }, { no: 4, name: '15 min' }],
    files: [
        { no: 1, name: 'Air_Gas_m3', trigger: 4 }, { no: 2, name: 'Air_Gas_flow', trigger: 4 },
        { no: 3, name: 'Air_Gas_temp', trigger: 4 }, { no: 4, name: 'Air_Gas_press', trigger: 4 }
    ],
    points: []
};
const DEVICES = 16;
for (let d = 1; d <= DEVICES; d++) {
    const name = 'AM-1-' + d;
    FIXTURE.points.push({ fileNo: 1, regNo: d, name, unitNo: d + 1, unit: 'm3', dataStyleCode: 4, scaleOn: true, scale: 0.1 });
    FIXTURE.points.push({ fileNo: 2, regNo: d, name, unitNo: d + 1, unit: 'm3/h', dataStyleCode: d === 3 ? 6 : 4, scaleOn: d !== 3, scale: 0.01 });
    FIXTURE.points.push({ fileNo: 3, regNo: d, name, unitNo: d + 1, unit: '°C', dataStyleCode: 0, scaleOn: true, scale: 0.1 });
    FIXTURE.points.push({ fileNo: 4, regNo: d, name, unitNo: d + 1, unit: 'kPa', dataStyleCode: 0, scaleOn: true, scale: 0.01 });
}
FIXTURE.points.forEach((p, i) => { p.slot = i + 1; });

// units 2..17 answer, except unit 3 (device AM-1-2) -> COM2 status bits in WR20..
const OFFLINE_UNIT = 3;
function setValues(plc) {
    for (let d = 1; d <= DEVICES; d++) {
        const unit = d + 1;
        if (unit !== OFFLINE_UNIT) plc.mem.R[20 + (unit >> 4)] |= 1 << (unit & 15);
    }
    const put32 = (dt, v) => { plc.mem.D[dt] = v & 0xFFFF; plc.mem.D[dt + 1] = (v >>> 16) & 0xFFFF; };
    const putF = (dt, f) => { const b = Buffer.alloc(4); b.writeFloatLE(f); plc.mem.D[dt] = b.readUInt16LE(0); plc.mem.D[dt + 1] = b.readUInt16LE(2); };
    for (let d = 1; d <= DEVICES; d++) {
        put32(DLL.dtAddress(1, d), 1230 + d);            // m3   x0.1
        if (d === 3) putF(DLL.dtAddress(2, d), 87.25);    // m3/h real number
        else put32(DLL.dtAddress(2, d), 8700 + d);        // m3/h x0.01
        plc.mem.D[DLL.dtAddress(3, d)] = d === 2 ? (-55 & 0xFFFF) : 305; // °C x0.1, signed
        plc.mem.D[DLL.dtAddress(4, d)] = 77;              // kPa x0.01
    }
}

async function setup() {
    const plc = new MockPLC();
    plc.dllImage = DLL.encodeConfig(FIXTURE);
    setValues(plc);
    const port = await plc.listen();
    const client = new MewtocolClient({ host: '127.0.0.1', port, timeout: 2000, maxReadWords: DLL.READ_LIMIT });
    return { plc, port, client };
}

test('DT address mapping follows the DLL manual', () => {
    assert.equal(DLL.dtAddress(1, 1), 0);
    assert.equal(DLL.dtAddress(1, 2), 2);
    assert.equal(DLL.dtAddress(1, 300), 598);
    assert.equal(DLL.dtAddress(2, 1), 1000);
    assert.equal(DLL.dtAddress(16, 300), 15598);
});

test('read plan respects the 26 word limit and contiguous ranges', () => {
    const pts = [1, 2, 3, 20, 21].map(r => ({ dt: DLL.dtAddress(1, r) }));
    const ranges = DLL.planReads(pts, 26);
    assert.deepEqual(ranges, [{ start: 0, end: 5 }, { start: 38, end: 41 }]);
    const many = Array.from({ length: 40 }, (_, i) => ({ dt: DLL.dtAddress(2, i + 1) }));
    for (const r of DLL.planReads(many, 26)) assert.ok(r.end - r.start + 1 <= 26);
});

test('value decoding for every data style', () => {
    const p = (dataType, extra) => Object.assign({ dataType, words: 2, scaleOn: false, scale: 1 }, extra);
    assert.equal(DLL.decodeValue(p('int16'), 0xFFFE, 0), -2);
    assert.equal(DLL.decodeValue(p('uint16'), 0xFFFE, 0), 65534);
    assert.equal(DLL.decodeValue(p('hex16'), 0xABC, 0), '0ABC');
    assert.equal(DLL.decodeValue(p('int32'), 0xFFFF, 0xFFFF), -1);
    assert.equal(DLL.decodeValue(p('uint32'), 0x0001, 0x0001), 65537);
    assert.equal(DLL.decodeValue(p('hex32'), 0x5678, 0x1234), '12345678');
    const b = Buffer.alloc(4); b.writeFloatLE(30.5);
    assert.equal(DLL.decodeValue(p('float32'), b.readUInt16LE(0), b.readUInt16LE(2)), 30.5);
    assert.equal(DLL.decodeValue(p('int16', { scaleOn: true, scale: 0.1 }), 305, 0), 30.5);
    assert.equal(DLL.decodeValue(p('uint32', { scaleOn: true, scale: 0.01 }), 8701, 0), 87.01);
    assert.equal(DLL.decodeValue(p('uint32', { scaleOn: true, scale: 0.1 }), 3, 0, { applyScale: false }), 3);
});

test('configuration is read from the device with "<EE#3A" (128 KB, multi-frame)', async () => {
    const { plc, client } = await setup();
    try {
        const cfg = await DLL.readConfig(client);
        assert.equal(plc.requests[0].slice(0, 6), '<EE#3A');
        assert.equal(cfg.deviceName, 'DLL-TEST');
        assert.equal(cfg.files.length, 4);
        assert.equal(cfg.points.length, 64);
        const p = cfg.points.find(x => x.fileNo === 3 && x.regNo === 1);
        assert.equal(p.unit, '°C');
        assert.equal(p.dataStyle, 'DEC1W');
        assert.equal(p.dt, 2000);
        assert.equal(cfg.points.find(x => x.fileNo === 2 && x.regNo === 3).dataStyle, 'Real number');
    } finally { await client.close(); await plc.close(); }
});

test('values -> telemetry payload (device, thingsboard, flat, list) with key map', async () => {
    const { plc, client } = await setup();
    try {
        const cfg = await DLL.readConfig(client);
        plc.requests.length = 0;
        const values = await DLL.readValues(client, cfg);
        // RD only, '%' header, never more than 26 words
        for (const f of plc.requests.filter(r => !r.includes('#RCC'))) {
            const m = /^%EE#RDD(\d{5})(\d{5})/.exec(f);
            assert.ok(m, 'unexpected request ' + f);
            assert.ok(+m[2] - +m[1] + 1 <= 26);
        }
        const keyMap = '°C=temp\nkPa=press';
        const dev = DLL.buildPayload(values, { keyMap });
        assert.deepEqual(dev['AM-1-1'], { m3: 123.1, 'm3/h': 87.01, temp: 30.5, press: 0.77, connect: true });
        assert.deepEqual(dev['AM-1-2'], { m3: null, 'm3/h': null, temp: null, press: null, connect: false });
        assert.equal(dev['AM-1-4'].temp, 30.5);
        assert.ok(plc.requests.some(r => r.startsWith('%EE#RCCR00200035')), 'status relays read');
        const keep = DLL.buildPayload(await DLL.readValues(client, cfg, { onDisconnect: 'keep' }), { keyMap });
        assert.deepEqual(keep['AM-1-2'], { m3: 123.2, 'm3/h': 87.02, temp: -5.5, press: 0.77, connect: false });
        const omit = DLL.buildPayload(await DLL.readValues(client, cfg, { onDisconnect: 'omit' }), { keyMap, onDisconnect: 'omit' });
        assert.deepEqual(omit['AM-1-2'], { connect: false });
        const noStatus = DLL.buildPayload(await DLL.readValues(client, cfg, { status: false }), { keyMap });
        assert.equal(noStatus['AM-1-1'].connect, undefined);
        assert.equal(dev['AM-1-3']['m3/h'], 87.25);
        assert.equal(Object.keys(dev).length, 16);

        const tb = DLL.buildPayload(values, { keyMap, format: 'thingsboard', ts: 1000 });
        assert.deepEqual(tb['AM-1-1'], [{ ts: 1000, values: { m3: 123.1, 'm3/h': 87.01, temp: 30.5, press: 0.77, connect: true } }]);
        const flat = DLL.buildPayload(values, { keyMap, format: 'flat' });
        assert.equal(flat['AM-1-16.press'], 0.77);
        const list = DLL.buildPayload(values, { format: 'list' });
        assert.equal(list.length, 64);
        assert.equal(list[0].key, 'm3');
        assert.equal(list[0].connect, true);
        const byFile = DLL.buildPayload(values, { keySource: 'file', keyMap: { Air_Gas_temp: 't' } });
        assert.equal(byFile['AM-1-1'].t, 30.5);
        assert.equal(byFile['AM-1-1'].Air_Gas_m3, 123.1);
        const sub = await DLL.readValues(client, cfg, { files: [3] });
        assert.equal(sub.length, 16);
    } finally { await client.close(); await plc.close(); }
});

test('configuration round-trips through JSON and CSV', () => {
    const cfg = DLL.decodeConfig(DLL.encodeConfig(FIXTURE));
    const fromJson = DLL.parseConfig(JSON.stringify(cfg));
    assert.deepEqual(fromJson.points, cfg.points);
    const fromCsv = DLL.parseConfig(DLL.configToCsv(cfg));
    assert.equal(fromCsv.points.length, 64);
    for (const k of ['fileNo', 'regNo', 'name', 'unit', 'dataStyleCode', 'dataType', 'words', 'scaleOn', 'scale', 'dt']) {
        assert.deepEqual(fromCsv.points.map(p => p[k]), cfg.points.map(p => p[k]), k);
    }
    // a hand-written CSV with only the essential columns
    const mini = DLL.parseConfig('fileNo,regNo,name,unit,dataStyle,scaleOn,scale\n3,1,TANK-1,°C,DEC1W,1,0.1\n');
    assert.equal(mini.points[0].dt, 2000);
    assert.equal(mini.points[0].dataType, 'int16');
});

/* ------------------------------------------------------------------ Node-RED node */
const helper = require('node-red-node-test-helper');
helper.init(require.resolve('node-red'));
const dllNode = require('../mewtocol/mewtocol-dll.js');

test('mewtocol-dll node: load config once, save it, output telemetry', async () => {
    const { plc, port } = await setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dll-'));
    const configfile = path.join(dir, 'dll.json');
    await new Promise(r => helper.startServer(r));
    try {
        const flow = [
            { id: 'n1', type: 'mewtocol-dll', host: '127.0.0.1', port: String(port), timeout: '2000', station: 'EE', configsource: 'auto', configfile,
              format: 'device', keysource: 'unit', keymap: '°C=temp\nkPa=press', applyscale: true, wires: [['out'], ['cfg'], ['err']] },
            { id: 'out', type: 'helper' }, { id: 'cfg', type: 'helper' }, { id: 'err', type: 'helper' }
        ];
        await helper.load(dllNode, flow);
        const n1 = helper.getNode('n1');
        const next = (id) => new Promise(r => helper.getNode(id).once('input', r));

        let p = next('out');
        n1.receive({ topic: 'poll' });
        let msg = await p;
        assert.deepEqual(msg.payload['AM-1-1'], { m3: 123.1, 'm3/h': 87.01, temp: 30.5, press: 0.77, connect: true });
        assert.equal(msg.payload['AM-1-2'].connect, false);
        assert.equal(msg.payload['AM-1-2'].m3, null);
        assert.equal(msg.dll.disconnected, 4);
        assert.equal(msg.dll.points, 64);
        assert.ok(fs.existsSync(configfile), 'config saved as JSON');
        assert.ok(fs.existsSync(path.join(dir, 'dll.csv')), 'config saved as CSV');
        assert.equal(plc.requests.filter(r => r.includes('#3A')).length, 1);

        p = next('cfg');
        n1.receive({ topic: 'config' });
        msg = await p;
        assert.equal(msg.payload.points.length, 64);
        assert.match(msg.csv, /fileNo,fileName,regNo,name/);

        p = next('out');
        n1.receive({ format: 'thingsboard' });
        msg = await p;
        assert.ok(Array.isArray(msg.payload['AM-1-5']));

        // redeploy: configuration comes from the saved file, no new transfer
        await helper.unload();
        await helper.load(dllNode, flow);
        p = next('out');
        helper.getNode('n1').receive({});
        msg = await p;
        assert.equal(msg.payload['AM-1-1'].temp, 30.5);
        assert.equal(plc.requests.filter(r => r.includes('#3A')).length, 1);

        // explicit reload
        p = next('cfg');
        helper.getNode('n1').receive({ topic: 'reload' });
        await p;
        assert.equal(plc.requests.filter(r => r.includes('#3A')).length, 2);

        // errors go to output 3
        await helper.unload();
        await plc.close();
        fs.rmSync(dir, { recursive: true, force: true });
        flow[0].configsource = 'dll';
        await helper.load(dllNode, flow);
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
