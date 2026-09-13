# Engineering Troubleshooting Log

Every real problem hit while building this platform, what actually caused it, and
how it was fixed. Written as a working record — several of these had a plausible
wrong explanation that had to be discarded before the real cause appeared.

## Summary

| # | Area | Problem | Root cause | Commit |
|---|---|---|---|---|
| 1 | Backend | "All slots busy" with nobody connected | Capacity only re-evaluated on a user's *first* GPS fix | `8745c10` |
| 2 | Web | App stuck behind the capacity overlay | `[hidden]` silently overridden by author CSS | `475a278` |
| 3 | Web | Page dead when opened by double-click | `file://` blocks ES modules and `fetch` | `475a278` |
| 4 | Web | Map labels blurry | Low-resolution canvas textures with mipmaps | `0a382c8` |
| 5 | Web | Other floors still visible when one was picked | Floors dimmed to 7%, not hidden | `0a382c8` |
| 6 | Web | Marker never moved while walking | Marker fed only by the engine; none was running | `372b158` |
| 7 | Web | Library step would not submit | Hidden `required` input blocks form submit | `2ad22fa` |
| 8 | Web | Stale JS/model served after deploys | No cache revalidation on Pages or dev server | `2ad22fa` |
| 9 | Deploy | GitHub Pages action failed | `GITHUB_TOKEN` cannot enable Pages | `3f38b9a` |
| 10 | Security | Passwords one commit from going public | Credentials hardcoded in the tracked `.ino` | `33bab7f` |
| 11 | Toolchain | `Adafruit_Sensor.h: No such file` | Library not installed | — |
| 12 | Backend | `ConnectionRefusedError 10061` | No `.env`, **and** `python-dotenv` missing | `537522a` |
| 13 | Firmware | ESP would not join the phone hotspot | ESP8266 is 2.4 GHz / WPA2 only | `22c438d` |
| 14 | Firmware | BMP390 "not found" | Board-specific pins; only one I2C address probed | `e38eb1c` |
| 15 | Firmware | **Joins hotspot, then drops forever** | **CA cert in `PROGMEM` crashes BearSSL** | `6d0cba7` |
| 16 | Firmware | Boot message never arrived | PubSubClient 256-byte packet limit | `b39d7cf` |
| 17 | Web | Sensor never appeared in the app | `config.js` held placeholders, never pushed | `a519b3d` |

---

## Firmware (ESP8266 + BMP390)

### 15. The hard one — joins the hotspot, then disconnects and reconnects forever

**Symptom.** The node associated with the phone hotspot, then dropped and rejoined
endlessly. On the phone it looked like a flaky Wi-Fi client.

**Wrong theories, discarded in order:**

1. *Hotspot on 5 GHz / WPA3* — plausible for an ESP8266, but the node clearly did
   associate, so the network was reachable.
2. *Power brownout* — ruled out when `ESP.getResetReason()` reported `Exception`
   rather than `Power on` / `External System`.
3. *Out of memory* — ruled out by `free heap: 42976 bytes` at boot.

**How it was actually found.** Numbered `[stage] N` markers were printed before each
risky step. The serial log then read:

```
[bmp390] ready at 0x77          <- sensor fine
[wifi] connected ... rssi=-34   <- Wi-Fi fine
[time] epoch=1789273150         <- NTP fine
                                <- crash, before the [tls] banner ever printed
```

Exactly one statement sits between the NTP line and the TLS banner:
`BearSSL::X509List caCert(CA_CERT_PEM);`

**Root cause.** `CA_CERT_PEM` is declared `PROGMEM`. On the ESP8266 that flash
region only tolerates **32-bit aligned reads**, but BearSSL parses the PEM with
plain byte-wise pointer access, raising a `LoadStoreError` exception that reboots
the board — forever.

This also explains why the fault appeared *late* in the project. While `certs.h`
still held the placeholder, `isCaCertInstalled()` returned false and the code took
the `setInsecure()` path, never touching `X509List`. Pasting in the real
certificate was what first exercised the crashing path.

**Fix.** Copy the PEM into RAM with `memcpy_P` before parsing, then `free()` the
copy (`X509List` keeps its own parsed DER), and fall back to `setInsecure()` with a
stated reason instead of dying. `6d0cba7`

A second instance of the same bug class was removed in `6084a09`:
`isCaCertInstalled()` called `strstr_P()`, whose **first** argument must live in
RAM — handing it the PROGMEM certificate was the same unsafe flash read.

### TLS buffers do not fit in the ESP8266 heap

**Cause.** BearSSL defaults to 16 KB receive plus 16 KB transmit buffers; the
ESP8266 has roughly 40 KB of usable heap.

**Fix.** Probe the broker for Maximum Fragment Length Negotiation and size the
buffers accordingly. `b39d7cf`

> Measured result: **HiveMQ Cloud does not support MFLN**, so the fallback
> `setBufferSizes(4096, 1024)` is the branch that actually runs. Keeping that
> fallback is what makes the connection work — a 1024-byte receive buffer alone
> would have failed the handshake.

### 16. The boot message was silently never published

**Cause.** PubSubClient's default packet buffer is 256 bytes; the `init` payload
(248 bytes) plus its topic exceeds that, so `publish()` returned false and nothing
was transmitted — with no error anywhere.

**Fix.** `mqtt.setBufferSize(512)`. `b39d7cf`

### 14. BMP390 not detected

**Cause, in two parts:**

1. Wiring was documented with the board-specific `D1` / `D2` aliases, which bare
   ESP-12E modules do not define.
2. A comment claimed `begin_I2C()` "tries 0x77 then 0x76". It does not — Adafruit's
   call probes **only** the address it is given, so boards with `SDO` tied to GND
   (address 0x76) could never be found.

**Fix.** Generic `I2C_SDA_PIN` / `I2C_SCL_PIN` (GPIO4 / GPIO5) with an explicit
`Wire.begin(sda, scl)`, plus a real 0x77 to 0x76 fallback that logs the address it
initialised on. `e38eb1c`

**Diagnostic added.** `firmware/i2c_scanner/` checks idle SDA/SCL levels (verifying
the pull-ups), attempts a nine-clock bus recovery when SDA is stuck low, scans the
bus, and **reads the chip-ID register**. That last part matters: BMP280 and BME280
occupy the same 0x76/0x77 addresses, so an address acknowledgement is *not* proof
of a BMP390 — a common mix-up that produces an identical "not found" symptom.
`1bc8505`, `efdc53a`

### 13. Would not join the phone hotspot

**Cause.** The ESP8266 radio is **2.4 GHz and WPA2 only**. Phone hotspots often
default to 5 GHz or WPA3, so the network is not merely unreachable — it is
invisible to the chip.

**Fix.** On a failed join, scan and print every visible network with its channel and
RSSI, so "my hotspot is not in this list" becomes immediately obvious. `22c438d`
Practical resolution: enable *Maximize Compatibility* on iOS, or set the AP band to
2.4 GHz with WPA2 on Android.

---

## Backend (Python position engine)

### 12. `ConnectionRefusedError: [WinError 10061]`

**Cause, in two layers:**

1. `backend/.env` did not exist, so `MQTT_HOST` fell back to `localhost:8883` —
   nothing was listening there.
2. After creating `.env` it was *still* ignored, because `python-dotenv` was not
   installed and the import sat inside a silent `try / except ImportError: pass`.

**Fix.** A small built-in `.env` parser as a fallback, so the real broker
configuration is picked up whether or not `python-dotenv` is present (shell
variables still take precedence). `537522a`

**Lesson.** An optional dependency wrapped in a silent `except` converts a missing
package into a confusing misconfiguration with no error message.

### 1. "All slots busy" with nobody connected

**Symptom.** The capacity overlay appeared and never cleared, although nobody was
using the system.

**Cause.** Two compounding bugs:

- The engine re-evaluated admissions **only on a user's first GPS fix**. If a
  phone's GPS paused while slots freed, that client was never reconsidered and
  stayed rejected indefinitely.
- Stale users held their slots for the full 30-second window, and the simulator's
  users counted as real occupants.

**Fix.** Review capacity every tick (stale users release slots; waiting users are
admitted first-come-first-served), re-send `reject` as a five-second heartbeat
carrying live occupancy, release a slot immediately on the presence Last Will, and
let the web overlay self-clear when the heartbeat stops. `8745c10`

---

## Web application

### 2 and 3. The app was unusable on first open

**Symptom.** A permanent "All slots busy" screen, with the rest of the page dead.

**Cause — two independent bugs:**

1. The HTML `hidden` attribute works through the browser's built-in
   `display: none`, which **any author rule on the same element overrides**. The
   modals carried `display: grid`, so *every* modal rendered simultaneously and the
   capacity overlay — last in the DOM — covered everything.
2. The page had been opened by double-clicking `index.html`. Over `file://`,
   browsers block ES modules and `fetch`, so the application code never ran.

**Fix.** A global `[hidden] { display: none !important; }`, plus an inline guard
that detects `file://` and explains how to serve the folder instead. `475a278`

### 17. The phone never found the sensor

**Cause.** `web/config.js` still contained the placeholder broker host
(`xxxxxxxx.s1.eu.hivemq.cloud`) and password. The local file had been edited but
**never committed**, so GitHub Pages kept serving the placeholder — the phone was
dialling a hostname that does not exist.

**Fix.** Fill in the real endpoint and a **separate, least-privilege `webapp`
credential** with a password distinct from the firmware and engine one, then push.
`a519b3d`

> Architectural note that caused real confusion: the sensor picker is fed by
> `libnav/directory`, which is published by the **Python engine**, not by the ESP. A
> node can be publishing telemetry perfectly and still never appear in the app if
> the engine is not running.

### 4, 5 and 6. Rendering and positioning

- **Blurry labels.** Canvas textures were too low-resolution and mip-filtered.
  Fixed with 2x supersampling, maximum anisotropy and `LinearFilter` without
  mipmaps.
- **Floor focus.** Selecting a floor merely dimmed the others to 7% opacity instead
  of hiding them. Non-selected floors are now hidden outright, and during
  navigation only the floors the route crosses are shown, at raised transparency so
  the path reads through the slabs. `0a382c8`
- **Marker never moved.** The marker was driven solely by engine-fused positions, so
  with no engine running nothing happened. A client-side latitude/longitude to
  local-metre converter now drives it directly, with accuracy-weighted smoothing, a
  per-interval motion clamp (a single wild fix nudges it under 1.5 m instead of
  teleporting), rejection of fixes worse than 100 m, and snap-to-corridor once
  calibrated. `372b158`, `2ad22fa`

### 7. The library step would not submit

**Cause.** The display-name input is `required`, but it belongs to a *later* step
and is `hidden` while the library step is shown. Browsers refuse to submit a form
containing an invalid, non-focusable control — and do so **silently**. The button
simply appeared to do nothing.

**Fix.** Drop the HTML `required` and validate in JavaScript instead. `2ad22fa`

### 8. Stale assets after deployment

**Cause.** Neither GitHub Pages nor Python's `http.server` forces revalidation, so a
browser could mix a **new** `app.js` with an **old** `nav.js` or map model. During
testing this produced a genuine crash (`this.graphs[profile]` undefined) purely from
version skew.

**Fix.** A `?v=` query on the module imports, bumped whenever the structure changes,
and `cache: "no-cache"` on the JSON data fetches. `2ad22fa`

---

## Deployment and security

### 9. GitHub Pages deployment failed

**Cause.** The official `actions/configure-pages` step cannot create the Pages site
using the default `GITHUB_TOKEN`, which lacks the required admin rights.

**Fix.** Publish the `web/` folder to a `gh-pages` branch instead, which public
repositories serve automatically. `3f38b9a`

### 10. Credentials were one commit away from going public

**Symptom.** Real Wi-Fi and MQTT passwords had been typed directly into the tracked
`esp8266_bmp390.ino`.

**Checked first, and this mattered.** `git show HEAD:...` confirmed the *committed*
version still held only placeholders (`changeme`, `xxxxxxxx`). **Nothing had
actually leaked**, so neither a history rewrite nor credential rotation was needed.

**Fix.** Move credentials into a git-ignored `secrets.h`, ignore
`firmware/**/*.h` while keeping tracked `.h.example` templates, and untrack
`certs.h`. A pre-commit grep for the real strings now guards every commit.
`33bab7f`

> Worth recording: `certs.h` holds the **ISRG Root X1** certificate, which is a
> *public* Let's Encrypt root — not a secret at all. The genuinely sensitive
> material was in the `.ino`. Protecting the wrong file would have felt secure
> while still leaking the passwords.

---

## Debugging techniques that paid off

1. **Numbered boot stages.** Printing `[stage] 1..5` before each risky step turned
   an opaque reboot loop into "the last line printed is the culprit" — no exception
   decoder required. This is what located the PROGMEM crash.
2. **`ESP.getResetReason()` at boot.** Instantly separated a *crash* from a
   *brownout*, killing the power-supply theory that would otherwise have cost hours.
3. **Report the largest contiguous free block, not just free heap.** BearSSL needs
   one large contiguous allocation; a fragmented heap fails while total free memory
   still looks healthy.
4. **Make diagnostics name the thing.** The I2C scanner reads the chip-ID register
   rather than trusting an address acknowledgement, so "BMP280 — wrong sensor" is
   stated outright instead of leaving a misleading "device found at 0x77".
5. **Verify the deployed artefact, not the local file.** Several "it is still
   broken" reports turned out to be a local edit that had never been committed.
   Fetching the live URL settled it immediately.
6. **Let a wrong hypothesis die on evidence.** The hotspot drop-out was blamed on
   5 GHz, then on power, then on memory. Each was discarded by a specific
   measurement before the real cause — a flash-alignment fault — became visible.
