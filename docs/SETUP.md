# Setup

Order: MQTT broker, Supabase, firmware, position engine, web app. Expect about
45 minutes plus the time to flash the sensors.

## Overview

```
ESP8266 + BMP390 (carried, up to 5) --+
ESP8266 + BMP390 (reference on 1F) ---+-- TLS 8883 --> HiveMQ Cloud <-- WSS 8884 -- phone web app
Python position engine ---------------+                                              (GPS + map)
        |                                                                                 |
        +-- sessions (service key) --> Supabase <-- login / friends / keywords -----------+
```

- Phones publish GPS, sensors publish pressure, and the engine combines them
  into `libnav/user/<uid>/pos`. Every web client (you and your friends) draws
  that topic.
- The **reference sensor** is a sixth ESP8266 that stays on **1F** (the
  entrance floor, z = 0). Everyone's floor is measured against it, which
  removes pressure changes caused by the weather.

---

## 1. HiveMQ Cloud (10 min)

1. Create a free cluster at <https://console.hivemq.cloud>. The free plan
   allows 100 connections, which is plenty for 5 sensors.
2. Write down the hostname, e.g. `abc123.s1.eu.hivemq.cloud`.
   The firmware and the engine use TLS on port **8883**. The web app uses
   WebSockets on port **8884**.
3. Under **Access Management** create three accounts:

   | Username | Used by | Permissions |
   |---|---|---|
   | `esp-node` | all ESP8266 sensors | publish `libnav/dev/#` |
   | `engine` | position engine | publish and subscribe `libnav/#` |
   | `webapp` | browsers | publish `libnav/user/#` and `libnav/site/#`, subscribe `libnav/#` |

## 2. Supabase (10 min, optional)

Only needed for friends. Without it the app runs on its own and hides the
friends panel; navigation and voice still work.

1. Create a project at <https://supabase.com>.
2. In **Authentication > Sign In / Up**, turn on **Anonymous sign-ins**.
3. In the **SQL Editor**, run [`supabase/schema.sql`](../supabase/schema.sql).
4. From **Settings > API** copy:
   - the Project URL and `anon` key into `web/config.js`
   - the `service_role` key into `backend/.env` (never into the web app)

## 3. Firmware (about 10 min per sensor)

Any ESP8266 board (NodeMCU, Wemos D1 mini) and a BMP390 breakout.

Wiring over I²C, using GPIO numbers: `VIN-3V3  GND-GND  SDA-GPIO4  SCL-GPIO5`

On NodeMCU and Wemos boards that is **D2 = GPIO4 (SDA)** and
**D1 = GPIO5 (SCL)**. For other pins, change `I2C_SDA_PIN` and `I2C_SCL_PIN` at
the top of the sketch. The firmware tries address `0x77` first, then `0x76`
(boards with SDO tied to GND), and prints the address and pins it used at boot.

1. In the Arduino IDE, install the **esp8266** core from the Boards Manager,
   then **Adafruit BMP3XX** (with its dependencies) and **PubSubClient** from
   the Library Manager.
2. In `esp8266_bmp390.ino`, set `DEVICE_ID`, different for every unit.
   Carried sensors are `NAV-001` to `NAV-005`; the reference is `NAV-REF`
   with `NODE_ROLE ROLE_REFERENCE`. Set `SITE_ID` to the library the sensor
   is used in (`main` for Taipei, `yorba-linda` for Yorba Linda). Every library
   needs its own reference sensor on its lowest floor, and ids have to be
   unique across libraries (e.g. `YL-001`, `YL-REF`).
3. Copy `secrets.h.example` to `secrets.h` next to the sketch and fill it in
   (it's git-ignored):
   - Wi-Fi: the library network first, your phone hotspot as the fallback.
     The sensor uses less than 1 KB/s, so it doesn't eat into your data.
   - `MQTT_HOST`, `MQTT_USER`, `MQTT_PASS` from step 1.
4. Copy `certs.h.example` to `certs.h`, download
   <https://letsencrypt.org/certs/isrgrootx1.pem> and paste it in place of the
   placeholder. Without it the sensor still connects encrypted, but it can't
   verify the broker and prints a warning. Do this before using it for real.
5. Flash it and open the serial monitor at 115200 baud. You should see Wi-Fi,
   NTP and MQTT connect. The LED blinks on every publish (twice a second).
6. Put the reference sensor anywhere on **1F** on a USB power adapter and
   leave it there. Stick a label with the `DEVICE_ID` on each carried sensor. The app lists
   sensors that are switched on, and the label is how a visitor knows which
   entry is the one in their hand.

### If the BMP390 isn't found

Flash `firmware/i2c_scanner/i2c_scanner.ino` instead. Every 3 seconds it prints:

- the **idle level** of SDA and SCL (to check the pull-ups),
- a **bus recovery** attempt if SDA is stuck low,
- an **address scan**, and whether the BMP390 answered at `0x77` or `0x76`.

It uses the same pins as the main sketch, so if the scanner finds the sensor,
the main firmware will too.

## 4. Position engine (5 min)

Needs Python 3.10+ and internet. A laptop, a Raspberry Pi or a small VM is
fine.

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate     # Windows
pip install -r requirements.txt
copy .env.example .env                              # then fill in .env
python position_engine.py
```

The engine loads every library marked `available` in
`web/data/libraries.json`. You should see a `library ...` and `map model loaded`
line for each, then `mqtt connected`, then a line each time someone is admitted
or changes floor. Each library allows 5 active users (`MAX_ACTIVE_USERS=5`); a
sixth phone in the same library sees the waiting screen until someone leaves.

### Testing without hardware

`python simulator.py --users 2` fakes the reference sensor plus visitors
walking between floors. Their `SIM-xxx` units show up in the sensor list like
real ones. Add `--lib yorba-linda` to simulate Yorba Linda instead (units
`SIM-YL-001` and up). This is only for working at a desk; stop it before real
use. It gives back its slots as soon as it exits.

## 5. Web app (10 min)

1. Edit `web/config.js`: the WebSocket URL (`wss://<host>:8884/mqtt`), the
   `webapp` login, and optionally the Supabase URL and anon key.
2. Put the `web/` folder on any static host with **HTTPS** (GitHub Pages,
   Netlify, Vercel, Cloudflare Pages). Browsers won't give GPS to plain HTTP
   pages, except on localhost.
   To try it locally: `python -m http.server 8123 --directory web`.
3. On a phone the first screens are:
   - **Pick a library.** Taipei and Yorba Linda are mapped; see "Adding a
     library" below.
   - **Your name**, plus low-vision mode or step-free routes if you need them.
     Allow location access when the browser asks.
   - **How to locate you:**
     - **Sensor and phone GPS.** The app lists up to 5 sensors that are
       switched on, strongest signal first, each marked Available, In use or
       Offline. Tap the one whose label matches the unit you're holding. A
       sensor someone else is using can't be picked. The floor is then
       detected automatically.
     - **Phone GPS only.** No hardware. Position on the floor comes from GPS,
       and you set the floor with the "I'm on" menu in the top bar. Remember to
       change it when you take the stairs.

## Test mode and production mode

Settings (the sliders button) has a **Mode** switch:

- **Test** (default): your marker shows wherever you are, placed relative to
  where you started. Useful for demos away from the building.
- **Production**: your marker only shows when the phone is within **200 m of
  the library** (Taipei centre `25.029137, 121.53819`, Yorba Linda
  `33.890775, -117.810613`). Further away the marker is
  hidden and a notice says how far you are. Position uses the real building
  coordinates. Use this for the public site.

The centre and radius are `site.center` and `site.geofenceRadius` in the
library's model file (`web/data/map_model.json` for Taipei,
`web/data/yorba_linda.json` for Yorba Linda).

## Map calibration (once, 5 min)

The map has to know where the building is:

1. Open the app, then Settings, then **Map calibration**.
2. Stand at the **north-west corner** of the building (top left of the drawn
   plan) and tap "Use my location". Do the same at the **north-east corner**
   (50 m along the top edge). You can also paste coordinates from Google Maps.
3. Save. The points go to the engine as a retained MQTT message and apply to
   everyone in that library straight away. Each library is calibrated
   separately.

## Notes

- **Status indicators.** NET, GPS and ALT in the top bar are the broker, the
  phone's GPS and the pressure sensor. The number next to them is the round
  trip to the broker in milliseconds.
- **Floor detection.** The BMP390 is accurate to about 0.25 m and floors are
  3.8 m apart, so there's a lot of margin. The floor only changes after 4
  matching samples (2 seconds), so it doesn't flicker on the stairs. If floors
  look wrong, check that the reference sensor is online
  (`libnav/dev/NAV-REF/status`) and really is on 1F.
- **GPS indoors** is off by 5 to 30 m. The engine's filter and the snapping to
  corridors keep the marker in a sensible place, but expect "right area", not
  "right shelf".
- **iPhone.** Spoken directions work. The microphone button is hidden because
  Safari doesn't support speech recognition. Everything else is the same as on
  Android.
- **Floors and stairs.** The model covers 1F to 5F, 3.8 m apart. To change
  floors a route uses the **central stairs and escalator**, the **stairs next to
  the elevator**, or the **elevator** for step-free routes, and sticks to the
  same one the whole way. The button in the route sign switches between the two
  staircases; the step-free setting forces the elevator.
- **Zone photos.** Tapping a zone opens a card. Put a photo at
  `web/photos/<ZONE-ID>.jpg` (e.g. `3F-REF.jpg`) and it appears there. See
  `web/photos/README.md`, and only use photos you're allowed to publish.
- **Editing the map.** Outlines, zones (with optional `desc` and `photo`), the
  walkable paths, the stair cores and the class-number-to-zone table are all in
  the library's model file. Coordinates are in metres, x west to east and y
  from the top of the drawing to the bottom (Taipei is 50 x 35 m, Yorba Linda
  98 x 44 m). The engine reads the same files, so restart it after editing.
- **Adding a library.** Add an entry to `web/data/libraries.json` (`id`,
  `name`, `location`, `model` pointing at its map file, `available: true`) and
  put its map file next to `map_model.json`. It appears on the first screen and
  the engine picks it up on its next start. Entries with `available: false`
  show greyed out as "Soon". Besides floors, zones, paths and connectors, a
  model carries everything that differs between buildings:
  - `site.start`: where routes begin before there's a position
  - `site.cores`: what the stair cores and elevator are called
  - `site.floorLanding`: where "go to floor N" takes you
  - `site.quickChips`, `site.examples`, `site.searchHint`: chat suggestions
  - `keywords` and `intents`: the search words
  - `demoWalk`: the loop the simulator walks
  See [MAPS.md](MAPS.md) for how the two existing maps were made.
- **Adding search words.** Insert rows into the Supabase `keywords` table
  (term, aliases, zone_id). Phones pick them up the next time they load the
  app; rows only apply in the library that has that zone. The built-in word
  lists are the `keywords` arrays in each model file.
