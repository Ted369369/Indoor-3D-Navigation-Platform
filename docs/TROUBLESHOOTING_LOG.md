# Troubleshooting log

Problems we hit while building this, what the cause turned out to be, and the
fix. A few of them had an obvious-looking explanation that was wrong, so the
dead ends are written down too.

## Summary

| # | Area | Problem | Cause | Commit |
|---|---|---|---|---|
| 1 | Backend | "All slots busy" with nobody connected | Capacity only checked on a user's *first* GPS fix | `81340f7` |
| 2 | Web | App stuck behind the capacity overlay | `[hidden]` overridden by our own CSS | `fe46629` |
| 3 | Web | Page did nothing when opened by double-click | `file://` blocks ES modules and `fetch` | `fe46629` |
| 4 | Web | Map labels blurry | Low-resolution canvas textures with mipmaps | `9d66f36` |
| 5 | Web | Other floors still visible after picking one | Floors were dimmed to 7%, not hidden | `9d66f36` |
| 6 | Web | Marker didn't move while walking | Marker only followed the engine, which wasn't running | `03fcf39` |
| 7 | Web | Library step wouldn't submit | Hidden `required` input blocks the form | `00d054a` |
| 8 | Web | Old JS/model still served after deploys | No cache revalidation on Pages or the dev server | `00d054a` |
| 9 | Deploy | GitHub Pages action failed | `GITHUB_TOKEN` can't enable Pages | `3f3f4de` |
| 10 | Security | Passwords one commit away from going public | Credentials typed into the tracked `.ino` | `fbce1b7` |
| 11 | Toolchain | `Adafruit_Sensor.h: No such file` | Library not installed | none |
| 12 | Backend | `ConnectionRefusedError 10061` | No `.env`, and `python-dotenv` missing | `91d5542` |
| 13 | Firmware | ESP wouldn't join the phone hotspot | ESP8266 only does 2.4 GHz / WPA2 | `b452055` |
| 14 | Firmware | BMP390 "not found" | Board-specific pin names; only one I2C address tried | `09f7e89` |
| 15 | Firmware | **Joins hotspot, then drops forever** | **CA certificate in `PROGMEM` crashes BearSSL** | `6823f26` |
| 16 | Firmware | Boot message never arrived | PubSubClient's 256-byte packet limit | `8771a0f` |
| 17 | Web | Sensor never showed up in the app | `config.js` still had placeholders on Pages | `1b24e56` |

---

## Firmware (ESP8266 + BMP390)

### 15. Joins the hotspot, then disconnects and reconnects forever

This one took the longest.

**Symptom.** The sensor connected to the phone hotspot, dropped, connected
again, and kept doing that. From the phone it just looked like a bad Wi-Fi
client.

**What we thought it was, in order:**

1. *Hotspot on 5 GHz or WPA3.* Would make sense for an ESP8266, but it did
   connect, so the network was reachable.
2. *Power dips.* `ESP.getResetReason()` said `Exception`, not `Power on` or
   `External System`, so no.
3. *Out of memory.* Boot showed `free heap: 42976 bytes`, so also no.

**How we found it.** We printed numbered `[stage] N` lines before each step that
could fail. The serial log then showed:

```
[bmp390] ready at 0x77          <- sensor fine
[wifi] connected ... rssi=-34   <- Wi-Fi fine
[time] epoch=1789273150         <- NTP fine
                                <- reboot, before the [tls] line
```

Between the NTP line and the TLS line there was only one statement:
`BearSSL::X509List caCert(CA_CERT_PEM);`

**Cause.** `CA_CERT_PEM` is stored in `PROGMEM`. On the ESP8266 that part of
flash can only be read in 32-bit aligned chunks, but BearSSL reads the PEM one
byte at a time through a normal pointer. That throws a `LoadStoreError` and the
board reboots, every time.

It also explains why the problem only showed up late. While `certs.h` still had
the placeholder, `isCaCertInstalled()` returned false and the code went down the
`setInsecure()` path, which never touches `X509List`. Pasting in the real
certificate was the first time the broken path ran.

**Fix.** Copy the PEM into RAM with `memcpy_P`, parse it, then `free()` the copy
(`X509List` keeps its own parsed version). If anything fails, fall back to
`setInsecure()` and print why instead of crashing. `6823f26`

There was a second copy of the same mistake, removed in `a49e093`:
`isCaCertInstalled()` called `strstr_P()`, whose **first** argument has to be in
RAM, and we were passing it the certificate in flash.

### TLS buffers don't fit in the ESP8266's memory

**Cause.** BearSSL wants 16 KB for receiving and 16 KB for sending by default.
The ESP8266 has about 40 KB of heap in total.

**Fix.** Ask the broker whether it supports Maximum Fragment Length Negotiation
and size the buffers from that. `8771a0f`

> What actually happens: **HiveMQ Cloud doesn't support MFLN**, so the fallback
> `setBufferSizes(4096, 1024)` is what runs. Keeping that fallback matters. With
> only a 1024-byte receive buffer the handshake fails.

### 16. The boot message was never published

**Cause.** PubSubClient's packet buffer is 256 bytes by default. The `init`
payload is 248 bytes, and with the topic added it doesn't fit, so `publish()`
returned false and sent nothing. No error was printed anywhere.

**Fix.** `mqtt.setBufferSize(512)`. `8771a0f`

### 14. BMP390 not detected

**Cause, two things:**

1. The wiring notes used `D1` / `D2`, which only exist on NodeMCU-style boards,
   not on a bare ESP-12E.
2. A comment said `begin_I2C()` "tries 0x77 then 0x76". It doesn't. Adafruit's
   function only tries the address you give it, so a board with `SDO` tied to
   GND (address 0x76) was never found.

**Fix.** Plain GPIO numbers in `I2C_SDA_PIN` / `I2C_SCL_PIN` (GPIO4 / GPIO5)
with an explicit `Wire.begin(sda, scl)`, and a real fallback from 0x77 to 0x76
that prints which address worked. `09f7e89`

**Scanner sketch.** `firmware/i2c_scanner/` checks that SDA and SCL idle high
(pull-ups present), tries to recover the bus with nine clock pulses if SDA is
stuck low, scans all addresses and **reads the chip-ID register**. The chip ID
is the important part: a BMP280 or BME280 sits on the same 0x76/0x77
addresses, so something answering there doesn't prove it's a BMP390.
`f0182da`, `4894436`

### 13. Wouldn't join the phone hotspot

**Cause.** The ESP8266 only supports **2.4 GHz and WPA2**. Phone hotspots often
default to 5 GHz or WPA3, and then the ESP can't even see the network.

**Fix.** When joining fails, scan and print every network the ESP can see, with
channel and signal. If your hotspot isn't in the list, you know right away.
`b452055` To actually fix it: turn on *Maximize Compatibility* on an iPhone,
or set the hotspot to 2.4 GHz and WPA2 on Android.

---

## Backend (Python position engine)

### 12. `ConnectionRefusedError: [WinError 10061]`

**Cause, two layers:**

1. There was no `backend/.env`, so `MQTT_HOST` fell back to `localhost:8883`,
   where nothing was listening.
2. After creating `.env` it was *still* ignored. `python-dotenv` wasn't
   installed, and the import was wrapped in `try / except ImportError: pass`,
   so nothing complained.

**Fix.** A small `.env` reader built into the engine, used when `python-dotenv`
isn't installed. Environment variables set in the shell still win. `91d5542`

**Lesson.** An optional import inside a silent `except` turns "package missing"
into "config ignored", with no message.

### 1. "All slots busy" with nobody connected

**Symptom.** The capacity screen appeared and never went away, even though
nobody was using the system.

**Cause.** Two bugs on top of each other:

- The engine only checked admissions on a user's **first GPS fix**. If a
  phone's GPS paused while a slot freed up, that phone was never checked again
  and stayed rejected.
- Users who had left kept their slot for the full 30-second timeout, and the
  simulator's fake users counted as real ones.

**Fix.** Check capacity on every tick (users who went quiet give back their
slot, waiting users get in first-come first-served), re-send `reject` every 5
seconds with the current numbers, free a slot as soon as the presence Last Will
arrives, and let the overlay in the app clear itself when the rejects stop.
`81340f7`

---

## Web app

### 2 and 3. The app was unusable when first opened

**Symptom.** A permanent "All slots busy" screen and nothing else responded.

**Cause, two separate bugs:**

1. The `hidden` attribute works through the browser's default
   `display: none`, and **any CSS rule on the element overrides it**. The
   modals had `display: grid`, so *all* of them were showing at once, and the
   capacity overlay, being last in the page, covered the rest.
2. The page had been opened by double-clicking `index.html`. From `file://`,
   browsers block ES modules and `fetch`, so none of the app code ran.

**Fix.** A global `[hidden] { display: none !important; }`, and a small inline
check that notices `file://` and explains how to serve the folder. `fe46629`

### 17. The phone never found the sensor

**Cause.** `web/config.js` still had the placeholder broker host
(`xxxxxxxx.s1.eu.hivemq.cloud`) and password. The file had been edited locally
but **never committed**, so GitHub Pages kept serving the placeholder and the
phone was trying to connect to a hostname that doesn't exist.

**Fix.** Put in the real host and a **separate `webapp` account** with its own
password and limited permissions, then push. `1b24e56`

> This also confused us: the sensor list in the app comes from
> `libnav/directory`, which the **Python engine** publishes, not the ESP. A
> sensor can be sending telemetry just fine and still never show up in the app
> if the engine isn't running.

### 4, 5 and 6. Drawing and positioning

- **Blurry labels.** The canvas textures were too small and mipmapped. Fixed
  with 2x resolution, maximum anisotropy and `LinearFilter` without mipmaps.
  Later the labels were changed to a fixed size on screen, so the texture maps
  about 1:1 to screen pixels and the full zone names are readable on a phone.
- **Picking a floor.** Other floors were only dimmed to 7% opacity instead of
  hidden. Now they're hidden, and while navigating only the floors on the route
  are shown, see-through enough that the route is visible through them.
  `9d66f36`
- **Marker didn't move.** The marker only followed positions from the engine,
  so with no engine running nothing happened. The app now converts GPS to
  metres itself and moves the marker directly, with smoothing weighted by
  accuracy, a limit on how far it can jump per update (one bad fix moves it less
  than 1.5 m), ignoring fixes worse than 100 m, and snapping to corridors once
  calibrated. `03fcf39`, `00d054a`

### 7. The library step wouldn't submit

**Cause.** The name field is `required`, but it belongs to a *later* step and is
`hidden` while the library step shows. Browsers won't submit a form with an
invalid field that can't be focused, and they don't say anything. The button
just seemed dead.

**Fix.** Remove `required` from the HTML and check the name in JavaScript.
`00d054a`

### 8. Old files after deploying

**Cause.** Neither GitHub Pages nor Python's `http.server` makes the browser
revalidate, so a browser could load a **new** `app.js` together with an **old**
`nav.js` or map file. During testing that caused a real crash
(`this.graphs[profile]` undefined) just from mismatched versions.

**Fix.** A `?v=` query on the module imports, changed whenever the structure
changes, and `cache: "no-cache"` on the JSON fetches. `00d054a`

---

## Deployment and security

### 9. GitHub Pages deploy failed

**Cause.** The `actions/configure-pages` step can't create the Pages site with
the default `GITHUB_TOKEN`, which doesn't have admin rights.

**Fix.** Publish `web/` to a `gh-pages` branch instead, which public
repositories serve automatically. `3f3f4de`

### 10. Credentials one commit away from going public

**Symptom.** Real Wi-Fi and MQTT passwords had been typed straight into the
tracked `esp8266_bmp390.ino`.

**First we checked what was already committed.** `git show HEAD:...` showed the
committed file still only had placeholders (`changeme`, `xxxxxxxx`). **Nothing
had leaked**, so there was no need to rewrite history or change the passwords.

**Fix.** Move credentials into a git-ignored `secrets.h`, ignore
`firmware/**/*.h` but keep the `.h.example` templates tracked, and stop tracking
`certs.h`. Before every commit we now grep the staged changes for the real
strings. `fbce1b7`

> `certs.h` holds the **ISRG Root X1** certificate, which is a *public* Let's
> Encrypt root and not secret at all. The passwords were in the `.ino`. Only
> protecting `certs.h` would have felt safe and still leaked them.

---

## Debugging habits that helped

1. **Number the boot stages.** Printing `[stage] 1..5` before each risky step
   turned a mystery reboot loop into "the last line printed is where it dies",
   no exception decoder needed. This is how the PROGMEM crash was found.
2. **Print `ESP.getResetReason()` at boot.** It tells a crash apart from a
   power dip immediately, which ruled out the power supply early.
3. **Log the largest free block, not just free heap.** BearSSL needs one big
   continuous allocation. A fragmented heap can fail even when the total free
   memory looks fine.
4. **Make the diagnostic say what it found.** The I2C scanner reads the chip
   ID, so it prints "BMP280, wrong sensor" instead of just "device at 0x77".
5. **Check what's deployed, not the local file.** Several "still broken"
   reports were a local edit that was never committed. Loading the live URL
   answered it straight away.
6. **Drop a theory when the evidence says so.** The hotspot problem was blamed
   on 5 GHz, then power, then memory. Each was ruled out by a measurement
   before the real cause, a flash alignment fault, showed up.
