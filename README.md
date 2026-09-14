# Library 3D Navigation

Indoor navigation for the Taipei Public Library Main Library, shown on a 3D
map in the browser.

- App: <https://ted369369.github.io/Indoor-3D-Navigation-Platform/> (open it on
  a phone; it needs HTTPS for GPS)
- How it works: <https://ted369369.github.io/Indoor-3D-Navigation-Platform/about.html>

Every push to `main` redeploys `web/` to GitHub Pages.

## What it does

The building has five floors, 50 x 35 m, 3.8 m between floors. 1F is the
service desk and the Learning e-Garden, 2F periodicals, 3F reference, 4F and 5F
books. The floor plans were drawn from the library's own floor guide.

Position comes from two places:

- **Phone GPS** for where you are on the floor.
- **An ESP8266 with a BMP390 pressure sensor** that you carry, for which floor
  you're on. A second sensor stays fixed on 1F as a reference, so changes in
  the weather cancel out.

A Python engine combines the two, smooths the result, snaps it to the corridors
and publishes it over MQTT. The web app draws it and routes you with A*. A
route sticks to one set of stairs the whole way: the central stairs, the
stairs next to the elevator, or the elevator if you need a step-free route.

You can type where you want to go in normal words, in English or Chinese.
"C language" goes to the science books (class 3), "我想知道最新時事" goes to the
newspapers, "somewhere to study" goes to the nearest reading area. There is
also spoken turn-by-turn guidance for blind and low-vision visitors, a friends
list with live positions, and a limit of 5 sensors in use at the same time.

Sensors aren't typed in by id. The app lists the units that are switched on
nearby (strongest signal first, ones already in use greyed out) and you tap
the one in your hand. If you don't have a sensor, GPS-only mode works too; you
pick your floor from a menu at the top.

## Repository

| Path | What's in it |
|---|---|
| `firmware/esp8266_bmp390/` | Arduino sketch for the sensor (carried or reference), MQTT over TLS |
| `firmware/i2c_scanner/` | Small sketch to check the BMP390 wiring |
| `backend/` | `position_engine.py` (the engine and sensor list), `simulator.py` (fake sensors for testing) |
| `web/` | The web app: Three.js map, search, voice, friends |
| `web/data/map_model.json` | Floor plans as data: zones, walkable paths, which class number is where |
| `supabase/schema.sql` | Tables for profiles, friends and pairings, with row-level security |
| `docs/SETUP.md` | How to set everything up |
| `docs/MQTT_TOPICS.md` | Every MQTT topic with its payload, QoS and retain flag |
| `docs/TROUBLESHOOTING_LOG.md` | Problems we ran into and how they were fixed |
| `raw_map/` | The original hand-drawn floor plans |

## Getting started

Follow [docs/SETUP.md](docs/SETUP.md). It covers the broker, Supabase,
flashing the firmware, running the engine and deploying the site, and takes
roughly 45 minutes the first time.

Built with: ESP8266 (Arduino), BMP390, MQTT on HiveMQ Cloud, Python, Three.js,
Supabase, Web Speech API.
