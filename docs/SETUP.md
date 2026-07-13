# Setup Guide — Library 3D Navigation

End-to-end deployment: MQTT broker → Supabase → firmware → position engine → web app.
Total time: roughly 45 minutes plus firmware flashing.

## Architecture recap

```
ESP8266 + BMP390 (user, x5) ─┐
ESP8266 + BMP390 (reference) ─┤ TLS 8883 ┌──────────────┐
                              ├─────────►│ HiveMQ Cloud │◄──── WSS 8884 ── Phone web app
Python position engine ───────┘          └──────────────┘                  (GPS + UI)
        │                                                                       │
        └── sessions (service key) ──► Supabase ◄── auth / friends / keywords ──┘
```

- Phones publish GPS; ESP nodes publish pressure; the engine fuses both into
  `libnav/user/<uid>/pos`, which all web clients (you + your friends) render.
- The **reference node** is a sixth ESP8266 fixed on **floor 2** (z = 0). It
  cancels weather-induced pressure drift for everyone.

---

## 1. HiveMQ Cloud (10 min)

1. Create a free cluster at <https://console.hivemq.cloud> (Serverless/Free: 100
   connections — far above the 5-device cap).
2. Note the hostname, e.g. `abc123.s1.eu.hivemq.cloud`.
   - Firmware + engine use TLS port **8883**; the web app uses WebSocket port **8884**.
3. Under **Access Management**, create three credentials:
   | Username | Used by | Suggested permission |
   |---|---|---|
   | `esp-node` | all ESP8266 devices | publish `libnav/dev/#` |
   | `engine` | position engine | publish + subscribe `libnav/#` |
   | `webapp` | browsers | publish `libnav/user/#`, `libnav/site/#`; subscribe `libnav/#` |

## 2. Supabase (10 min) — optional but required for friends

1. Create a project at <https://supabase.com>.
2. **Authentication → Sign In / Up → Anonymous sign-ins: enable.**
3. **SQL Editor** → paste and run [`supabase/schema.sql`](../supabase/schema.sql).
4. From **Settings → API** copy:
   - Project URL + `anon` key → `web/config.js`
   - `service_role` key → `backend/.env` (never put this in the web app)

Skipping Supabase: the web app auto-runs in solo mode (navigation and voice
work; friend features hide themselves).

## 3. Firmware (per device, ~10 min)

Boards: any ESP8266 (NodeMCU, Wemos D1 mini). Sensor: BMP390 breakout.

Wiring: `VIN→3V3  GND→GND  SCL→D1(GPIO5)  SDA→D2(GPIO4)`

1. Arduino IDE → Boards Manager → install **esp8266** core.
   Library Manager → install **Adafruit BMP3XX** (accept dependencies) and
   **PubSubClient**.
2. Open `firmware/esp8266_bmp390/esp8266_bmp390.ino` and edit the
   configuration block:
   - `DEVICE_ID`: unique per unit — users: `NAV-001` … `NAV-005`,
     reference: `NAV-REF` with `NODE_ROLE ROLE_REFERENCE`.
   - Wi-Fi: venue SSID first; your phone-hotspot SSID as automatic fallback
     (hotspot mode costs the phone < 1 KB/s — browsing stays unaffected).
   - `MQTT_HOST` / `MQTT_USER` / `MQTT_PASS` from step 1.
3. TLS trust: download <https://letsencrypt.org/certs/isrgrootx1.pem> and paste
   its contents into `certs.h` (replacing the placeholder line). Without it the
   node still connects but logs a warning and skips server authentication.
4. Flash at 115200 baud; the serial monitor shows Wi-Fi, NTP, and MQTT status.
   The LED blinks briefly on every publish (2 Hz).
5. Place `NAV-REF` anywhere on **floor 2**, powered permanently (USB adapter).
   Label each user unit with its `DEVICE_ID` so visitors can type it during
   pairing (or print a QR code of the ID).

## 4. Position engine (5 min)

Runs anywhere with Python 3.10+ and internet (a PC, Raspberry Pi, or small VM):

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate     # Windows
pip install -r requirements.txt
copy .env.example .env                              # then edit .env
python position_engine.py
```

Expected log: `mqtt connected`, `map model loaded`, then per-user admissions
and floor changes. The engine enforces `MAX_ACTIVE_USERS=5`; a sixth phone
sees the queue overlay until a slot frees.

### Test without hardware

```bash
python simulator.py --users 5
```

simulates the reference node plus five visitors walking loops through floors
2 → 4 → 5. Watch the engine log, or add the simulated users as friends.

## 5. Web app (10 min)

1. Edit `web/config.js`: MQTT WSS URL (`wss://<host>:8884/mqtt`), `webapp`
   credentials, and (optionally) the Supabase URL + anon key.
2. Deploy the `web/` folder to any **HTTPS** static host — GitHub Pages,
   Netlify, Vercel, Cloudflare Pages. HTTPS is mandatory: browsers refuse
   geolocation on plain HTTP (localhost is exempt for development).
   Local preview: `python -m http.server 8123 --directory web`.
3. First launch on a phone: enter a display name, the sensor ID from the
   device tag, and (if needed) enable blind mode or step-free routing. Grant
   the location permission when prompted.

## 6. Geo calibration (once, 5 min)

The 3D map needs to know where the building sits on Earth:

1. Open the web app → gear button → **Geo calibration**.
2. Stand at the building's **north-west corner** (top-left of the hand-drawn
   plan) → "Use my location". Repeat at the **north-east corner** (50 m along
   the top edge) — or paste coordinates read off Google Maps.
3. Save. Anchors broadcast to the engine over a retained MQTT message and
   apply immediately to everyone.

## Operations notes

- **Connection quality**: the three dots in the top bar are server / GPS /
  sensor; the number is live broker round-trip latency. Hover for detail.
- **Floor detection** is differential barometry: ±0.25 m sensor accuracy vs.
  3.8 m floor spacing gives a wide margin, and a 2 s hysteresis prevents
  flapping inside stairwells. If floors read wrong, confirm the reference node
  is online (`libnav/dev/NAV-REF/status`) and actually on floor 2.
- **GPS indoors** is 5–30 m; the engine's Kalman filter + snap-to-corridor
  keep the marker sensible. Expect zone-level, not shelf-level, accuracy.
- **iOS**: voice *output* (guidance) works; voice *input* (dictation button)
  hides itself because Safari lacks SpeechRecognition. Everything else is
  identical to Android.
- **Editing the map**: all geometry, zones, walkable graph, and the
  class → zone table live in `web/data/map_model.json`. Coordinates are metres:
  x = 0–50 west→east, y = 0–35 top→bottom of the drawing. The engine reads the
  same file — restart it after edits.
- **Adding vocabulary**: insert rows into the Supabase `keywords` table
  (term, aliases, zone_id) — clients pick them up on next load. The built-in
  dictionary is in `web/js/intent.js`.
