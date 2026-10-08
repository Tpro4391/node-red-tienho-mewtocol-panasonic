# Changelog

## 1.3.0
- New **FP7 tags** node (`mewtocol-fp7`) for the FP7 dynamic Modbus master program of *FP7 Modbus Configurator*:
  reads the tag list (active flags, device names `STRING[32]`, unit keys, Modbus details) and polls `values` (REAL) +
  `status`, output grouped by device: `{"AM-1-1": {"U1": 231.2, "kWh": 1520.4, "connect": true}}`.
- Keys = key names of the configurator's unit key list (built-in, or `unit_keys.csv`), optional key map by name, code,
  `index:N` or `Device.key`; same key twice in a device → `key_2`.
- Only active tags are read; contiguous ranges are merged; standard or extended frame; tag list refreshed periodically,
  on `reload`, and cached on disk for offline start-up.
- Memory map configurable (defaults: actives DT1000, values DT8000, keys DT10000, status DT11000, names DT12000, 18 words/name).
- FP7 and DLL nodes: a poll that arrives while the previous one is still running is **skipped** (status
  "busy: n poll(s) skipped") instead of queued, so a slow PLC or a too short poll interval never makes data lag behind.
  Load test: 50 nodes × 100 tags, 1 s poll, 5 PLCs offline/silent → ~5 % CPU, ~250 MB RSS, event loop p99 14 ms.
- `lib/fp7.js` exported as `require('@tpro4391/node-red-tienho-mewtocol-panasonic').fp7`. Example flow `fp7-thingsboard`.

## 1.2.0
- DLL node: connection status per device, key `"connect": true/false`. Read from the DLL status relays
  (COM1: WR0-WR15, COM2: WR20-WR35, bit = Modbus unit no., as used by Configurator DL "Current value monitor").
- Values of devices that do not answer are sent as `null` by default (the DLL reports 0 in DT); options: keep / omit.
- `msg.dll.disconnected` = number of points whose device does not answer.

## 1.1.0
- New **DLL** node for Panasonic Data Logger Light: reads the logging configuration from the device
  (Configurator DL command `<EE#3A`, 128 KB setting memory), saves it as JSON/CSV, reads all registered points from
  DT (file N → DT(N-1)*1000, 2 words per point, max 26 words per command) and outputs telemetry JSON
  (device object, ThingsBoard gateway, flat or list) with a configurable key map (e.g. `°C=temp`).
- Editor button "Read config" lists device, files and units and pre-fills the key map.
- `lib/dll.js`: decode/encode of the DLL setting memory, JSON/CSV import/export, value decoding for all data styles
  (DEC1W, DEC1W(Unsigned), HEX4, DEC2W, DEC2W(Unsigned), HEX8, Real number) with scale factor.
- Connection: per-command header (`%` / `<`) and device word limits (`maxReadWords`, `maxWriteWords`).
- Example flow `dll-thingsboard`.

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
