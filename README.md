# Library 3D Navigation

**Live app:** <https://ted369369.github.io/Indoor-3D-Navigation-Platform/> —
open it on your phone (HTTPS, so GPS works). Auto-deployed from `web/` on
every push to `main`.

Real-time 3D indoor navigation for the Taipei Public Library Main Library
(floors 1–5, 50 × 35 m, 3.8 m per storey): 1F service desk & Learning e-Garden,
2F periodicals, 3F reference collections, 4F & 5F books. Built from the
library's floor plans and official floor guide.

**Positioning** fuses two live signals: phone GPS (horizontal) and a carried
ESP8266 + BMP390 barometric sensor (vertical), referenced against a fixed
BMP390 node so weather drift cancels out. A Python engine smooths, floor-snaps,
and corridor-snaps every position and republishes it to all clients over MQTT.

**The web app** renders the building in Three.js, plans A* routes that use one
vertical core end-to-end — the central stairs/escalator, the stairs by the
elevator, or the step-free elevator — and takes destinations in plain language —
"C language" routes to the science stacks (class 3), "我想知道最新時事" to the
newspaper area, "somewhere to study" to the nearest reading room. Includes
voice turn-by-turn guidance (blind-friendly), friend search with live
positions, step-free routing, connection-quality indicators, and a 5-device
concurrency cap.

| Path | Contents |
|---|---|
| `firmware/esp8266_bmp390/` | Arduino sketch (user + reference roles), TLS MQTT |
| `backend/` | `position_engine.py` (fusion service + live device directory), `simulator.py` (optional dev-only testing) |
| `web/` | Static web app: Three.js scene, chat intent engine, voice, friends |
| `web/data/map_model.json` | Digitized floor plans: zones, walkable graph, class→zone map |
| `supabase/schema.sql` | Auth-linked profiles, friendships, pairings, RLS |
| `docs/SETUP.md` | Full deployment guide |
| `raw_map/` | Original hand-drawn plans |

Pairing is discovery-based: powered-on ESP units near you are listed live in
the app (up to 5, strongest signal first, with availability status) and the
visitor explicitly taps the unit they are holding — no IDs to type, and a
unit in use by someone else cannot be taken. A **GPS-only mode** needs no
hardware at all: horizontal position from the phone, floor chosen manually
from a top-bar selector.

Quick start: read [docs/SETUP.md](docs/SETUP.md) — broker, Supabase, firmware
flashing, engine, and web deployment in ~45 minutes.

Stack: ESP8266 (Arduino) · BMP390 · MQTT (HiveMQ Cloud, TLS/WSS) · Python ·
Three.js · Supabase (Postgres + Auth + Realtime) · Web Speech API.
