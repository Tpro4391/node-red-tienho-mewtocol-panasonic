'use strict';
/**
 * Persistent MEWTOCOL-COM over TCP transport.
 *
 *  - one TCP socket per PLC endpoint, shared by every request
 *  - strict FIFO queue: MEWTOCOL allows only one outstanding command per link
 *  - CR-delimited stream framing (independent of how TCP splits packets)
 *  - BCC generation / verification, multi-frame responses ('&' continuation)
 *  - per-request timeout; socket is reset after a timeout so late answers cannot desync the stream
 *  - automatic reconnect with exponential back-off (keepAlive mode) and fail-fast while the PLC is unreachable
 *  - bounded queue to protect memory when the PLC is offline
 *
 * Events: 'state' (state, error?)  state = 'connecting' | 'connected' | 'disconnected' | 'closed'
 *         'connect' ({host, port}), 'disconnect' (error?), 'tx' (frame), 'rx' (frame)
 * This class never emits 'error', so a missing listener can never crash the host process.
 */
const net = require('net');
const { EventEmitter } = require('events');
const P = require('./protocol');
const { MewtocolError } = P;

const DEFAULTS = {
    host: '127.0.0.1',
    port: 9094,
    timeout: 5000,
    frameMode: 'standard',
    bcc: true,
    keepAlive: true,
    reconnectInterval: 2000,
    maxReconnectInterval: 30000,
    failFastWindow: 1000,
    maxQueue: 100,
    maxRxBuffer: 16384
};

class MewtocolConnection extends EventEmitter {
    constructor(options) {
        super();
        const o = Object.assign({}, DEFAULTS);
        for (const k of Object.keys(options || {})) {
            if (options[k] !== undefined && options[k] !== null && !Number.isNaN(options[k])) o[k] = options[k];
        }
        this.host = o.host;
        this.port = o.port;
        this.timeout = o.timeout;
        this.connectTimeout = o.connectTimeout || o.timeout;
        this.frameMode = P.FRAME_MODES[o.frameMode] ? o.frameMode : 'standard';
        this.useBcc = o.bcc !== false;
        this.keepAlive = o.keepAlive !== false;
        this.reconnectInterval = o.reconnectInterval;
        this.maxReconnectInterval = o.maxReconnectInterval;
        this.failFastWindow = o.failFastWindow;
        this.maxQueue = o.maxQueue;
        this.maxRxBuffer = o.maxRxBuffer;
        this.maxReadWords = o.maxReadWords || 0;   // optional device limit (e.g. Data Logger Light: 26)
        this.maxWriteWords = o.maxWriteWords || 0; // optional device limit (e.g. Data Logger Light: 23)

        this.state = 'disconnected';
        this.lastError = null;
        this.stats = { requests: 0, errors: 0, timeouts: 0, connects: 0 };

        this.socket = null;
        this._rx = '';
        this._queue = [];
        this._busy = false;
        this._closed = false;
        this._pending = null;
        this._connectPromise = null;
        this._lastConnectFail = 0;
        this._lastConnectError = null;
        this._sockError = null;
        this._reconnectTimer = null;
        this._backoff = this.reconnectInterval;
    }

    get header() { return P.FRAME_MODES[this.frameMode].header; }
    get queueLength() { return this._queue.length + (this._pending ? 1 : 0); }

    _setState(state, error) {
        if (error) this.lastError = error;
        if (state === this.state && !error) return;
        this.state = state;
        this.emit('state', state, error || null);
    }

    /** Open the TCP connection (resolves immediately when already connected). */
    connect() {
        if (this._closed) return Promise.reject(new MewtocolError('Connection closed', 'ECLOSED'));
        if (this.socket && this.state === 'connected') return Promise.resolve();
        if (this._connectPromise) return this._connectPromise;
        this._clearReconnect();

        this._connectPromise = new Promise((resolve, reject) => {
            const sock = new net.Socket();
            this.socket = sock;
            this._rx = '';
            this._sockError = null;
            this._setState('connecting');
            let settled = false;
            const target = this.host + ':' + this.port;

            const fail = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._connectPromise = null;
                this._lastConnectFail = Date.now();
                this._lastConnectError = err;
                this._backoff = Math.min(this._backoff * 2, this.maxReconnectInterval);
                reject(err);
            };
            const timer = setTimeout(() => {
                fail(new MewtocolError('Connection timeout to ' + target, 'ETIMEDOUT'));
                sock.destroy();
            }, this.connectTimeout);

            sock.once('connect', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._connectPromise = null;
                this._lastConnectError = null;
                this._backoff = this.reconnectInterval;
                this.stats.connects++;
                sock.setNoDelay(true);
                sock.setKeepAlive(true, 10000);
                this._setState('connected');
                this.emit('connect', { host: this.host, port: this.port });
                resolve();
            });
            sock.on('data', (d) => this._onData(sock, d));
            sock.on('error', (err) => {
                this._sockError = err;
                fail(new MewtocolError('Cannot connect to ' + target + ': ' + err.message, 'ECONN', { cause: err }));
            });
            sock.on('close', () => this._onClose(sock));
            sock.connect({ host: this.host, port: this.port });
        });
        return this._connectPromise;
    }

    _onClose(sock) {
        if (sock !== this.socket) return;
        this.socket = null;
        this._rx = '';
        const cause = this._sockError;
        this._sockError = null;
        const err = cause
            ? new MewtocolError('Connection lost: ' + cause.message, 'ECONN', { retryable: true, cause })
            : new MewtocolError('Connection closed by peer', 'ECONN', { retryable: true });
        this._failPending(err);
        if (this._closed) {
            this._setState('closed');
            return;
        }
        this._setState('disconnected', this._lastConnectError || (cause ? err : null));
        this.emit('disconnect', cause || null);
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this._closed || !this.keepAlive || this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this.state !== 'connected') this.connect().catch(() => { /* close handler re-schedules */ });
        }, this._backoff);
        if (this._reconnectTimer.unref) this._reconnectTimer.unref();
    }

    _clearReconnect() {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    /** Destroy the current socket (used after timeouts/protocol errors to resynchronise). */
    _resetSocket() {
        if (this.socket) this.socket.destroy();
    }

    /**
     * Queue one command.
     * @param {string} station  2-char station field (see protocol.formatStation)
     * @param {{body:string, code:?string}} cmd
     * @returns {Promise<string>} response data (everything after the 2-char response code)
     */
    request(station, cmd) {
        if (this._closed) return Promise.reject(new MewtocolError('Connection closed', 'ECLOSED'));
        if (this._queue.length >= this.maxQueue) {
            return Promise.reject(new MewtocolError('Request queue full (' + this.maxQueue + ' pending)', 'EQUEUEFULL'));
        }
        return new Promise((resolve, reject) => {
            this._queue.push({ station, cmd, resolve, reject, attempts: 0 });
            this._drain();
        });
    }

    async _drain() {
        if (this._busy) return;
        this._busy = true;
        while (this._queue.length && !this._closed) {
            const job = this._queue.shift();
            try {
                job.resolve(await this._execute(job));
            } catch (err) {
                this.stats.errors++;
                job.reject(err);
            }
        }
        this._busy = false;
        if (!this.keepAlive && this.socket && !this._queue.length) {
            this.socket.end();
        }
    }

    async _execute(job) {
        for (;;) {
            if (this.state !== 'connected' || !this.socket) {
                const e = this._lastConnectError;
                if (!this._connectPromise && e && Date.now() - this._lastConnectFail < this.failFastWindow) {
                    throw new MewtocolError(e.message, e.code);
                }
                await this.connect();
            }
            try {
                return await this._transact(job);
            } catch (err) {
                // a reused socket may have been silently dropped by the PLC: retry once on a fresh one
                if (err.retryable && job.attempts++ < 1 && !this._closed) continue;
                throw err;
            }
        }
    }

    _transact(job) {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new MewtocolError('Not connected', 'ECONN', { retryable: true }));
                return;
            }
            const header = job.cmd.header || this.header; // a command may force '%' or '<'
            const frame = P.buildFrame(header, job.station, job.cmd.body, this.useBcc);
            this._pending = { job, resolve, reject, data: null, station: job.station, header, timer: null };
            this._armTimer();
            this.stats.requests++;
            this.emit('tx', frame);
            this.socket.write(frame, 'latin1');
        });
    }

    _armTimer() {
        const p = this._pending;
        if (!p) return;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => {
            this.stats.timeouts++;
            this._failPending(new MewtocolError('Timeout waiting for response from PLC (' + this.timeout + ' ms)', 'ETIMEDOUT'));
            this._resetSocket();
        }, this.timeout);
    }

    _failPending(err) {
        const p = this._pending;
        if (!p) return;
        clearTimeout(p.timer);
        this._pending = null;
        p.reject(err);
    }

    _resolvePending(value) {
        const p = this._pending;
        if (!p) return;
        clearTimeout(p.timer);
        this._pending = null;
        p.resolve(value);
    }

    _protocolError(message) {
        this._failPending(new MewtocolError(message, 'EPROTO'));
        this._resetSocket();
    }

    _onData(sock, chunk) {
        if (sock !== this.socket) return;
        this._rx += chunk.toString('latin1');
        let idx;
        while ((idx = this._rx.indexOf('\r')) >= 0) {
            const frame = this._rx.slice(0, idx).replace(/^\n+/, '');
            this._rx = this._rx.slice(idx + 1);
            if (frame) this._onFrame(frame);
        }
        if (this._rx.length > this.maxRxBuffer) {
            this._rx = '';
            this._protocolError('Receive buffer overflow (no frame delimiter)');
        }
    }

    _onFrame(raw) {
        const p = this._pending;
        this.emit('rx', raw);
        if (!p) return; // unsolicited / late frame: ignore
        let parts;
        try {
            parts = P.splitFrame(raw);
        } catch (e) {
            return this._protocolError(e.message);
        }
        if (this.useBcc && !P.checkBcc(parts.body, parts.bccText)) {
            this._failPending(new MewtocolError('BCC check failed for response "' + raw + '"', 'EBCC'));
            return this._resetSocket();
        }
        let body = parts.body;
        if (p.data === null) {
            if (body[0] !== '%' && body[0] !== '<') return this._protocolError('Unexpected response "' + raw + '"');
            const st = body.substr(1, 2);
            if (p.job.station !== 'EE' && st !== p.job.station) {
                return this._protocolError('Station mismatch: expected ' + p.job.station + ', got ' + st);
            }
            p.station = st;
            const type = body[3];
            if (type === '!') {
                const code = parseInt(body.substr(4, 2), 10);
                this._failPending(new MewtocolError('PLC returned error ' + code + ': ' + P.plcErrorText(code), 'EPLC', { plcCode: code }));
                return;
            }
            if (type !== '$') return this._protocolError('Unexpected response "' + raw + '"');
            const code = body.substr(4, 2);
            const expected = p.job.cmd.code;
            if (expected && code !== expected) {
                return this._protocolError('Unexpected response command ' + code + ' (expected ' + expected + ')');
            }
            p.data = body.slice(6);
            if (!expected) p.data = code + p.data;
        } else {
            if (body[0] === '%' || body[0] === '<') body = body.slice(3);
            p.data += body;
        }
        if (parts.continued) {
            this._armTimer();
            this.socket.write(P.buildNextFrameRequest(p.header, p.station, this.useBcc), 'latin1');
        } else {
            this._resolvePending(p.data);
        }
    }

    /** Close the connection permanently and reject everything queued. */
    close() {
        this._closed = true;
        this._clearReconnect();
        const err = new MewtocolError('Connection closed', 'ECLOSED');
        const queued = this._queue.splice(0);
        for (const j of queued) j.reject(err);
        this._failPending(err);
        const sock = this.socket;
        if (!sock) {
            this._setState('closed');
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const t = setTimeout(resolve, 1000);
            sock.once('close', () => { clearTimeout(t); resolve(); });
            sock.destroy();
        });
    }
}

MewtocolConnection.DEFAULTS = DEFAULTS;
module.exports = MewtocolConnection;
