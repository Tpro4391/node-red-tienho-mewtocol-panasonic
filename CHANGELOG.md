# Changelog

## 1.0.0

First release as **@tpro4391/node-red-tienho-mewtocol-panasonic** (fork of node-red-contrib-mewtocol 0.0.12; node type names unchanged).

### Architecture
- New built-in protocol stack in `lib/` (`protocol.js`, `connection.js`, `client.js`); dependency on `jsmewtocol`
  (and the unnecessary `net` / `events` npm packages) removed – the package has no runtime dependencies.
- The config node now owns **one persistent TCP connection** shared by all nodes, with a strict FIFO queue
  (MEWTOCOL allows one outstanding command per link). 0.0.x opened and closed a socket for every message,
  which exhausts the few connections an ET-LAN unit accepts.
- Automatic reconnect with exponential back-off (2 s → 30 s), fail-fast while the PLC is unreachable,
  bounded queue (`EQUEUEFULL`), one transparent retry when a reused socket was silently dropped by the PLC.
- Optional "close when idle" mode for PLCs that must be shared with other clients.

### Protocol
- CR-delimited stream parser: works no matter how TCP splits the data (0.0.x failed on fragmented packets).
- Multi-frame (`&`) responses reassembled correctly (0.0.x cut 3 data characters off the first frame).
- Real BCC on every command and verification of every response (option to disable).
- Response validation: header, station, command code, word count.
- Large reads/writes are split into commands that each fit one frame (standard `%` or extended `<`).
- Per-request timer is cleared correctly; no listener leaks; late answers after a timeout cannot desync the stream.
- `error` events are no longer emitted (an unhandled `error` event crashes Node.js).

### Nodes
- New: **WD, WCC, WCS, WS, WK** (write), **RCP** (multi-contact read, fixed `split()` bug of jsmewtocol), **RAW**.
- RCS supports T and C contacts.
- Data types for word nodes: int16 (default), uint16, int32, uint32, float32, hex, bits, string.
- Options: *Always output an array*, *Output true/false* for contacts, RCP output as array or object.
- Errors go to output 2 as a copy of the input message with `error`, `errorCode`, `plcErrorCode`,
  and are reported to Catch nodes (`done(err)`).
- Uses the Node-RED ≥1.0 `send`/`done` API; nodes clean up on redeploy.
- Connection status (connected / connecting / disconnected) shown on every node.
- Editor: validation for station and addresses, descriptive labels (e.g. `RD D100-109`), full help text,
  fixed broken host regex and unclosed `<div>` in the config dialog.

### Bug fixes
- **RS and RK nodes sent the RR command** (read system registers) instead of RS/RK.
- `msg.startaddress = 0` (or station/area values that are falsy) was ignored and the node setting used instead.
- Missing / deleted config node caused a TypeError inside the input handler.
- Parameter errors only logged, never sent to the error output.
- Error output sent a bare `{error}` object instead of a message.
- `package.json`: invalid `main` entry and non-SPDX license id.

### Compatibility
- Node type names, property names and default output format (int16, single value unwrapped) are unchanged,
  so 0.0.12 flows work without modification. Old config nodes get BCC = on, keep-alive = on, standard frames.

## 0.0.12
- Original release by Oleg Aroslanov (read nodes RD, RCS, RCC, RT, RR, RS, RK).
