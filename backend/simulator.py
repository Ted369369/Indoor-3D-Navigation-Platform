#!/usr/bin/env python3
"""
Library 3D Navigation - device simulator

Tests the whole stack without hardware: fakes a library's fixed reference
node plus N walking visitors (phone GPS + carried ESP8266 pressure).

Each simulated visitor walks the loop in the model's "demoWalk" list,
publishing:
  libnav/user/sim-user-<n>/gps        (1 Hz, with realistic GPS noise)
  libnav/user/sim-user-<n>/pair       (retained, once)
  libnav/dev/SIM-<n>/telemetry        (2 Hz pressure matching their floor)
  libnav/dev/SIM-REF/telemetry        (2 Hz reference baseline)

Usage:
  python simulator.py                    # 2 visitors in Taipei
  python simulator.py --users 5          # test the capacity limit
  python simulator.py --lib yorba-linda  # Yorba Linda (ids SIM-YL-001 ...)

Watch the result in the web app: simulated users appear as friends would
(subscribe to their pos topics), or check the engine log output.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import random
import time
from pathlib import Path

import paho.mqtt.client as mqtt


def _load_env():
    """Load backend/.env (python-dotenv if present, else a tiny parser)."""
    try:
        from dotenv import load_dotenv
        load_dotenv()
        return
    except ImportError:
        pass
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_env()

log = logging.getLogger("sim")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", "8883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")
MQTT_TLS = os.getenv("MQTT_TLS", "1") == "1"

LIBRARIES_PATH = Path(__file__).parent.parent / "web" / "data" / "libraries.json"

SEA_LEVEL_PA = 101325.0
R_GAS, G0, M_AIR = 8.3145, 9.80665, 0.0289644
TEMP_C = 24.0


def pressure_at(z: float) -> float:
    """Inverse hypsometric: pressure at height z above the reference floor."""
    t_k = 273.15 + TEMP_C
    return SEA_LEVEL_PA * math.exp(-(z * G0 * M_AIR) / (R_GAS * t_k))


class Walker:
    """Walks the nav graph nodes of each floor in a fixed scripted loop."""

    def __init__(self, idx: int, model: dict, lib: str):
        # Taipei keeps the original ids; other libraries get a short prefix
        tag = "" if lib == "main" else "".join(w[0] for w in lib.split("-")).upper() + "-"
        self.uid = f"sim-user-{idx}" if not tag else f"sim-{lib}-user-{idx}"
        self.dev = f"SIM-{tag}{idx:03d}"
        site = model["site"]
        self.geo_origin = site["geoAnchors"]["origin"]
        self.geo_xaxis = site["geoAnchors"]["xAxis"]
        self.floor_z = {str(f["level"]): f["z"] for f in site["floors"]}
        nodes = {
            lvl: {n["id"]: n for n in floor["nodes"]}
            for lvl, floor in model["floors"].items()
        }
        # the loop to walk is part of each library's model ("demoWalk")
        self.waypoints: list[tuple[str, float, float]] = []
        for lvl, nid in model["demoWalk"]:
            n = nodes[lvl][nid]
            self.waypoints.append((lvl, n["x"], n["y"]))
        # offset walkers so they don't stack on the same waypoint
        self.progress = (idx * 3.7) % len(self.waypoints)
        self.speed = 1.0 + random.uniform(-0.2, 0.2)  # m/s

    def step(self, dt: float) -> tuple[str, float, float]:
        i = int(self.progress) % len(self.waypoints)
        j = (i + 1) % len(self.waypoints)
        lvl_a, ax, ay = self.waypoints[i]
        lvl_b, bx, by = self.waypoints[j]
        seg = math.hypot(bx - ax, by - ay) or 1.0
        frac = self.progress - int(self.progress)
        frac += (self.speed * dt) / seg
        if frac >= 1.0:
            self.progress = float(j)
            return lvl_b, bx, by
        self.progress = int(self.progress) + frac
        # position interpolates; floor switches only at the waypoint itself
        return lvl_a, ax + (bx - ax) * frac, ay + (by - ay) * frac

    def to_latlng(self, x: float, y: float) -> tuple[float, float]:
        lat0, lng0 = self.geo_origin["lat"], self.geo_origin["lng"]
        m_lat = 111132.0
        m_lng = 111320.0 * math.cos(math.radians(lat0))
        e = (self.geo_xaxis["lng"] - lng0) * m_lng
        n = (self.geo_xaxis["lat"] - lat0) * m_lat
        norm = math.hypot(e, n) or 1.0
        ux = (e / norm, n / norm)
        uy = (ux[1], -ux[0])
        east = x * ux[0] + y * uy[0]
        north = x * ux[1] + y * uy[1]
        return lat0 + north / m_lat, lng0 + east / m_lng


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=int, default=2, help="number of simulated visitors")
    parser.add_argument("--lib", default="main", help="library id from web/data/libraries.json")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s sim: %(message)s")
    catalog = json.loads(LIBRARIES_PATH.read_text(encoding="utf-8"))
    entry = next((l for l in catalog["libraries"] if l["id"] == args.lib and l.get("model")), None)
    if not entry:
        raise SystemExit(f"unknown library {args.lib!r}")
    model = json.loads((LIBRARIES_PATH.parent.parent / entry["model"]).read_text(encoding="utf-8"))
    ref_id = "SIM-REF" if args.lib == "main" else f"SIM-REF-{args.lib}"

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="libnav-simulator")
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
    if MQTT_TLS:
        client.tls_set()
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=20)
    client.loop_start()

    walkers = [Walker(i + 1, model, args.lib) for i in range(args.users)]
    for w in walkers:
        client.publish(f"libnav/user/{w.uid}/pair",
                       json.dumps({"device": w.dev, "lib": args.lib}), qos=1, retain=True)
        client.publish(f"libnav/user/{w.uid}/presence", "online", qos=1, retain=True)
    log.info("simulating %d visitors + reference node in %s against %s",
             args.users, args.lib, MQTT_HOST)

    seq = 0
    last_gps = 0.0
    last = time.time()
    try:
        while True:
            now = time.time()
            dt, last = now - last, now

            # reference node: fixed on the lowest floor (z = 0) with slight sensor noise
            client.publish(f"libnav/dev/{ref_id}/telemetry", json.dumps({
                "id": ref_id, "role": "reference", "site": args.lib, "seq": seq,
                "p": round(pressure_at(0.0) + random.gauss(0, 1.5), 2),
                "t": TEMP_C, "rssi": -48, "up": int(now * 1000),
            }))

            send_gps = now - last_gps >= 1.0
            for w in walkers:
                lvl, x, y = w.step(dt)
                z = w.floor_z[lvl]
                client.publish(f"libnav/dev/{w.dev}/telemetry", json.dumps({
                    "id": w.dev, "role": "user", "site": args.lib, "seq": seq,
                    "p": round(pressure_at(z) + random.gauss(0, 1.5), 2),
                    "t": TEMP_C, "rssi": random.randint(-75, -55), "up": int(now * 1000),
                }))
                if send_gps:
                    lat, lng = w.to_latlng(
                        x + random.gauss(0, 3.0), y + random.gauss(0, 3.0)
                    )
                    client.publish(f"libnav/user/{w.uid}/gps", json.dumps({
                        "lat": round(lat, 7), "lng": round(lng, 7),
                        "acc": round(random.uniform(8, 18), 1), "ts": int(now * 1000),
                        "lib": args.lib,
                    }))
            if send_gps:
                last_gps = now
            seq += 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        # announce a clean exit so the engine frees the slots immediately
        for w in walkers:
            client.publish(f"libnav/user/{w.uid}/pair", b"", qos=1, retain=True)
            client.publish(f"libnav/user/{w.uid}/presence", "offline", qos=1, retain=True)
        time.sleep(0.5)  # let the queued publishes flush before disconnecting
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
