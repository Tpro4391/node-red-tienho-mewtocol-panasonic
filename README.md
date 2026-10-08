# @tpro4391/node-red-tienho-mewtocol-panasonic

[![npm](https://img.shields.io/npm/v/@tpro4391/node-red-tienho-mewtocol-panasonic)](https://www.npmjs.com/package/@tpro4391/node-red-tienho-mewtocol-panasonic)

Panasonic PLC **MEWTOCOL-COM over TCP** for Node-RED (FP-X / FP-XH / FP0H / FP7 / FP-Sigma with ET-LAN,
or any serial-to-Ethernet converter in front of a MEWTOCOL port).

Reference: [Panasonic MEWTOCOL manual](https://mediap.industry.panasonic.eu/assets/custom-upload/Factory%20&%20Automation/PLC/Manuals/mn_all_plcs_mewtocol_user_pidsx_en.pdf)

## What's new in 1.0

- **One shared, persistent TCP connection per PLC** with a FIFO command queue (0.0.x opened a new socket for every message).
- Auto reconnect with back-off, fail-fast while the PLC is offline, bounded queue.
- Robust frame handling: CR-delimited stream parser, multi-frame responses, real **BCC** generation and verification.
- Large ranges are **split automatically** so every command fits a single frame (`%` 118 chars or `<` 2048 chars).
- **Write nodes**: WD, WCC, WCS, WS, WK. New read node: RCP. Raw command node.
- Data types: `int16`, `uint16`, `int32`, `uint32`, `float32`, `hex`, `bits`, `string`.
- Bug fixes: RS / RK sent the RR command, address `0` from `msg` was ignored, crashes when the config node was missing, ...
- No runtime dependencies (the `jsmewtocol` dependency is replaced by the built-in `lib/`).
- **Backwards compatible**: node types, properties and output format of 0.0.12 flows are unchanged.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Install

In your Node-RED user directory (usually `~/.node-red`):

    npm install @tpro4391/node-red-tienho-mewtocol-panasonic

or use *Menu → Manage palette → Install* and search for `tienho-mewtocol`. Restart Node-RED afterwards.

> This package is a reworked fork of [node-red-contrib-mewtocol](https://github.com/oleg31337/node-red-contrib-mewtocol)
> and uses the **same node types** (`mewtocol-rd`, ...), so existing flows keep working.
> Uninstall `node-red-contrib-mewtocol` first – both packages cannot be installed at the same time.

Requires Node-RED ≥ 2.0 and Node.js ≥ 14.

## Nodes

| Node | Command | Description |
|------|---------|-------------|
| **RD**  | `RD`  | Read data registers DT (D), link registers LD (L), file registers FL (F) |
| **RCC** | `RCC` | Read contact words X, Y, R, L |
| **RCS** | `RCS` | Read one contact bit X, Y, R, L, T, C |
| **RCP** | `RCP` | Read a list of contact bits, e.g. `X0, Y1A, R100F, T5` (auto split per 8) |
| **RS**  | `RS`  | Read timer/counter set values |
| **RK**  | `RK`  | Read timer/counter elapsed values |
| **RR**  | `RR`  | Read system registers |
| **RT**  | `RT`  | Read PLC status (type, version, RUN/PROG, error flags) |
| **WD**  | `WD`  | Write data / link / file registers |
| **WCC** | `WCC` | Write contact words Y, R, L |
| **WCS** | `WCS` | Write one contact bit Y, R, L |
| **WS**  | `WS`  | Write timer/counter set values |
| **WK**  | `WK`  | Write timer/counter elapsed values |
| **RAW** | any   | Send any command body, e.g. `RDD0000000009` |
| **DLL** | `#3A`, `RD` | Data Logger Light: load configuration, read all points, telemetry JSON (ThingsBoard) |

Every node has two outputs: **1 = result**, **2 = error**.

### Message properties

`msg.station`, `msg.area`, `msg.startaddress`, `msg.endaddress`, `msg.address`, `msg.addresses`, `msg.datatype`
override the node settings (`0` is a valid value). All other message properties are kept.

Read nodes put the data in `msg.payload` – a single value or an array (enable *Always output an array* to always get an array).
Write nodes take the data from `msg.payload` and pass the message on unchanged after the PLC acknowledged it.
Every result also carries `msg.mewtocol` (command, station, area, start, end, ...).

The error output receives a copy of the input message with `msg.error` (text), `msg.errorCode`
(`EPARAM`, `EPLC`, `ETIMEDOUT`, `ECONN`, `EBCC`, `EPROTO`, `EQUEUEFULL`, `ECLOSED`, `ECONFIG`) and,
for errors returned by the PLC, `msg.plcErrorCode` (e.g. 61 = data error, 66 = address error). Errors are also
reported to *Catch* nodes.

### Addresses

- Registers / words: decimal word number (`DT100` → area `D`, address `100`).
- Contact bits (X, Y, R, L): word + hexadecimal bit, e.g. `100A` = R100A (word 100, bit 10), `1F`, `5`.
- Timer / counter contacts (T, C): timer/counter number.
- 32-bit types use two consecutive words, low word first (Panasonic `DDT` order).

### Connection settings

| Setting | Default | |
|---------|---------|-|
| Host / Port | – / 9094 | PLC address |
| Timeout | 5000 ms | connect and response timeout |
| Frame | Standard `%` | `Extended <` = 2048 chars per frame, fewer round trips (FP-X, FP0R, FP7 ...) |
| BCC | on | compute and verify the block check code |
| Keep connection open | on | persistent socket + auto reconnect; off = close when idle |
| Max queue | 100 | waiting commands before `EQUEUEFULL` |

## Data Logger Light (DLL) → ThingsBoard

The **DLL** node reads the logging configuration of a Panasonic *Data Logger Light* (register names, units, data
styles, scale factors – the same data Configurator DL shows) and then polls the current value of every registered point.
Only the IP address is required.

1. Enter the DLL IP and press **Read config** in the edit dialog: device, logging files and units are listed and
   the key map is pre-filled.
2. On deploy the configuration is read **once** and saved as JSON + CSV
   (`<userDir>/mewtocol-dll/<ip>.json`). Later deploys reuse the file; send `msg.topic = "reload"` to read it again.
3. Every input message reads all points (file N, registration k → `DT[(N-1)*1000 + (k-1)*2]`, max 26 words per command)
   and outputs for example:

```json
{
  "AM-1-1": { "m3": 123, "m3/h": 87, "temp": 30.5, "press": 0.77 },
  "AM-1-2": { "m3": 125, "m3/h": 88, "temp": 31.5, "press": 0.55 }
}
```

Keys come from the unit (or the logging file name) and can be renamed with the key map, e.g. `°C=temp`, `kPa=press`.
Output formats: device object (above), **ThingsBoard gateway** (`{"AM-1-1":[{"ts":…,"values":{…}}]}` for MQTT topic
`v1/gateway/telemetry`), flat (`{"AM-1-1.m3":123}`) or a detailed list.
Example flow: *Import → Examples → dll-thingsboard*.

The configuration file can also be written by hand (CSV columns `fileNo,regNo,name,unit,dataStyle,scaleOn,scale`)
and selected with *Config = File only*.

Library use:

```js
const MewtocolClient = require('@tpro4391/node-red-tienho-mewtocol-panasonic');
const dll = require('@tpro4391/node-red-tienho-mewtocol-panasonic/lib/dll');
const plc = new MewtocolClient({ host: '192.168.31.112', maxReadWords: 26 });
const cfg = await dll.readConfig(plc);
const payload = dll.buildPayload(await dll.readValues(plc, cfg), { keyMap: '°C=temp,kPa=press' });
```

## Using the library without Node-RED

```js
const MewtocolClient = require('@tpro4391/node-red-tienho-mewtocol-panasonic');
const plc = new MewtocolClient({ host: '192.168.1.5', port: 9094, timeout: 3000 });

const words = await plc.readWords('RD', 1, 'D', 0, 9);          // raw uint16 words
await plc.writeWords('WD', 1, 'D', 100, [1, 2, 3]);
await plc.writeBit(1, 'R', '10', true);
const bits = await plc.readBits(1, ['X0', 'Y1A', 'R100F']);
const status = await plc.readStatus(1);
await plc.close();
```

The `jsmewtocol` style API (`new MewtocolClient(host, port, timeout)`, `RD`, `RCS`, `RCC`, `RS`, `RK`, `RR`, `RT`, `destroy`) is also available.

## Tests

    npm install
    npm test

The tests run against a built-in PLC simulator (`test/mock-plc.js`) including TCP fragmentation,
multi-frame responses, BCC errors, timeouts, dropped connections and a PLC that accepts only one socket.

## License

See [LICENSE](LICENSE). Based on [node-red-contrib-mewtocol](https://github.com/oleg31337/node-red-contrib-mewtocol) © Oleg Aroslanov (oleg31337), used under its MIT-style license with attribution. Version 1.0 rework by Tpro4391.
