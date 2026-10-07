'use strict';
/**
 * Minimal MEWTOCOL-COM PLC simulator over TCP, used by the test-suite.
 * Supports RD/WD, RCS/RCP/RCC, WCS/WCP/WCC, RS/WS, RK/WK, RR, RT,
 * BCC checking, multi-frame responses for '%' frames > 118 chars,
 * response fragmentation and fault injection.
 */
const net = require('net');
const { bcc } = require('../lib/protocol');

class MockPLC {
    constructor(opts) {
        this.opts = Object.assign({
            station: 1,
            chunk: 0,          // >0: split every response into chunks of this size (random if 'random')
            delay: 0,          // ms before answering
            silent: false,     // never answer (timeout tests)
            badBcc: false,     // answer with a wrong BCC
            dropAfter: 0,      // close the socket after N requests
            multiFrame: true,  // split long '%' responses into multiple frames
            maxConnections: 0, // >0: refuse (reset) connections beyond this number, like a real ET-LAN unit
            serial: false      // process commands one at a time across all connections (single PLC CPU)
        }, opts);
        this._serialChain = Promise.resolve();
        this.refused = 0;
        this.mem = {
            D: new Array(100000).fill(0), F: new Array(100000).fill(0), LD: new Array(10000).fill(0),
            X: new Array(1000).fill(0), Y: new Array(1000).fill(0), R: new Array(1000).fill(0), L: new Array(1000).fill(0),
            T: new Array(10000).fill(0), C: new Array(10000).fill(0),
            SV: new Array(10000).fill(0), EV: new Array(10000).fill(0), SR: new Array(1000).fill(0)
        };
        this.requests = [];
        this.connections = 0;
        this.activeConnections = 0;
        this.maxActiveConnections = 0;
        this.overlapViolations = 0;
        this.sockets = new Set();
    }

    listen() {
        return new Promise((resolve) => {
            this.server = net.createServer((s) => this._onConnection(s));
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(this.port);
            });
        });
    }

    close() {
        for (const s of this.sockets) s.destroy();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    dropAll() { for (const s of this.sockets) s.destroy(); }

    _onConnection(sock) {
        if (this.opts.maxConnections && this.activeConnections >= this.opts.maxConnections) {
            this.refused++;
            sock.on('error', () => {});
            sock.destroy();
            return;
        }
        this.connections++;
        this.activeConnections++;
        this.maxActiveConnections = Math.max(this.maxActiveConnections, this.activeConnections);
        this.sockets.add(sock);
        const state = { buf: '', busy: false, pendingFrames: null, count: 0 };
        sock.on('close', () => { this.activeConnections--; this.sockets.delete(sock); });
        sock.on('error', () => {});
        sock.on('data', (d) => {
            state.buf += d.toString('latin1');
            let i;
            while ((i = state.buf.indexOf('\r')) >= 0) {
                const frame = state.buf.slice(0, i);
                state.buf = state.buf.slice(i + 1);
                if (this.opts.serial) {
                    this._serialChain = this._serialChain.then(() => new Promise((res) => {
                        this._onFrame(sock, state, frame);
                        setTimeout(res, this.opts.delay || 0);
                    }));
                } else {
                    this._onFrame(sock, state, frame);
                }
            }
        });
    }

    _send(sock, text, done) {
        const go = () => {
            if (done) done();
            if (sock.destroyed) return;
            const n = this.opts.chunk;
            if (!n) return sock.write(text, 'latin1');
            let i = 0;
            const step = () => {
                if (i >= text.length || sock.destroyed) return;
                const size = n === 'random' ? 1 + Math.floor(Math.random() * 7) : n;
                sock.write(text.slice(i, i + size), 'latin1');
                i += size;
                setImmediate(step);
            };
            step();
        };
        if (this.opts.delay) setTimeout(go, this.opts.delay); else go();
    }

    _frame(content, more) {
        const b = this.opts.badBcc ? (bcc(content) === '00' ? '01' : '00') : bcc(content);
        return content + b + (more ? '&' : '') + '\r';
    }

    _onFrame(sock, state, frame) {
        // continuation request: %01BCC& / %01**&
        if (state.pendingFrames && /^[%<]\d\d(..)&$/.test(frame)) {
            const next = state.pendingFrames.shift();
            if (!state.pendingFrames.length) state.pendingFrames = null;
            this._send(sock, next);
            return;
        }
        if (state.busy) this.overlapViolations++;
        state.busy = true;
        state.count++;
        this.requests.push(frame);
        const header = frame[0];
        const station = frame.substr(1, 2);
        const finish = (content) => {
            const full = header + station + content;
            const limit = header === '%' ? 118 : 2048;
            if (full.length + 3 > limit && this.opts.multiFrame) {
                const frames = [];
                let rest = full;
                let first = true;
                while (rest.length) {
                    const room = first ? limit - 4 : limit - 4 - 3;
                    const piece = rest.slice(0, room);
                    rest = rest.slice(room);
                    frames.push(this._frame(first ? piece : header + station + piece, rest.length > 0));
                    first = false;
                }
                state.pendingFrames = frames.slice(1);
                this._send(sock, frames[0], () => { state.busy = false; });
            } else {
                this._send(sock, this._frame(full, false), () => { state.busy = false; });
            }
            if (this.opts.dropAfter && state.count >= this.opts.dropAfter) {
                setTimeout(() => sock.destroy(), (this.opts.delay || 0) + 20);
            }
        };
        if (this.opts.silent) { state.busy = false; return; }
        if (station !== String(this.opts.station).padStart(2, '0') && station !== 'EE') { state.busy = false; return; }
        const body = frame.slice(0, -2);
        const chk = frame.slice(-2);
        if (chk !== '**' && bcc(body) !== chk) return finish('!40');
        if (frame[3] !== '#') return finish('!41');
        try {
            finish(this._exec(frame.slice(4, -2)));
        } catch (e) {
            finish('!' + (e.code || 61));
        }
    }

    _words(arr, s, e) {
        if (s > e || e >= arr.length) throw { code: 61 };
        let out = '';
        for (let i = s; i <= e; i++) {
            const h = (arr[i] & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
            out += h.substr(2, 2) + h.substr(0, 2);
        }
        return out;
    }

    _store(arr, s, e, hex) {
        if (s > e || e >= arr.length || hex.length !== (e - s + 1) * 4) throw { code: 61 };
        for (let i = 0; i <= e - s; i++) arr[s + i] = parseInt(hex.substr(i * 4 + 2, 2) + hex.substr(i * 4, 2), 16);
    }

    _bitRef(area, addr) {
        if (area === 'T' || area === 'C') return { arr: this.mem[area], idx: parseInt(addr, 10), bit: -1 };
        return { arr: this.mem[area], idx: parseInt(addr.slice(0, 3), 10), bit: parseInt(addr[3], 16) };
    }

    _getBit(area, addr) {
        const r = this._bitRef(area, addr);
        if (!r.arr) throw { code: 61 };
        return r.bit < 0 ? (r.arr[r.idx] ? 1 : 0) : (r.arr[r.idx] >> r.bit) & 1;
    }

    _setBit(area, addr, v) {
        const r = this._bitRef(area, addr);
        if (!r.arr || r.bit < 0) throw { code: 61 };
        if (v) r.arr[r.idx] |= (1 << r.bit); else r.arr[r.idx] &= ~(1 << r.bit);
    }

    _exec(c) {
        const regArea = (a) => (a === 'L' ? this.mem.LD : this.mem[a]);
        let m;
        if ((m = /^RD([DLF])(\d{5})(\d{5})$/.exec(c))) return '$RD' + this._words(regArea(m[1]), +m[2], +m[3]);
        if ((m = /^WD([DLF])(\d{5})(\d{5})([0-9A-F]+)$/.exec(c))) { this._store(regArea(m[1]), +m[2], +m[3], m[4]); return '$WD'; }
        if ((m = /^RCS([XYRL]\d{3}[0-9A-F]|[TC]\d{4})$/.exec(c))) return '$RC' + this._getBit(m[1][0], m[1].slice(1));
        if ((m = /^RCP(\d)(.*)$/.exec(c))) {
            const n = +m[1];
            if (n < 1 || n > 8 || m[2].length !== n * 5) throw { code: 41 };
            let out = '';
            for (let i = 0; i < n; i++) out += this._getBit(m[2][i * 5], m[2].substr(i * 5 + 1, 4));
            return '$RC' + out;
        }
        if ((m = /^RCC([XYRL])(\d{4})(\d{4})$/.exec(c))) return '$RC' + this._words(this.mem[m[1]], +m[2], +m[3]);
        if ((m = /^WCS([YRL])(\d{3}[0-9A-F])([01])$/.exec(c))) { this._setBit(m[1], m[2], m[3] === '1'); return '$WC'; }
        if ((m = /^WCP(\d)(.*)$/.exec(c))) {
            const n = +m[1];
            if (n < 1 || n > 8 || m[2].length !== n * 6) throw { code: 41 };
            for (let i = 0; i < n; i++) {
                const a = m[2][i * 6];
                if (!'YRL'.includes(a)) throw { code: 61 };
                this._setBit(a, m[2].substr(i * 6 + 1, 4), m[2][i * 6 + 5] === '1');
            }
            return '$WC';
        }
        if ((m = /^WCC([YRL])(\d{4})(\d{4})([0-9A-F]+)$/.exec(c))) { this._store(this.mem[m[1]], +m[2], +m[3], m[4]); return '$WC'; }
        if ((m = /^R([SK])(\d{4})(\d{4})$/.exec(c))) return '$R' + m[1] + this._words(this.mem[m[1] === 'S' ? 'SV' : 'EV'], +m[2], +m[3]);
        if ((m = /^W([SK])(\d{4})(\d{4})([0-9A-F]+)$/.exec(c))) { this._store(this.mem[m[1] === 'S' ? 'SV' : 'EV'], +m[2], +m[3], m[4]); return '$W' + m[1]; }
        if ((m = /^RR0(\d{3})(\d{3})$/.exec(c))) return '$RR' + this._words(this.mem.SR, +m[1], +m[2]);
        if (c === 'RT') return '$RT' + '05' + '25' + '32' + '81' + '00' + '20' + '3412';
        throw { code: 42 };
    }
}

module.exports = MockPLC;
