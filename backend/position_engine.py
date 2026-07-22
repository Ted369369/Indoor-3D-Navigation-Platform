#!/usr/bin/env python3
"""
Library 3D Navigation - position engine
=======================================
Broker-side fusion service. Subscribes to raw device pressure and phone GPS,
produces smoothed 3D positions that every client renders identically.

Pipeline per user:
  GPS (lat/lng)  -> local metres (geo anchors) -> 2D Kalman (constant velocity)
  pressure (Pa)  -> altitude vs. fixed reference node (hypsometric formula)
                 -> floor classifier with hysteresis over {2F, 4F, 5F}
  fused (x,y)    -> snapped to the walkable graph so markers stay in corridors
  publish        -> libnav/user/<uid>/pos  (retained, 2 Hz)

Also enforces the concurrent-device cap (default 5) and optionally logs
sessions to Supabase (service-role key).

MQTT topics consumed:
  libnav/dev/+/telemetry   {"id","role","seq","p","t","rssi","up"}
  libnav/dev/+/status      "online"/"offline" (retained LWT)
  libnav/user/+/gps        {"lat","lng","acc","ts"}
  libnav/user/+/pair       {"device":"NAV-001"} (retained; empty = unpair)
  libnav/site/anchors      {"origin":{lat,lng},"xAxis":{lat,lng}} (retained)

MQTT topics produced:
  libnav/user/<uid>/pos     {"x","y","z","floor","q":{...},"ts"} (retained)
  libnav/user/<uid>/control {"action":"admit"|"reject","reason","slots"}
  libnav/engine/status      "online"/"offline" (retained LWT)

Configuration: .env file or environment (see .env.example in this folder).
"""

from __future__ import annotations

import json
import logging
import math
import os
import signal
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import paho.mqtt.client as mqtt

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from supabase import create_client as _create_supabase
except ImportError:
    _create_supabase = None

log = logging.getLogger("engine")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", "8883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")
MQTT_TLS = os.getenv("MQTT_TLS", "1") == "1"

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

MAP_MODEL_PATH = Path(
    os.getenv("MAP_MODEL_PATH", Path(__file__).parent.parent / "web" / "data" / "map_model.json")
)

MAX_ACTIVE_USERS = int(os.getenv("MAX_ACTIVE_USERS", "5"))
PUBLISH_HZ = float(os.getenv("PUBLISH_HZ", "2"))
GPS_STALE_S = 30.0          # user considered inactive after this silence
PRESSURE_STALE_S = 10.0     # pressure older than this is ignored for floors
SNAP_MAX_DIST_M = 12.0      # beyond this, show raw (still clamped) position
FLOOR_SWITCH_SAMPLES = 4    # consecutive agreeing samples before floor change
FLOOR_CAPTURE_BAND_M = 1.9  # |z - floor z| must be inside this band

R_GAS, G0, M_AIR = 8.3145, 9.80665, 0.0289644  # hypsometric constants


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def point_in_poly(x: float, y: float, poly: list[list[float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def nearest_point_on_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
    qx, qy = ax + t * dx, ay + t * dy
    return qx, qy, math.hypot(px - qx, py - qy)


class GeoConverter:
    """lat/lng <-> local metres using two anchors: origin=(0,0), xAxis=(width,0)."""

    def __init__(self, origin: dict, x_axis: dict, width: float):
        self.width = width
        self.set_anchors(origin, x_axis)

    def set_anchors(self, origin: dict, x_axis: dict):
        self.lat0, self.lng0 = origin["lat"], origin["lng"]
        m_per_deg_lat = 111132.0
        m_per_deg_lng = 111320.0 * math.cos(math.radians(self.lat0))
        e = (x_axis["lng"] - self.lng0) * m_per_deg_lng
        n = (x_axis["lat"] - self.lat0) * m_per_deg_lat
        norm = math.hypot(e, n) or 1.0
        # unit x along the building's top edge; y is x rotated -90deg
        # (local y grows toward the bottom of the drawing)
        self.ux = (e / norm, n / norm)
        self.uy = (self.ux[1], -self.ux[0])
        self._m_lat, self._m_lng = m_per_deg_lat, m_per_deg_lng
        log.info("geo anchors set: origin=(%.6f,%.6f) edge length=%.1f m", self.lat0, self.lng0, norm)

    def to_local(self, lat: float, lng: float) -> tuple[float, float]:
        e = (lng - self.lng0) * self._m_lng
        n = (lat - self.lat0) * self._m_lat
        x = e * self.ux[0] + n * self.ux[1]
        y = e * self.uy[0] + n * self.uy[1]
        return x, y


class Kalman2D:
    """Constant-velocity Kalman filter, hand-rolled (state: x, y, vx, vy)."""

    def __init__(self, q: float = 0.6):
        self.q = q
        self.x = [0.0, 0.0, 0.0, 0.0]
        self.P = [[100.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self.initialized = False

    def predict(self, dt: float):
        if not self.initialized or dt <= 0:
            return
        x, y, vx, vy = self.x
        self.x = [x + vx * dt, y + vy * dt, vx, vy]
        P = self.P
        for i in (0, 1):
            v = i + 2
            P[i][i] += dt * (P[v][i] + P[i][v]) + dt * dt * P[v][v]
            P[i][v] += dt * P[v][v]
            P[v][i] += dt * P[v][v]
        qd = self.q * dt
        P[0][0] += qd; P[1][1] += qd
        P[2][2] += qd * 2; P[3][3] += qd * 2

    def update(self, mx: float, my: float, r: float):
        if not self.initialized:
            self.x = [mx, my, 0.0, 0.0]
            self.initialized = True
            return
        r = max(r, 1.0)
        for axis, m in ((0, mx), (1, my)):
            innov = m - self.x[axis]
            s = self.P[axis][axis] + r * r
            for i in range(4):
                k = self.P[i][axis] / s
                self.x[i] += k * innov
                for j in range(4):
                    self.P[i][j] -= k * self.P[axis][j]


# ---------------------------------------------------------------------------
# Map model
# ---------------------------------------------------------------------------
class MapModel:
    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.site = data["site"]
        self.floors = data["floors"]
        self.floor_z = {str(f["level"]): f["z"] for f in self.site["floors"]}
        self.levels = sorted(self.floor_z, key=lambda k: self.floor_z[k])
        # walkable segments per floor, from graph edges
        self.segments: dict[str, list[tuple]] = {}
        for level, floor in self.floors.items():
            nodes = {n["id"]: n for n in floor["nodes"]}
            self.segments[level] = [
                (nodes[a]["x"], nodes[a]["y"], nodes[b]["x"], nodes[b]["y"])
                for a, b in floor["edges"]
            ]
        log.info("map model loaded: floors=%s", ", ".join(self.levels))

    def classify_floor(self, z: float) -> str | None:
        best, best_d = None, 1e9
        for level, fz in self.floor_z.items():
            d = abs(z - fz)
            if d < best_d:
                best, best_d = level, d
        return best if best_d <= FLOOR_CAPTURE_BAND_M else None

    def snap(self, level: str, x: float, y: float) -> tuple[float, float, float]:
        """Project onto the nearest walkable edge of the floor."""
        best = (x, y, 1e9)
        for ax, ay, bx, by in self.segments.get(level, []):
            qx, qy, d = nearest_point_on_segment(x, y, ax, ay, bx, by)
            if d < best[2]:
                best = (qx, qy, d)
        return best


# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------
@dataclass
class DeviceState:
    pressure: float = 0.0
    temp_c: float = 20.0
    rssi: int = 0
    seq: int = 0
    last_seen: float = 0.0
    online: bool = False
    role: str = "user"


@dataclass
class UserState:
    uid: str
    device_id: str | None = None
    kf: Kalman2D = field(default_factory=Kalman2D)
    last_gps: float = 0.0
    gps_acc: float = 30.0
    last_kf_time: float = 0.0
    floor: str | None = None
    floor_votes: list = field(default_factory=list)
    manual_floor: str | None = None   # GPS-only mode: floor chosen by the user
    admitted: bool = False
    queued_at: float = 0.0        # when the user (re)became active - FIFO fairness
    notified: str = ""            # last control state sent ("admit"/"reject")
    last_reject_note: float = 0.0
    session_row: int | None = None

    def is_active(self, now: float) -> bool:
        return self.last_gps > 0 and (now - self.last_gps) < GPS_STALE_S


class Engine:
    def __init__(self):
        self.map = MapModel(MAP_MODEL_PATH)
        anchors = self.map.site["geoAnchors"]
        self.geo = GeoConverter(anchors["origin"], anchors["xAxis"], self.map.site["width"])
        self.devices: dict[str, DeviceState] = {}
        self.users: dict[str, UserState] = {}
        self.ref_pressure: float | None = None   # EMA of the reference node
        self.ref_temp = 20.0
        self.ref_last = 0.0
        self.ref_floor_z = 0.0                    # reference node sits on floor 2 (z=0)
        self._dir_key = None                      # last published directory fingerprint
        self._dir_last_pub = 0.0
        self.lock = threading.Lock()
        self.running = True

        self.supa = None
        if SUPABASE_URL and SUPABASE_SERVICE_KEY and _create_supabase:
            try:
                self.supa = _create_supabase(SUPABASE_URL, SUPABASE_SERVICE_KEY)
                log.info("supabase session logging enabled")
            except Exception as exc:
                log.warning("supabase disabled: %s", exc)

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id="libnav-engine", clean_session=True
        )
        if MQTT_USER:
            self.client.username_pw_set(MQTT_USER, MQTT_PASS)
        if MQTT_TLS:
            self.client.tls_set()
        self.client.will_set("libnav/engine/status", "offline", qos=1, retain=True)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(1, 30)

    # ------------------------------------------------------------------ MQTT
    def on_connect(self, client, userdata, flags, reason_code, properties):
        log.info("mqtt connected: %s", reason_code)
        client.subscribe([
            ("libnav/dev/+/telemetry", 0),
            ("libnav/dev/+/status", 1),
            ("libnav/user/+/gps", 0),
            ("libnav/user/+/pair", 1),
            ("libnav/user/+/floor", 1),
            ("libnav/user/+/presence", 1),
            ("libnav/site/anchors", 1),
        ])
        client.publish("libnav/engine/status", "online", qos=1, retain=True)

    def on_message(self, client, userdata, msg):
        try:
            parts = msg.topic.split("/")
            if parts[1] == "dev" and parts[3] == "telemetry":
                self.handle_telemetry(json.loads(msg.payload))
            elif parts[1] == "dev" and parts[3] == "status":
                self.handle_dev_status(parts[2], msg.payload.decode())
            elif parts[1] == "user" and parts[3] == "gps":
                self.handle_gps(parts[2], json.loads(msg.payload))
            elif parts[1] == "user" and parts[3] == "pair":
                self.handle_pair(parts[2], msg.payload)
            elif parts[1] == "user" and parts[3] == "floor":
                self.handle_floor(parts[2], msg.payload)
            elif parts[1] == "user" and parts[3] == "presence":
                self.handle_presence(parts[2], msg.payload.decode())
            elif parts[1] == "site" and parts[2] == "anchors":
                self.handle_anchors(json.loads(msg.payload))
        except Exception as exc:
            log.warning("bad message on %s: %s", msg.topic, exc)

    # ------------------------------------------------------------ handlers
    def handle_telemetry(self, data: dict):
        now = time.time()
        dev_id = data["id"]
        with self.lock:
            dev = self.devices.setdefault(dev_id, DeviceState())
            dev.pressure = float(data["p"])
            dev.temp_c = float(data.get("t", 20.0))
            dev.rssi = int(data.get("rssi", 0))
            dev.seq = int(data.get("seq", 0))
            dev.last_seen = now
            dev.online = True
            dev.role = data.get("role", "user")
            if data.get("role") == "reference":
                # EMA smooths sensor noise while tracking weather drift
                if self.ref_pressure is None:
                    self.ref_pressure = dev.pressure
                else:
                    self.ref_pressure += 0.05 * (dev.pressure - self.ref_pressure)
                self.ref_temp = dev.temp_c
                self.ref_last = now

    def handle_dev_status(self, dev_id: str, status: str):
        with self.lock:
            dev = self.devices.setdefault(dev_id, DeviceState())
            dev.online = status == "online"
        log.info("device %s is %s", dev_id, status)

    def handle_gps(self, uid: str, data: dict):
        now = time.time()
        acc = float(data.get("acc", 30.0))
        if acc > 100.0:
            return  # unusable fix - skip rather than corrupt the filter
        x, y = self.geo.to_local(float(data["lat"]), float(data["lng"]))
        # clamp into the site bounding box to reject wild GPS outliers
        x = max(-10.0, min(self.map.site["width"] + 10.0, x))
        y = max(-10.0, min(self.map.site["depth"] + 10.0, y))
        with self.lock:
            user = self.users.setdefault(uid, UserState(uid))
            if not user.is_active(now):
                user.queued_at = now  # (re)joining the admission queue
            user.kf.predict(now - user.last_kf_time if user.last_kf_time else 0.0)
            # down-weight a fix that implies an implausible speed (>3 m/s of
            # unexplained jump beyond its own accuracy) so one bad reading can't
            # snap the marker across the room
            r = acc / 2.0
            if user.kf.initialized:
                jump = math.hypot(x - user.kf.x[0], y - user.kf.x[1])
                dt = max(0.1, now - user.last_kf_time)
                if jump - acc > 3.0 * dt:
                    r *= 4.0
            user.kf.update(x, y, r)
            user.last_kf_time = now
            user.last_gps = now
            user.gps_acc = acc

    def handle_pair(self, uid: str, payload: bytes):
        device_id = None
        if payload:
            try:
                device_id = json.loads(payload).get("device") or None
            except json.JSONDecodeError:
                pass
        now = time.time()
        with self.lock:
            user = self.users.setdefault(uid, UserState(uid))
            if device_id:
                dev = self.devices.get(device_id)
                if dev and dev.role == "reference":
                    self.notify(uid, "pair_denied", reason="reference", device=device_id)
                    return
                owner = next(
                    (u for u in self.users.values()
                     if u.uid != uid and u.device_id == device_id and u.is_active(now)),
                    None,
                )
                if owner:
                    self.notify(uid, "pair_denied", reason="in-use", device=device_id)
                    log.info("user %s denied pairing %s (held by %s)", uid, device_id, owner.uid)
                    return
                user.device_id = device_id
                self.notify(uid, "pair_ok", device=device_id)
            else:
                user.device_id = None
        log.info("user %s paired with %s", uid, device_id or "(nothing)")

    def handle_anchors(self, data: dict):
        try:
            self.geo.set_anchors(data["origin"], data["xAxis"])
        except (KeyError, TypeError) as exc:
            log.warning("ignored bad anchors payload: %s", exc)

    def handle_floor(self, uid: str, payload: bytes):
        """GPS-only mode: the user states which floor they are on (retained;
        empty payload returns control to the barometric sensor)."""
        floor = None
        if payload:
            try:
                candidate = str(json.loads(payload).get("floor", ""))
                if candidate in self.map.floor_z:
                    floor = candidate
            except json.JSONDecodeError:
                pass
        with self.lock:
            user = self.users.setdefault(uid, UserState(uid))
            user.manual_floor = floor
        log.info("user %s manual floor -> %s", uid, floor or "(auto)")

    def handle_presence(self, uid: str, status: str):
        """Web-client LWT: an 'offline' releases the slot immediately instead
        of waiting for the 30 s GPS staleness window."""
        if status != "offline":
            return
        with self.lock:
            user = self.users.get(uid)
            if user and user.last_gps > 0:
                # push just past the staleness window: inactive now, pruned later
                user.last_gps = time.time() - GPS_STALE_S - 1
                log.info("user %s went offline (presence) - slot released", uid)

    # ------------------------------------------------------------ capacity
    def review_capacity(self):
        """Runs every tick: demote stale users, admit waiting ones FIFO, and
        keep queued clients informed. Notifications fire on state changes,
        plus a 5 s reject heartbeat so a client that missed a message (or the
        engine's earlier state) always converges to the truth."""
        now = time.time()

        for user in self.users.values():
            if user.admitted and not user.is_active(now):
                user.admitted = False
                user.notified = ""
                self.log_session_end(user)
                log.info("user %s inactive - slot released", user.uid)

        active = [u for u in self.users.values() if u.is_active(now)]
        admitted_n = sum(1 for u in active if u.admitted)
        free = MAX_ACTIVE_USERS - admitted_n
        waiting = sorted((u for u in active if not u.admitted), key=lambda u: u.queued_at)

        for user in waiting:
            if free > 0:
                user.admitted = True
                free -= 1
                admitted_n += 1
                self.notify(user.uid, "admit", slots=free, active=admitted_n)
                user.notified = "admit"
                self.log_session_start(user)
            elif user.notified != "reject" or now - user.last_reject_note > 5.0:
                self.notify(user.uid, "reject", reason="capacity", slots=0, active=admitted_n)
                user.notified = "reject"
                user.last_reject_note = now

        # forget users idle for a long time so phantom uids never accumulate
        for uid in [u for u, s in self.users.items()
                    if s.last_gps > 0 and now - s.last_gps > 900]:
            del self.users[uid]

    def notify(self, uid: str, action: str, reason: str = "", slots: int = 0,
               active: int = 0, device: str = ""):
        self.client.publish(
            f"libnav/user/{uid}/control",
            json.dumps({"action": action, "reason": reason, "slots": slots,
                        "active": active, "max": MAX_ACTIVE_USERS, "device": device,
                        "ts": int(time.time() * 1000)}),
            qos=1,
        )
        log.info("user %s -> %s %s%s (active=%d/%d)", uid, action, reason,
                 f" [{device}]" if device else "", active, MAX_ACTIVE_USERS)

    # ------------------------------------------------------------ discovery
    def publish_directory(self, now: float):
        """Retained device directory the web app uses for 'scan nearby
        sensors': online state, signal strength, and who holds each unit.
        Republished only when something meaningful changes (or every 10 s)."""
        claims = {
            u.device_id: u.uid
            for u in self.users.values()
            if u.device_id and u.is_active(now)
        }
        entries = []
        for dev_id in sorted(self.devices):
            dev = self.devices[dev_id]
            online = dev.online and (now - dev.last_seen) < PRESSURE_STALE_S
            entries.append({
                "id": dev_id,
                "role": dev.role,
                "online": online,
                "rssi": dev.rssi if online else None,
                "ageS": int(now - dev.last_seen) if dev.last_seen else None,
                "pairedBy": claims.get(dev_id),
            })
        key = tuple(
            (e["id"], e["role"], e["online"], e["pairedBy"],
             (e["rssi"] or 0) // 5)
            for e in entries
        )
        if key != self._dir_key or now - self._dir_last_pub > 10:
            self._dir_key = key
            self._dir_last_pub = now
            self.client.publish(
                "libnav/directory",
                json.dumps({"devices": entries, "ts": int(now * 1000)}),
                qos=0, retain=True,
            )

    def log_session_start(self, user: UserState):
        if not self.supa:
            return
        try:
            row = self.supa.table("sessions").insert(
                {"user_id": user.uid, "device_id": user.device_id}
            ).execute()
            user.session_row = row.data[0]["id"]
        except Exception as exc:
            log.warning("session insert failed: %s", exc)

    def log_session_end(self, user: UserState):
        if not self.supa or user.session_row is None:
            return
        try:
            self.supa.table("sessions").update(
                {"ended_at": "now()"}
            ).eq("id", user.session_row).execute()
        except Exception as exc:
            log.warning("session update failed: %s", exc)
        user.session_row = None

    # ------------------------------------------------------------ fusion
    def altitude_of(self, dev: DeviceState) -> float | None:
        if self.ref_pressure is None or time.time() - self.ref_last > PRESSURE_STALE_S:
            return None
        if time.time() - dev.last_seen > PRESSURE_STALE_S:
            return None
        t_mean_k = 273.15 + (dev.temp_c + self.ref_temp) / 2.0
        dz = (R_GAS * t_mean_k) / (G0 * M_AIR) * math.log(self.ref_pressure / dev.pressure)
        return self.ref_floor_z + dz

    def tick(self):
        now = time.time()
        with self.lock:
            self.review_capacity()
            self.publish_directory(now)
            for user in list(self.users.values()):
                if not user.is_active(now):
                    continue
                if not user.admitted or not user.kf.initialized:
                    continue

                user.kf.predict(now - user.last_kf_time)
                user.last_kf_time = now
                x, y = user.kf.x[0], user.kf.x[1]

                # ---- floor from differential barometry
                dev = self.devices.get(user.device_id) if user.device_id else None
                pressure_ok = False
                if dev:
                    z_est = self.altitude_of(dev)
                    if z_est is not None:
                        pressure_ok = True
                        vote = self.map.classify_floor(z_est)
                        if vote:
                            user.floor_votes.append(vote)
                            user.floor_votes = user.floor_votes[-FLOOR_SWITCH_SAMPLES:]
                            if (
                                len(user.floor_votes) == FLOOR_SWITCH_SAMPLES
                                and len(set(user.floor_votes)) == 1
                                and user.floor != vote
                            ):
                                user.floor = vote
                                log.info("user %s now on floor %s", user.uid, vote)
                # floor precedence: fresh sensor > user-set manual > entrance
                if not pressure_ok and user.manual_floor:
                    user.floor = user.manual_floor
                if user.floor is None:
                    user.floor = self.map.levels[0]

                # ---- snap to walkable graph
                sx, sy, dist = self.map.snap(user.floor, x, y)
                if dist <= SNAP_MAX_DIST_M:
                    x, y = sx, sy

                payload = {
                    "x": round(x, 2),
                    "y": round(y, 2),
                    "z": self.map.floor_z[user.floor],
                    "floor": int(user.floor),
                    "q": {
                        "gpsAcc": round(user.gps_acc, 1),
                        "pressureOk": pressure_ok,
                        "mode": "sensor" if pressure_ok
                                else ("manual" if user.manual_floor else "default"),
                        "rssi": dev.rssi if dev else None,
                        "snapDist": round(dist, 1),
                    },
                    "ts": int(now * 1000),
                }
                self.client.publish(
                    f"libnav/user/{user.uid}/pos", json.dumps(payload), qos=0, retain=True
                )

    # ------------------------------------------------------------ lifecycle
    def run(self):
        proto = "tls" if MQTT_TLS else "tcp"
        log.info("connecting to %s:%s (%s)", MQTT_HOST, MQTT_PORT, proto)
        self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=20)
        self.client.loop_start()
        interval = 1.0 / PUBLISH_HZ
        try:
            while self.running:
                t0 = time.time()
                self.tick()
                time.sleep(max(0.0, interval - (time.time() - t0)))
        finally:
            self.client.publish("libnav/engine/status", "offline", qos=1, retain=True)
            self.client.loop_stop()
            self.client.disconnect()

    def stop(self, *_):
        self.running = False


def main():
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s"
    )
    engine = Engine()
    signal.signal(signal.SIGINT, engine.stop)
    signal.signal(signal.SIGTERM, engine.stop)
    engine.run()


if __name__ == "__main__":
    main()
