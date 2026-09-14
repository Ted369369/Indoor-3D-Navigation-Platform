# MQTT topics

All MQTT topics the project uses: who sends them, QoS, retain flag, how
often, and what the payload looks like.

- **Broker**: HiveMQ Cloud. TLS on `8883` for the firmware and engine, WebSocket over TLS on `8884` for the web app.
- **Namespace**: everything lives under `libnav/`.
- **Encoding**: payloads are UTF-8. JSON unless noted as a plain string.
- **Placeholders**: `<DEVICE_ID>` = ESP node id (e.g. `NAV-001`, `NAV-REF`);
  `<uid>` = a web-app user id (Supabase auth uid, or a random uuid in solo mode);
  `<lib>` = a library id from `web/data/libraries.json` (`main` = Taipei,
  `yorba-linda` = Yorba Linda).
- **Several libraries share one broker.** Sensors put their library in `site`,
  phones put theirs in `lib`. Anything missing either field counts as `main`,
  so older firmware keeps working in Taipei.

## Actors

| Actor | Publishes | Subscribes |
|---|---|---|
| **ESP8266 node** (firmware) | `dev/<id>/telemetry`, `dev/<id>/status`, `dev/<id>/init` | nothing |
| **Position engine** (Python) | `user/<uid>/pos`, `user/<uid>/control`, `directory`, `capacity`, `engine/status` | `dev/+/telemetry`, `dev/+/status`, `dev/+/init`, `user/+/gps`, `user/+/pair`, `user/+/floor`, `user/+/presence`, `site/+/anchors` |
| **Web app** (phone/browser) | `user/<uid>/gps`, `user/<uid>/pair`, `user/<uid>/floor`, `user/<uid>/presence`, `user/<uid>/echo`, `site/<lib>/anchors` | `user/<uid>/pos`, `user/<uid>/control`, `user/<uid>/echo`, `directory`, `capacity`, `engine/status`, `dev/+/telemetry`, and per-friend `user/<friendUid>/pos` + `user/<friendUid>/presence` |

---

## Topic summary

| Topic | Payload | QoS | Retain | Rate | From → To |
|---|---|---|---|---|---|
| `libnav/dev/<id>/telemetry` | JSON | 0 | no | 2 Hz | node → engine |
| `libnav/dev/<id>/status` | `online`/`offline` | 1 | yes | on change (LWT) | node → engine, web |
| `libnav/dev/<id>/init` | JSON | 0 | yes | once per boot | node → engine |
| `libnav/user/<uid>/gps` | JSON | 0 | no | ~1 Hz | web → engine |
| `libnav/user/<uid>/pair` | JSON / empty | 1 | yes | on change | web → engine |
| `libnav/user/<uid>/floor` | JSON / empty | 1 | yes | on change | web → engine |
| `libnav/user/<uid>/presence` | `online`/`offline` | 1 | yes | on change (LWT) | web → engine, friends |
| `libnav/user/<uid>/echo` | JSON | 0 | no | 0.2 Hz | web → self (latency) |
| `libnav/user/<uid>/pos` | JSON | 0 | yes | 2 Hz | engine → web (self + friends) |
| `libnav/user/<uid>/control` | JSON | 1 | no | on event | engine → web |
| `libnav/site/<lib>/anchors` | JSON | 1 | yes | on calibration | web → engine |
| `libnav/directory` | JSON | 0 | yes | on change / ≤10 s | engine → web |
| `libnav/capacity` | JSON | 0 | yes | on change | engine → web |
| `libnav/engine/status` | `online`/`offline` | 1 | yes | on change (LWT) | engine → web |

---

## Device topics

### `libnav/dev/<DEVICE_ID>/telemetry`
Barometric telemetry from an ESP node. Published at `PUBLISH_HZ` (2 Hz).

```json
{
  "id":   "NAV-001",   // device id (string)
  "role": "user",      // "user" | "reference"
  "site": "main",      // library id (SITE_ID in the firmware); missing = "main"
  "seq":  1234,         // monotonic sequence counter
  "p":    101325.00,    // pressure, pascals (median-of-5 filtered)
  "t":    24.5,         // temperature, °C
  "rssi": -58,          // Wi-Fi signal, dBm
  "up":   395011         // millis() since boot
}
```
QoS 0, not retained. Consumed by the engine: `reference` role feeds the
weather-drift baseline for its own library; `user` role drives per-user floor
detection.

### `libnav/dev/<DEVICE_ID>/status`
Presence. Retained so subscribers learn the last known state immediately.

- Payload: `online` or `offline` (plain string).
- `offline` is the MQTT **Last Will** (QoS 1, retain), delivered by the broker
  if the node drops. `online` is published by the node on connect (retained).

### `libnav/dev/<DEVICE_ID>/init`
Boot message, published **once per power-up**, on the first successful
MQTT connect. Retained. Lets the engine/web confirm a node booted and see why
it last restarted.

```json
{
  "id":    "NAV-001",
  "role":  "user",
  "site":  "main",
  "event": "boot",
  "fw":    "Jul 22 2026 13:05:11",  // firmware build stamp (__DATE__ __TIME__)
  "ip":    "192.168.1.42",
  "mac":   "A4:CF:12:34:56:78",
  "rst":   "Power on",               // ESP.getResetReason()
  "rssi":  -58,
  "heap":  41200,                    // free heap, bytes
  "up":    1503                       // millis() at send
}
```

---

## User topics (web app ↔ engine)

### `libnav/user/<uid>/gps`
Phone location. Published ~1 Hz (`gpsPublishHz`) while a fix is available.

```json
{ "lat": 25.029137, "lng": 121.53819, "acc": 12.0, "ts": 1721631000000, "lib": "main" }
```
`acc` = accuracy radius in metres; `ts` = epoch ms; `lib` = the library the
visitor picked. QoS 0, not retained. If `lib` changes, the engine starts that
user's filter, floor and slot over in the new building.
The engine ignores fixes with `acc > 100` m.

### `libnav/user/<uid>/pair`
Sensor pairing claim. Retained so the engine keeps the claim across reconnects.

- Pair: `{ "device": "NAV-001", "lib": "main" }`
- Unpair: **empty payload** (clears the retained claim).

The engine enforces exclusivity and replies on `.../control` with `pair_ok`
or `pair_denied`. A sensor from a different library is refused too.

### `libnav/user/<uid>/floor`
Manual floor for GPS-only mode. Retained.

- Set: `{ "floor": 4, "lib": "main" }` (must be a floor of that library: 1 to 5 in Taipei, 1 or 2 in Yorba Linda).
- Clear (hand back to the barometric sensor): **empty payload**.

### `libnav/user/<uid>/presence`
Web-client presence. Retained. `offline` is the browser's Last Will (QoS 1),
`online` is published on connect. The engine frees the device/slot instantly on
`offline`; friends use it to show online state.

### `libnav/user/<uid>/echo`
Round-trip latency probe. The web app publishes `{ "t": <epoch ms> }` every 5 s
and subscribes to the **same** topic; the delay between send and receive is the
broker round-trip shown in the connection indicator. QoS 0, not retained.

### `libnav/user/<uid>/pos`
Fused position, published by the engine at 2 Hz. Retained so a client (or a
friend) that subscribes late immediately gets the last position.

```json
{
  "x": 26.5,           // local metres, 0–50 (west→east)
  "y": 19.0,           // local metres, 0–35 (drawing top→bottom)
  "z": 3.8,            // height in metres (floor's z)
  "floor": 2,          // integer level
  "q": {                // quality / provenance
    "gpsAcc": 12.0,     // GPS accuracy, m
    "pressureOk": true, // barometric floor detection active?
    "mode": "sensor",   // "sensor" | "manual" | "default"
    "rssi": -58,        // paired sensor signal, or null
    "snapDist": 1.4     // distance snapped onto the walk graph, m
  },
  "ts": 1721631000000
}
```

### `libnav/user/<uid>/control`
Engine → client control events. QoS 1, not retained.

```json
{
  "action": "admit",   // "admit" | "reject" | "pair_ok" | "pair_denied"
  "reason": "",         // e.g. "capacity", "in-use", "reference"
  "slots":  2,          // free capacity slots remaining
  "active": 3,          // active devices now
  "max":    5,          // MAX_ACTIVE_USERS
  "device": "",         // device id for pair_ok / pair_denied
  "ts": 1721631000000
}
```

| `action` | Meaning |
|---|---|
| `admit` | You hold one of the ≤5 live slots. |
| `reject` | At capacity; you are queued. Re-sent as a 5 s heartbeat. |
| `pair_ok` | Sensor `device` paired to you. |
| `pair_denied` | Pairing refused (`reason`: `in-use` = held by another visitor, `reference` = reference node, not selectable, `other-library` = the sensor belongs to another library). |

---

## Site / engine topics

### `libnav/site/<lib>/anchors`
Geo calibration broadcast by the web app when the user saves anchors, one topic
per library. Retained, so the engine picks it up on connect and applies it live.
The old unscoped `libnav/site/anchors` is still accepted and treated as Taipei.

```json
{
  "origin": { "lat": 25.0292947, "lng": 121.5379422 },  // NW corner → local (0,0)
  "xAxis":  { "lat": 25.0292947, "lng": 121.5384378 }   // NE corner → local (50,0)
}
```

### `libnav/directory`
List of sensors, published by the engine. The app's sensor picker is built
from it. Retained; republished only when something changes (or
at least every 10 s).

```json
{
  "devices": [
    {
      "id": "NAV-001",
      "role": "user",        // "user" | "reference"
      "site": "main",         // library the sensor belongs to
      "online": true,         // seen within PRESSURE_STALE_S (10 s)
      "rssi": -58,            // dBm, or null when offline
      "ageS": 1,              // seconds since last telemetry, or null
      "pairedBy": "uid-abc"   // uid currently holding it, or null
    }
  ],
  "ts": 1721631000000
}
```

### `libnav/capacity`
Live occupancy, broadcast to **all** clients. A dedicated **retained state**
topic (unlike the per-user `control` events), republished only when the numbers
change. Each library has its own `max` slots. The app shows its library's entry
in the "N/5" pill in the top bar.

```json
{
  "max": 5,
  "sites": {
    "main":        { "active": 3, "waiting": 1 },
    "yorba-linda": { "active": 0, "waiting": 0 }
  },
  "ts": 1721631000000
}
```

### `libnav/engine/status`
Engine presence. `online` on connect, `offline` via Last Will. QoS 1, retained.
The web app warns "position engine offline" when it sees `offline`.

---

## Notes

- **Wildcards**: the engine subscribes with `+` (single level), e.g.
  `libnav/dev/+/telemetry` matches every device. The web app subscribes to its
  own `<uid>` topics plus each accepted friend's `pos`/`presence`.
- **Retained topics** (`status`, `init`, `pair`, `floor`, `presence`, `pos`,
  `anchors`, `directory`, `capacity`, `engine/status`) always hold the latest value, so a
  late subscriber is immediately current. **Non-retained** streams
  (`telemetry`, `gps`, `echo`, `control`) are live-only.
- **Clearing a retained topic**: publish an empty payload with retain=true
  (used for `pair`/`floor` unpair/clear).
- **Last Will (LWT)** provides `offline` for `dev/<id>/status`,
  `user/<uid>/presence`, and `engine/status` so drops are detected without a
  clean disconnect.
- **Capacity**: the engine admits at most `MAX_ACTIVE_USERS` (default 5) per
  library via `control`; extra clients are queued and admitted automatically as
  slots free.

## Broker accounts

| Username | Used by | Minimum permission |
|---|---|---|
| `esp-node` | ESP8266 devices | publish `libnav/dev/#` |
| `engine` | position engine | publish + subscribe `libnav/#` |
| `webapp` | browsers | publish `libnav/user/#`, `libnav/site/#`; subscribe `libnav/#` |
