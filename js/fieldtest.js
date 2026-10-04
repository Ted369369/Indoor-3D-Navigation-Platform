/*
 * Field test: records what the app sees during a test walk and works out how
 * well it did, so nobody has to write numbers down on site.
 *
 * Everything stays on the phone (IndexedDB) until it's downloaded. The tester
 * only taps for what the app can't know by itself: which floor they really
 * reached, and where they're really standing.
 *
 * Event kinds (t is always ms since 1970):
 *   start   {lib, libName, device, mode, appMode, calibrated, version, ua}
 *   truth   {f, why}           the floor the tester says they're on
 *   trip    {phase, from, to, via}   go | cancel
 *   pos     {x, y, f, mode, acc, z, snap}   what the map showed
 *   gps     {lat, lng, acc, x, y}   raw phone fix (x, y only on a calibrated map)
 *   tel     {id, role, p, temp, rssi, up, seq}   sensor packets
 *   mark    {x, y, f, dur, label}   "I'm standing here" (positions listened to for dur ms)
 *   still   {phase, f}          start | end | cancel
 *   lat     {ms}                server round trip
 *   route   {phase, ...}        start | reroute | end
 *   rate    {ok, note}          how the last directions went
 *   search  {q, kind, zone}
 *   note    {text}
 *   vis     {hidden}            screen on/off
 *   engine, mqtt, floor         connection and manual floor changes
 */
import { icon } from "./icons.js?v=ft1";

const DB_NAME = "libnav-fieldtest";
const FLUSH_MS = 5000;
const GRACE_MS = 20000;      // after arriving, the app has this long before a wrong floor counts
const SWITCH_LIMIT_MS = 30000; // a floor switch later than this after arriving is a miss
const HYPSO = 8.3145 / (9.80665 * 0.0289644); // metres per kelvin, same constants as the engine

/* ============================================================ storage */
class Store {
  constructor() {
    this.db = null;
    this.memSessions = new Map();
    this.memChunks = new Map(); // id -> [{n, events}]
  }

  async open() {
    if (typeof indexedDB === "undefined") return false;
    try {
      this.db = await Promise.race([
        new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore("sessions", { keyPath: "id" });
            req.result.createObjectStore("chunks", { keyPath: ["s", "n"] });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error("blocked"));
        }),
        // another tab holding the database mustn't stall the app
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
      ]);
      return true;
    } catch {
      this.db = null;
      return false;
    }
  }

  _run(name, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  _range(id) {
    return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  }

  async putSession(meta) {
    if (!this.db) { this.memSessions.set(meta.id, { ...meta }); return; }
    await this._run("sessions", "readwrite", (s) => s.put(meta));
  }

  async sessions() {
    if (!this.db) return [...this.memSessions.values()];
    return (await this._run("sessions", "readonly", (s) => s.getAll())) || [];
  }

  async putChunk(id, n, events) {
    if (!this.db) {
      if (!this.memChunks.has(id)) this.memChunks.set(id, []);
      this.memChunks.get(id).push({ n, events });
      return;
    }
    await this._run("chunks", "readwrite", (s) => s.put({ s: id, n, events }));
  }

  async chunks(id) {
    if (!this.db) return [...(this.memChunks.get(id) || [])];
    return (await this._run("chunks", "readonly", (s) => s.getAll(this._range(id)))) || [];
  }

  async remove(id) {
    if (!this.db) { this.memSessions.delete(id); this.memChunks.delete(id); return; }
    await this._run("chunks", "readwrite", (s) => s.delete(this._range(id)));
    await this._run("sessions", "readwrite", (s) => s.delete(id));
  }
}

/* ============================================================ recorder */
export class FieldTest extends EventTarget {
  constructor() {
    super();
    this.store = new Store();
    this.session = null; // meta of the test being recorded
    this.buffer = [];
    this.next = 0;       // next chunk number
    this.truth = null;   // the floor the tester last confirmed
    this.saved = false;  // false when the browser won't keep data (private mode)
    this._timer = null;
    this._wake = null;
  }

  get active() {
    return !!this.session && !this.session.ended;
  }

  async init(lib) {
    this.saved = await this.store.open();
    const open = (await this.store.sessions()).find((m) => !m.ended && m.lib === lib);
    if (open) await this._resume(open);
    addEventListener("pagehide", () => this.flush());
    document.addEventListener("visibilitychange", () => {
      if (!this.active) return;
      this.log("vis", { hidden: document.hidden });
      if (document.hidden) this.flush();
      else this._keepAwake();
    });
  }

  async _resume(meta) {
    this.session = meta;
    const chunks = await this.store.chunks(meta.id);
    this.next = chunks.reduce((n, c) => Math.max(n, c.n + 1), 0);
    const events = chunks.sort((a, b) => a.n - b.n).flatMap((c) => c.events);
    const lastTruth = [...events].reverse().find((e) => e.k === "truth");
    this.truth = lastTruth ? String(lastTruth.f) : null;
    // a trip that was under way when the page went away can't be finished now
    const lastTrip = [...events].reverse().find((e) => e.k === "trip");
    if (lastTrip?.phase === "go" && (!lastTruth || lastTruth.t < lastTrip.t)) {
      this.log("trip", { phase: "cancel", why: "reload" });
    }
    this.log("resume");
    this._startTimers();
    this._changed();
  }

  async start(meta) {
    if (this.active) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    this.session = { id: `${stamp}-${Math.random().toString(36).slice(2, 6)}`, started: Date.now(), ended: null, ...meta };
    this.buffer = [];
    this.next = 0;
    this.truth = null;
    await this.store.putSession(this.session);
    this.log("start", meta);
    this._startTimers();
    this._changed();
  }

  /** Add an event while recording. data.t may back-date it. */
  log(k, data = {}) {
    if (!this.active) return null;
    const ev = { k, t: Date.now(), ...data };
    if (k === "truth") this.truth = String(data.f);
    this.buffer.push(ev);
    return ev;
  }

  async flush() {
    if (!this.session || !this.buffer.length) return;
    const events = this.buffer.splice(0);
    const n = this.next++;
    try {
      await this.store.putChunk(this.session.id, n, events);
    } catch {
      this.buffer.unshift(...events); // try again with the next flush
    }
  }

  async stop() {
    if (!this.active) return null;
    this.log("stop");
    await this.flush();
    const meta = this.session;
    meta.ended = Date.now();
    this._stopTimers();
    await this.store.putSession(meta);
    this._changed();
    return meta;
  }

  async list() {
    return (await this.store.sessions()).sort((a, b) => b.started - a.started);
  }

  async events(id) {
    if (this.session?.id === id) await this.flush();
    const chunks = await this.store.chunks(id);
    return chunks.sort((a, b) => a.n - b.n).flatMap((c) => c.events);
  }

  async saveMeta(meta) {
    await this.store.putSession(meta);
  }

  async remove(id) {
    if (this.session?.id === id) return;
    await this.store.remove(id);
    this._changed();
  }

  _startTimers() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this.flush(), FLUSH_MS);
    this._keepAwake();
  }

  _stopTimers() {
    clearInterval(this._timer);
    this._timer = null;
    this._wake?.release().catch(() => {});
    this._wake = null;
  }

  async _keepAwake() {
    // a locked phone stops the page, and with it the recording
    try {
      if (this.active && navigator.wakeLock && !document.hidden) {
        this._wake = await navigator.wakeLock.request("screen");
      }
    } catch { /* not allowed right now */ }
  }

  _changed() {
    this.dispatchEvent(new Event("change"));
  }
}

/* ============================================================ maths */
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function quantile(values, q) {
  const a = values.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);
function sd(a) {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** Work out everything the report says from the raw events. */
export function analyze(events, model) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const of = (k) => ev.filter((e) => e.k === k);
  const start = ev.find((e) => e.k === "start") || {};
  const t0 = start.t ?? ev[0]?.t ?? 0;
  const t1 = ev.length ? ev[ev.length - 1].t : t0;
  const levels = model.site.floors.map((f) => String(f.level));
  const floorZ = Object.fromEntries(model.site.floors.map((f) => [String(f.level), f.z]));

  // ---- screen-off spans: nothing is recorded while the page sleeps
  const hidden = [];
  for (const e of of("vis")) {
    if (e.hidden) hidden.push([e.t, t1]);
    else if (hidden.length && hidden[hidden.length - 1][1] === t1) hidden[hidden.length - 1][1] = e.t;
  }
  const hiddenMs = hidden.reduce((s, [a, b]) => s + (b - a), 0);

  // ---- where the tester said they were
  const truths = of("truth").map((e) => ({ t: e.t, f: String(e.f) }));
  const truthAt = (t) => {
    let f = null;
    for (const x of truths) { if (x.t <= t) f = x.f; else break; }
    return f;
  };

  // ---- what the map showed; only sensor positions say anything about floors
  const pos = of("pos");
  const sensorPos = pos.filter((p) => p.mode === "sensor");

  // ---- floor trips
  const goes = of("trip").filter((e) => e.phase === "go");
  const trips = [];
  const busy = []; // windows where a wrong floor is expected (on the stairs)
  goes.forEach((go, i) => {
    const nextGo = goes[i + 1]?.t ?? Infinity;
    const end = ev.find((e) => e.t > go.t && e.t < nextGo &&
      ((e.k === "truth" && e.why === "trip") || (e.k === "trip" && e.phase === "cancel")));
    if (!end || end.k !== "truth") {
      busy.push([go.t, end ? end.t + GRACE_MS : Math.min(nextGo, t1)]);
      return;
    }
    const arrive = end.t;
    const from = String(go.from), to = String(go.to);
    busy.push([go.t, arrive + GRACE_MS]);
    const until = Math.min(nextGo, arrive + SWITCH_LIMIT_MS + 30000);
    let detectAt = null, wrong = null, seen = 0;
    for (const p of sensorPos) {
      if (p.t < go.t) continue;
      if (p.t > until) break;
      seen++;
      const f = String(p.f);
      if (f !== to && f !== from && wrong == null) wrong = f;
      if (f === to && detectAt == null) detectAt = p.t;
      // went back to the old floor before arriving: wait for it to settle again
      if (f !== to && detectAt != null && p.t <= arrive + SWITCH_LIMIT_MS) detectAt = null;
    }
    const delay = detectAt != null ? (detectAt - arrive) / 1000 : null;
    trips.push({
      n: trips.length + 1, t: go.t, arrive, from, to, via: go.via || "",
      walkS: (arrive - go.t) / 1000, detectAt, delay, wrong,
      noData: seen === 0,
      ok: seen > 0 && detectAt != null && detectAt - arrive <= SWITCH_LIMIT_MS && wrong == null,
    });
  });
  const inBusy = (t) => busy.some(([a, b]) => t >= a && t <= b);
  const measured = trips.filter((tr) => !tr.noData);
  const delays = measured.filter((tr) => tr.ok).map((tr) => tr.delay);

  // ---- staying on one floor
  const settled = sensorPos.filter((p) => truthAt(p.t) && !inBusy(p.t));
  const rightSamples = settled.filter((p) => String(p.f) === truthAt(p.t)).length;
  let falseSwitches = 0;
  for (let i = 1; i < settled.length; i++) {
    const a = settled[i - 1], b = settled[i];
    if (b.t - a.t < 5000 && String(a.f) !== String(b.f)) falseSwitches++;
  }

  // ---- barometric height: own maths from both sensors, else the engine's
  const tel = of("tel");
  const device = start.device || "";
  const mine = tel.filter((e) => e.id === device && e.role !== "reference");
  const refs = tel.filter((e) => e.role === "reference");
  let heights = [];
  let heightSource = null;
  if (mine.length && refs.length) {
    let j = 0;
    for (const m of mine) {
      while (j + 1 < refs.length && Math.abs(refs[j + 1].t - m.t) <= Math.abs(refs[j].t - m.t)) j++;
      const r = refs[j];
      if (Math.abs(r.t - m.t) > 3000 || !(m.p > 0) || !(r.p > 0)) continue;
      const kelvin = 273.15 + ((m.temp ?? 20) + (r.temp ?? 20)) / 2;
      heights.push({ t: m.t, h: HYPSO * kelvin * Math.log(r.p / m.p) });
    }
    heightSource = "sensors";
  }
  if (!heights.length) {
    heights = sensorPos.filter((p) => p.z != null).map((p) => ({ t: p.t, h: p.z }));
    heightSource = heights.length ? "engine" : null;
  }
  const stills = [];
  let open = null;
  for (const e of of("still")) {
    if (e.phase === "start") open = e;
    else if (e.phase === "end" && open) { stills.push({ a: open.t, b: e.t, f: String(open.f) }); open = null; }
    else open = null;
  }
  const perFloor = {};
  for (const level of levels) {
    const still = heights.filter((h) => stills.some((s) => s.f === level && h.t >= s.a && h.t <= s.b)).map((h) => h.h);
    const loose = heights.filter((h) => truthAt(h.t) === level && !inBusy(h.t)).map((h) => h.h);
    const use = still.length >= 10 ? still : loose;
    if (use.length) perFloor[level] = { mean: avg(use), sd: sd(use), n: use.length, from: use === still ? "still" : "walk" };
  }
  const gaps = [];
  for (let i = 1; i < levels.length; i++) {
    const a = perFloor[levels[i - 1]], b = perFloor[levels[i]];
    if (a && b) {
      gaps.push({
        from: levels[i - 1], to: levels[i], measured: b.mean - a.mean,
        model: floorZ[levels[i]] - floorZ[levels[i - 1]],
      });
    }
  }
  const stillNoise = avg(stills.map((s) => sd(heights.filter((h) => h.t >= s.a && h.t <= s.b).map((h) => h.h))).filter((v) => v != null));

  // ---- spots: where the tester stood vs what the map showed
  const gps = of("gps");
  const spots = of("mark").map((m, i) => {
    const a = m.t, b = m.t + (m.dur || 10000);
    let shown = pos.filter((p) => p.t >= a && p.t <= b);
    if (!shown.length) shown = pos.filter((p) => p.t < a && a - p.t < 5000).slice(-1);
    const onFloor = shown.filter((p) => String(p.f) === String(m.f));
    const use = onFloor.length ? onFloor : shown;
    const sx = avg(use.map((p) => p.x)), sy = avg(use.map((p) => p.y));
    const raw = gps.filter((g) => g.t >= a - 2000 && g.t <= b && g.x != null);
    const rx = avg(raw.map((g) => g.x)), ry = avg(raw.map((g) => g.y));
    return {
      n: i + 1, t: m.t, label: m.label || "", f: String(m.f), x: m.x, y: m.y,
      err: sx != null ? Math.hypot(sx - m.x, sy - m.y) : null,
      rawErr: rx != null ? Math.hypot(rx - m.x, ry - m.y) : null,
      floorOk: shown.length ? onFloor.length === shown.length : null,
      acc: avg(raw.map((g) => g.acc)) ?? avg(shown.map((p) => p.acc).filter((v) => v != null)),
      samples: shown.length,
    };
  });
  const spotErrs = spots.map((s) => s.err).filter((v) => v != null);
  const rawErrs = spots.map((s) => s.rawErr).filter((v) => v != null);

  // ---- sensors
  const devices = [];
  const byId = new Map();
  for (const e of tel) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  for (const [id, list] of byId) {
    let gapCount = 0, longest = 0, lost = 0, expected = 0, reboots = 0;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const dt = b.t - a.t;
      const asleep = hidden.some(([x, y]) => a.t < y && b.t > x);
      if (dt > 5000 && !asleep) { gapCount++; longest = Math.max(longest, dt); }
      if (a.seq != null && b.seq != null && b.seq > a.seq && !asleep) {
        expected += b.seq - a.seq;
        lost += b.seq - a.seq - 1;
      }
      if (a.up != null && b.up != null && b.up < a.up) reboots++;
    }
    devices.push({
      id, role: list[0].role || "user", first: list[0].t, last: list[list.length - 1].t, packets: list.length,
      gaps: gapCount, longestGapS: longest / 1000, lostPct: expected ? (100 * lost) / expected : null,
      rssi: median(list.map((e) => e.rssi).filter((v) => v != null)), reboots,
      upS: list[list.length - 1].up ?? null,
    });
  }

  // ---- directions
  const routes = [];
  let cur = null;
  for (const e of ev) {
    if (e.k === "route" && e.phase === "start") {
      if (cur && !cur.end) cur.end = e.t;
      cur = { t: e.t, name: e.name || "", m: e.m || 0, profile: e.profile || "", reroutes: 0, end: null, arrived: false, rating: null, note: "" };
      routes.push(cur);
    } else if (e.k === "route" && e.phase === "reroute" && cur && !cur.end) {
      cur.reroutes++;
    } else if (e.k === "route" && e.phase === "end" && cur && !cur.end) {
      cur.end = e.t;
      cur.arrived = !!e.arrived;
    } else if (e.k === "rate") {
      const last = [...routes].reverse().find((r) => r.end && e.t - r.end < 10 * 60000);
      if (last) { last.rating = e.ok; last.note = e.note || ""; }
    }
  }
  for (const r of routes) {
    r.secs = r.end ? (r.end - r.t) / 1000 : null;
    r.speed = r.arrived && r.secs ? r.m / r.secs : null;
  }

  // ---- the rest
  const lat = of("lat").map((e) => e.ms);
  const accs = gps.map((g) => g.acc).filter((v) => v != null);
  const searches = of("search");
  return {
    t0, t1, durationS: (t1 - t0) / 1000, start, levels, floorZ, hiddenMs,
    floors: {
      sensor: sensorPos.length > 0,
      trips, measured: measured.length, ok: measured.filter((tr) => tr.ok).length,
      medianDelay: median(delays), maxDelay: delays.length ? Math.max(...delays) : null,
      settledPct: settled.length ? (100 * rightSamples) / settled.length : null,
      settledSamples: settled.length, falseSwitches,
      truths, app: sensorPos.map((p) => [p.t, String(p.f)]),
    },
    height: { source: heightSource, series: heights, perFloor, gaps, stills: stills.length, noise: stillNoise },
    spots: {
      list: spots, median: median(spotErrs), p90: quantile(spotErrs, 0.9),
      max: spotErrs.length ? Math.max(...spotErrs) : null,
      within: (m) => (spotErrs.length ? (100 * spotErrs.filter((v) => v <= m).length) / spotErrs.length : null),
      rawMedian: median(rawErrs),
      wrongFloor: spots.filter((s) => s.floorOk === false).length,
    },
    devices,
    routes,
    searches: {
      list: searches.map((e) => ({ t: e.t, q: e.q, kind: e.kind, name: e.name || "" })),
      unknown: searches.filter((e) => e.kind === "unknown").length,
    },
    notes: of("note").map((e) => ({ t: e.t, text: e.text })),
    latency: { n: lat.length, median: median(lat), p90: quantile(lat, 0.9), max: lat.length ? Math.max(...lat) : null },
    gps: {
      n: gps.length, medianAcc: median(accs),
      within: (m) => (accs.length ? (100 * accs.filter((a) => a <= m).length) / accs.length : null),
    },
  };
}

/** A few numbers for the list of past tests. */
export function brief(an) {
  return {
    durationS: an.durationS, trips: an.floors.measured, tripsOk: an.floors.ok,
    spots: an.spots.list.length, spotMedian: an.spots.median,
  };
}

/* ============================================================ search check */
/** Run the library's test searches through the search engine. */
export function checkSearch(engine, tests, zones) {
  return (tests || []).map((tc) => {
    const r = engine.resolve(tc.q);
    let ok = false;
    if (tc.zone) ok = r.kind === "zone" && r.zoneId === tc.zone;
    else if (tc.intent) ok = r.kind === "nearest" && r.intent === tc.intent;
    else if (tc.floor != null) ok = r.kind === "zone" && String(zones[r.zoneId]?.floor) === String(tc.floor);
    const got = r.kind === "zone" ? zones[r.zoneId]?.name || r.zoneId
      : r.kind === "nearest" ? `nearest ${r.intent.replace(/^nearest_/, "").replace(/_/g, " ")}`
        : "nothing";
    const want = tc.zone ? zones[tc.zone]?.name || tc.zone
      : tc.intent ? `nearest ${tc.intent.replace(/^nearest_/, "").replace(/_/g, " ")}`
        : `floor ${tc.floor}`;
    return { q: tc.q, ok, got, want };
  });
}

/* ============================================================ exports */
function units(kind) {
  const ft = kind === "imperial";
  return {
    ft,
    near: ft ? 15 / 3.281 : 5,  // a close spot: 15 ft or 5 m
    fair: ft ? 30 / 3.281 : 10, // decent GPS: 30 ft or 10 m
    dist: (m) => (m == null ? "–" : ft ? `${Math.round(m * 3.281)} ft` : `${m < 10 ? m.toFixed(1) : Math.round(m)} m`),
    height: (m) => (m == null ? "–" : ft ? `${(m * 3.281).toFixed(1)} ft` : `${m.toFixed(2)} m`),
    speed: (ms) => (ms == null ? "–" : ft ? `${(ms * 3.281).toFixed(1)} ft/s` : `${ms.toFixed(2)} m/s`),
  };
}

const pad = (n) => String(n).padStart(2, "0");
function clock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function duration(s) {
  if (s == null) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec ? `${sec} s` : ""}`.trim();
  return `${sec} s`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const secs = (v) => (v == null ? "–" : `${v.toFixed(1)} s`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (v) => (v == null ? "–" : `${v >= 99.95 ? 100 : v.toFixed(1)}%`);

/** Every sample in one spreadsheet-friendly CSV. */
export function toCsv(events) {
  const cols = ["time", "elapsed_s", "kind", "floor", "x_m", "y_m", "source", "gps_accuracy_m", "lat", "lng",
    "height_m", "device", "pressure_pa", "temp_c", "rssi", "you_said_floor"];
  const rows = [cols.join(",")];
  const ev = [...events].sort((a, b) => a.t - b.t);
  const t0 = ev[0]?.t ?? 0;
  let truth = "";
  const r2 = (v) => (v == null ? "" : Math.round(v * 100) / 100);
  for (const e of ev) {
    if (e.k === "truth") truth = e.f;
    if (!["pos", "gps", "tel", "mark", "truth"].includes(e.k)) continue;
    const row = {
      time: new Date(e.t).toISOString(), elapsed_s: ((e.t - t0) / 1000).toFixed(1), kind: e.k,
      floor: e.f ?? "", x_m: r2(e.x), y_m: r2(e.y), source: e.mode || e.role || e.why || "",
      gps_accuracy_m: r2(e.acc), lat: e.lat ?? "", lng: e.lng ?? "", height_m: r2(e.z),
      device: e.id || "", pressure_pa: e.p ?? "", temp_c: e.temp ?? "", rssi: e.rssi ?? "", you_said_floor: truth,
    };
    rows.push(cols.map((c) => {
      const v = String(row[c]);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(","));
  }
  return rows.join("\n");
}

/** Thin a long series down for charting, keeping the order. */
function thin(list, max) {
  if (list.length <= max) return list;
  const step = list.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.floor(i * step)]);
  out.push(list[list.length - 1]);
  return out;
}

/** A self-contained HTML report that opens in any browser. */
export function buildReport(meta, an, { model, unitsKind, version }) {
  const u = units(unitsKind);
  const f = an.floors, h = an.height, sp = an.spots;
  const date = new Date(an.t0);
  const day = date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const userDev = an.devices.find((d) => d.role !== "reference");
  const how = meta.mode === "gps" ? "Phone GPS only" : `Sensor ${meta.device} and phone GPS`;

  const tiles = [
    ["Floor changes caught", f.measured ? `${f.ok} of ${f.measured}` : "–",
      f.measured ? pct((100 * f.ok) / f.measured) : f.sensor ? "No floor trips logged" : "Needs a sensor"],
    ["Typical switch time", f.medianDelay != null ? secs(Math.abs(f.medianDelay)) : "–",
      f.medianDelay != null ? `${f.medianDelay < 0 ? "Before" : "After"} you tapped that you'd arrived` : "Counted from your tap"],
    ["Typical position error", sp.median != null ? u.dist(sp.median) : "–",
      sp.rawMedian != null ? `GPS alone: ${u.dist(sp.rawMedian)}` : sp.list.length ? "" : "No spots marked"],
    ["Sensor connection", userDev ? duration((userDev.last - userDev.first) / 1000) : "–",
      userDev ? `${userDev.gaps} gap${userDev.gaps === 1 ? "" : "s"} over 5 s` : "No sensor data"],
  ];

  const warnings = [];
  if (!meta.calibrated) warnings.push("The map wasn't calibrated, so position errors are measured against an estimated building position.");
  if (meta.appMode !== "production") warnings.push("The dot was set to show anywhere (test mode) rather than only at the library.");
  if (meta.mode === "gps") warnings.push("No sensor was used, so floor detection wasn't tested.");
  else if (!f.sensor) warnings.push("No floor readings came from the position server, so floor detection couldn't be scored. Check the engine was running.");
  if (an.hiddenMs > 30000) warnings.push(`The screen was off for ${duration(an.hiddenMs / 1000)}. Nothing was recorded during that time.`);

  const tripRows = f.trips.map((tr) => `<tr>
      <td>${tr.n}</td><td>${clock(tr.t)}</td><td>${esc(tr.from)} → ${esc(tr.to)}</td><td>${esc(tr.via)}</td>
      <td class="num">${secs(tr.walkS)}</td>
      <td class="num">${tr.delay == null ? "–" : tr.delay < 0 ? `${secs(-tr.delay)} before` : `${secs(tr.delay)} after`}</td>
      <td>${tr.noData ? "No data" : tr.ok ? "✓ Right" : tr.wrong ? `✗ Showed floor ${esc(tr.wrong)}` : "✗ Missed"}</td></tr>`).join("");

  const floorRows = an.levels.filter((l) => h.perFloor[l]).map((l) => {
    const p = h.perFloor[l];
    return `<tr><td>Floor ${esc(l)}</td><td class="num">${u.height(p.mean)}</td><td class="num">±${u.height(p.sd ?? 0)}</td>
      <td class="num">${p.n}</td><td>${p.from === "still" ? "Standing still" : "Walking around"}</td></tr>`;
  }).join("");
  const gapLines = h.gaps.map((g) => {
    const odd = g.measured < g.model * 0.5 || g.measured > g.model * 1.6;
    const verdict = odd ? "That's far from the map, so check your floor taps before changing anything."
      : Math.abs(g.measured - g.model) > 0.5 ? `Worth changing the map to ${u.height(g.measured)}.` : "Close enough.";
    return `<li>Floor ${esc(g.from)} to floor ${esc(g.to)}: <b>${u.height(g.measured)}</b> measured,
      ${u.height(g.model)} in the map. ${verdict}</li>`;
  }).join("");

  const spotRows = sp.list.map((s) => `<tr><td>${s.n}</td><td>${clock(s.t)}</td><td>${esc(s.label || "–")}</td><td>${esc(s.f)}</td>
      <td class="num">${u.dist(s.err)}</td><td class="num">${u.dist(s.rawErr)}</td><td class="num">${s.acc != null ? `±${u.dist(s.acc)}` : "–"}</td>
      <td>${s.floorOk === false ? "Wrong floor shown" : ""}</td></tr>`).join("");

  const routeRows = an.routes.map((r) => `<tr><td>${clock(r.t)}</td><td>${esc(r.name)}</td><td class="num">${u.dist(r.m)}</td>
      <td class="num">${r.secs != null ? duration(r.secs) : "–"}</td><td class="num">${u.speed(r.speed)}</td>
      <td class="num">${r.reroutes}</td><td>${r.arrived ? "Yes" : r.end ? "Stopped" : "–"}</td>
      <td>${r.rating ? esc({ yes: "Got me there", partly: "Mostly", no: "Didn't work" }[r.rating] || r.rating) : ""}${r.note ? `: ${esc(r.note)}` : ""}</td></tr>`).join("");

  const deviceRows = an.devices.map((d) => `<tr><td>${esc(d.id)}</td><td>${d.role === "reference" ? "Reference" : "Carried"}</td>
      <td class="num">${duration((d.last - d.first) / 1000)}</td><td class="num">${d.packets}</td><td class="num">${pct(d.lostPct)}</td>
      <td class="num">${d.gaps}${d.gaps ? ` (longest ${secs(d.longestGapS)})` : ""}</td><td class="num">${d.rssi != null ? `${Math.round(d.rssi)} dBm` : "–"}</td>
      <td class="num">${d.reboots}</td></tr>`).join("");

  const searchRows = an.searches.list.map((s) => `<tr><td>${clock(s.t)}</td><td>${esc(s.q)}</td>
      <td>${s.kind === "unknown" ? "Nothing found" : esc(s.name || s.kind)}</td></tr>`).join("");
  const noteRows = an.notes.map((n) => `<tr><td>${clock(n.t)}</td><td>${esc(n.text)}</td></tr>`).join("");

  const chartData = {
    unitsFt: u.ft,
    t0: an.t0, t1: an.t1,
    levels: an.levels,
    floorZ: an.floorZ,
    truths: f.truths.map((x) => [x.t, x.f]),
    app: thin(f.app, 4000),
    heights: thin(h.series.map((x) => [x.t, Math.round(x.h * 100) / 100]), 4000),
    heightSource: h.source,
    spots: sp.list.map((s) => ({ n: s.n, label: s.label || `Spot ${s.n}`, err: s.err, raw: s.rawErr })),
  };
  const json = JSON.stringify(chartData).replace(/</g, "\\u003c");

  const section = (title, body) => `<section><h2>${title}</h2>${body}</section>`;
  const table = (head, rows) => rows ? `<div class="table"><table class="${head.length >= 5 ? "wide" : ""}"><thead><tr>${head.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Field test, ${esc(meta.libName || model.site.name)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --line: rgba(11, 11, 11, 0.10);
  --s1: #2a78d6; --s2: #eb6834; --truth: #c3c2b7;
  --good: #006300; --bad: #d03b3b; --warn-bg: #fff6e0; --warn-ink: #6b4a00;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --line: rgba(255, 255, 255, 0.10);
    --s1: #3987e5; --s2: #d95926; --truth: #5a5955;
    --good: #0ca30c; --bad: #e66767; --warn-bg: #2e2510; --warn-ink: #f2d38a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; }
h2 { font-size: 19px; margin: 0 0 4px; }
.lead { color: var(--ink-2); margin: 0; }
.meta { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 24px 0; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.tile .label { color: var(--ink-2); font-size: 14px; }
.tile .value { font-size: clamp(22px, 6vw, 28px); font-weight: 600; margin: 2px 0; }
.tile .sub { color: var(--muted); font-size: 13px; }
.warn { background: var(--warn-bg); color: var(--warn-ink); border-radius: 12px; padding: 12px 16px; margin: 0 0 20px; }
.warn ul { margin: 0; padding-left: 18px; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 0 0 16px; }
section p { color: var(--ink-2); margin: 4px 0 12px; }
section ul { color: var(--ink-2); margin: 8px 0 12px; padding-left: 20px; }
section b { color: var(--ink); }
.chart { position: relative; margin: 12px 0 8px; }
.chart svg { display: block; width: 100%; overflow: visible; }
.chart text { font-size: 12px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--ink-2); margin: 0 0 4px; }
.legend i { display: inline-block; width: 16px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.legend i.thick { height: 7px; }
.table { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
table.wide { min-width: 620px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--axis); padding: 6px 10px 6px 0; white-space: nowrap; }
td { border-bottom: 1px solid var(--grid); padding: 6px 10px 6px 0; vertical-align: top; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
#tip { position: fixed; pointer-events: none; z-index: 5; background: var(--ink); color: var(--surface);
  font-size: 13px; padding: 6px 9px; border-radius: 8px; white-space: nowrap; display: none; }
footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <h1>Field test, ${esc(meta.libName || model.site.name)}</h1>
  <p class="lead">${esc(day)}, ${clock(an.t0)} to ${clock(an.t1)} (${duration(an.durationS)})</p>
  <p class="meta">${esc(how)} · Dot shown ${meta.appMode === "production" ? "only at the library" : "anywhere"} ·
    Map ${meta.calibrated ? "calibrated on site" : "not calibrated"} · App ${esc(version)}</p>

  <div class="tiles">${tiles.map(([l, v, s]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join("")}</div>
  ${warnings.length ? `<div class="warn"><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}

  ${section("Floor detection", `
    <p>Each trip starts when you tapped to change floors and ends when you tapped that you'd arrived.
      A trip counts as caught if the app moved you to the new floor no later than ${SWITCH_LIMIT_MS / 1000} s after you arrived,
      without showing a floor you never went to.</p>
    ${f.settledPct != null ? `<p>While you stayed on one floor, the app showed the right floor <b>${pct(f.settledPct)}</b> of the time
      and jumped to a wrong floor <b>${f.falseSwitches}</b> time${f.falseSwitches === 1 ? "" : "s"}.</p>` : ""}
    <div class="legend"><span><i class="thick" style="background:var(--truth)"></i>Where you said you were</span>
      <span><i style="background:var(--s1)"></i>What the app showed</span></div>
    <div class="chart" id="floorChart"></div>
    ${table(["#", "Started", "Floors", "Way", "Walk", "App switched", "Result"], tripRows)}`)}

  ${h.source ? section("Floor heights", `
    <p>Height above the reference sensor, ${h.source === "sensors" ? "worked out from both sensors' pressure" : "as the position server worked it out"}.
      ${h.stills ? `Numbers come from your ${h.stills} stand-still check${h.stills === 1 ? "" : "s"} where there were any.` : "Numbers come from the time you spent on each floor."}</p>
    <div class="chart" id="heightChart"></div>
    ${table(["Floor", "Reading", "Spread", "Samples", "From"], floorRows)}
    ${gapLines ? `<ul>${gapLines}</ul>` : ""}
    ${h.noise != null ? `<p>Standing still, readings moved by about <b>±${u.height(h.noise)}</b>.
      Floors in this building are ${u.height(model.site.floorHeight)} apart, so the noise should stay well under half of that.</p>` : ""}`) : ""}

  ${section("Position on the floor", sp.list.length ? `
    <p>For each spot you tapped where you were standing, then the app listened for a few seconds. The error is the distance
      from your tap to the average position the map showed. "GPS alone" is the phone's raw GPS without any smoothing or snapping.</p>
    <p>Typical error <b>${u.dist(sp.median)}</b>, 9 in 10 within <b>${u.dist(sp.p90)}</b>, worst <b>${u.dist(sp.max)}</b>.
      ${sp.list.length ? `${pct(sp.within(u.near))} of spots were within ${u.dist(u.near)}.` : ""}
      ${sp.wrongFloor ? `${sp.wrongFloor} spot${sp.wrongFloor === 1 ? " was" : "s were"} shown on the wrong floor.` : ""}</p>
    <div class="legend"><span><i style="background:var(--s1)"></i>On the map</span><span><i style="background:var(--s2)"></i>GPS alone</span></div>
    <div class="chart" id="spotChart"></div>
    ${table(["#", "Time", "Where", "Floor", "On the map", "GPS alone", "GPS said", ""], spotRows)}` : "<p>No spots were marked in this test.</p>")}

  ${an.routes.length ? section("Directions", table(["Started", "To", "Length", "Took", "Speed", "Re-routes", "Arrived", "Your verdict"], routeRows)) : ""}

  ${section("Connection and sensors", `
    <ul>
      <li>Server round trip: typically <b>${an.latency.median != null ? `${Math.round(an.latency.median)} ms` : "–"}</b>,
        9 in 10 under ${an.latency.p90 != null ? `${Math.round(an.latency.p90)} ms` : "–"} (${an.latency.n} checks).</li>
      <li>Phone GPS: ${plural(an.gps.n, "fix", "fixes")}, typical accuracy <b>${an.gps.medianAcc != null ? `±${u.dist(an.gps.medianAcc)}` : "–"}</b>,
        ${pct(an.gps.within(u.fair))} of them within ±${u.dist(u.fair)}.</li>
    </ul>
    ${table(["Sensor", "Role", "Heard for", "Packets", "Lost", "Gaps over 5 s", "Signal", "Restarts"], deviceRows)}`)}

  ${an.searches.list.length ? section("Searches", `<p>${plural(an.searches.list.length, "search", "searches")}, ${an.searches.unknown} found nothing.</p>${table(["Time", "Typed", "Went to"], searchRows)}`) : ""}
  ${an.notes.length ? section("Notes", table(["Time", "Note"], noteRows)) : ""}

  ${section("How the numbers are worked out", `<ul>
    <li>Everything comes from what the phone recorded. The only things typed in by hand are your taps: the floor you reached and where you stood.</li>
    <li>Heights use the hypsometric formula with both sensors' temperature, the same maths the position server uses.</li>
    <li>"Typical" is the median, so one bad reading doesn't pull it around.</li>
    <li>Time with the screen off is left out of the gap counts, because the phone wasn't listening then.</li>
  </ul>`)}
  <footer>Library Nav field test ${esc(meta.id)}. The raw data is in the matching .json and .csv files.</footer>
</main>
<div id="tip" role="tooltip"></div>
<script type="application/json" id="chartData">${json}</script>
<script>(${drawReportCharts.toString()})(JSON.parse(document.getElementById("chartData").textContent));</script>
</body>
</html>`;
}

/* Runs inside the downloaded report, so it may not use anything from this module. */
function drawReportCharts(data) {
  const NS = "http://www.w3.org/2000/svg";
  const tip = document.getElementById("tip");
  const k = data.unitsFt ? 3.281 : 1;
  const unit = data.unitsFt ? "ft" : "m";
  const p2 = (n) => String(n).padStart(2, "0");
  const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const hms = (t) => { const d = new Date(t); return `${hm(t)}:${p2(d.getSeconds())}`; };

  function node(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs || {})) n.setAttribute(a, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.style.display = "block";
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${y - 40}px`;
  }
  const hideTip = () => { tip.style.display = "none"; };
  function nearest(pts, t) {
    let lo = 0, hi = pts.length - 1;
    if (hi < 0) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid; else hi = mid; }
    return Math.abs(pts[lo][0] - t) <= Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
  }
  function timeTicks(t0, t1, w) {
    const span = (t1 - t0) / 60000;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120];
    const want = Math.max(2, Math.floor(w / 90));
    const step = (steps.find((s) => span / s <= want) || 240) * 60000;
    const out = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
  }

  /** Time on x, one shared y scale; series are [t, v] lists. */
  function timeChart(el, { yTicks, yMin, yMax, series, hover, height }) {
    if (!el) return;
    el.innerHTML = "";
    const W = el.clientWidth || 600;
    const H = height;
    const m = { l: 62, r: 12, t: 10, b: 26 };
    const t0 = data.t0, t1 = Math.max(data.t1, data.t0 + 1000);
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (v) => H - m.b - ((v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
    const svg = node("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, el);
    for (const tk of yTicks) {
      node("line", { x1: m.l, x2: W - m.r, y1: y(tk.v), y2: y(tk.v), stroke: "var(--grid)", "stroke-width": 1 }, svg);
      node("text", { x: m.l - 8, y: y(tk.v) + 4, "text-anchor": "end" }, svg).textContent = tk.label;
    }
    node("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1 }, svg);
    for (const t of timeTicks(t0, t1, W - m.l - m.r)) {
      node("text", { x: x(t), y: H - 8, "text-anchor": "middle" }, svg).textContent = hm(t);
    }
    for (const s of series) {
      let d = "";
      let prev = null;
      for (const [t, v] of s.pts) {
        const X = x(t).toFixed(1), Y = y(v).toFixed(1);
        if (!prev || t - prev[0] > (s.gap || 15000)) d += `M${X},${Y}`;
        else if (s.step) d += `H${X}V${Y}`;
        else d += `L${X},${Y}`;
        prev = [t, v];
      }
      if (s.extendTo && prev) d += s.step ? `H${x(s.extendTo).toFixed(1)}` : "";
      node("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    }
    const cross = node("line", { y1: m.t, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, svg);
    const hit = node("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const t = t0 + ((e.clientX - r.left - m.l) / (W - m.l - m.r)) * (t1 - t0);
      const X = x(t);
      cross.setAttribute("x1", X); cross.setAttribute("x2", X); cross.setAttribute("visibility", "visible");
      showTip(hover(t), e.clientX, e.clientY);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  }

  function floorChart() {
    const el = document.getElementById("floorChart");
    const lv = data.levels.map(Number);
    if (!data.app.length && !data.truths.length) { if (el) el.innerHTML = "<p>No floor data was recorded.</p>"; return; }
    const truthPts = data.truths.map(([t, f]) => [t, Number(f)]);
    const truthAt = (t) => { let f = null; for (const [tt, ff] of data.truths) { if (tt <= t) f = ff; else break; } return f; };
    timeChart(el, {
      height: 70 + 34 * lv.length,
      yMin: Math.min(...lv) - 0.4, yMax: Math.max(...lv) + 0.4,
      yTicks: lv.map((v) => ({ v, label: `Floor ${v}` })),
      series: [
        { pts: truthPts, color: "var(--truth)", width: 7, step: true, gap: Infinity, extendTo: data.t1 },
        { pts: data.app.map(([t, f]) => [t, Number(f)]), color: "var(--s1)", width: 2, step: true },
      ],
      hover: (t) => {
        const a = nearest(data.app, t);
        const app = a && Math.abs(a[0] - t) < 15000 ? `floor ${a[1]}` : "no reading";
        const you = truthAt(t);
        return `${hms(t)}<br>You: ${you ? `floor ${you}` : "not set"} · App: ${app}`;
      },
    });
  }

  function heightChart() {
    const el = document.getElementById("heightChart");
    if (!el || !data.heights.length) return;
    const vals = data.heights.map((p) => p[1]);
    const zs = Object.values(data.floorZ);
    const lo = Math.min(...vals, ...zs) - 1, hi = Math.max(...vals, ...zs) + 1;
    const ticks = Object.entries(data.floorZ).map(([lvl, z]) => ({ v: z, label: `F${lvl} ${(z * k).toFixed(1)} ${unit}` }));
    timeChart(el, {
      height: 220, yMin: lo, yMax: hi, yTicks: ticks,
      series: [{ pts: data.heights, color: "var(--s1)", width: 2 }],
      hover: (t) => {
        const p = nearest(data.heights, t);
        return p && Math.abs(p[0] - t) < 15000 ? `${hms(p[0])}<br>${(p[1] * k).toFixed(2)} ${unit} above the reference` : `${hms(t)}<br>No reading`;
      },
    });
  }

  function spotChart() {
    const el = document.getElementById("spotChart");
    if (!el || !data.spots.length) return;
    el.innerHTML = "";
    const W = el.clientWidth || 600;
    const rowH = 34, barH = 10, gap = 2;
    const m = { l: Math.min(180, W * 0.36), r: 64, t: 4, b: 24 };
    const H = m.t + m.b + rowH * data.spots.length;
    const max = Math.max(1, ...data.spots.flatMap((s) => [s.err || 0, s.raw || 0])) * k;
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => max / s <= 5) || 500;
    const top = Math.ceil(max / step) * step;
    const x = (v) => m.l + (v * k / top) * (W - m.l - m.r);
    const svg = node("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" }, el);
    for (let v = 0; v <= top; v += step) {
      const X = m.l + (v / top) * (W - m.l - m.r);
      node("line", { x1: X, x2: X, y1: m.t, y2: H - m.b, stroke: v ? "var(--grid)" : "var(--axis)", "stroke-width": 1 }, svg);
      node("text", { x: X, y: H - 6, "text-anchor": "middle" }, svg).textContent = `${v} ${unit}`;
    }
    const bar = (x0, y0, x1, color) => {
      const w = Math.max(0, x1 - x0), r = Math.min(4, w);
      const d = `M${x0},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + barH - r}Q${x0 + w},${y0 + barH} ${x0 + w - r},${y0 + barH}H${x0}Z`;
      return node("path", { d, fill: color }, svg);
    };
    data.spots.forEach((s, i) => {
      const y0 = m.t + i * rowH + (rowH - (barH * 2 + gap)) / 2;
      const label = node("text", { x: m.l - 8, y: y0 + barH + 4, "text-anchor": "end" }, svg);
      label.textContent = s.label;
      for (let n = s.label.length; n > 4 && label.getComputedTextLength() > m.l - 12; n--) {
        label.textContent = `${s.label.slice(0, n - 1).trim()}…`;
      }
      [[s.err, "var(--s1)", "On the map"], [s.raw, "var(--s2)", "GPS alone"]].forEach(([v, c, name], j) => {
        if (v == null) return;
        const yy = y0 + j * (barH + gap);
        bar(m.l, yy, x(v), c);
        node("text", { x: x(v) + 6, y: yy + barH - 1 }, svg).textContent = `${(v * k).toFixed(v * k < 10 ? 1 : 0)} ${unit}`;
      });
      const hit = node("rect", { x: 0, y: m.t + i * rowH, width: W, height: rowH, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => showTip(
        `${s.label}<br>On the map: ${s.err != null ? `${(s.err * k).toFixed(1)} ${unit}` : "–"} · GPS alone: ${s.raw != null ? `${(s.raw * k).toFixed(1)} ${unit}` : "–"}`,
        e.clientX, e.clientY));
      hit.addEventListener("pointerleave", hideTip);
    });
  }

  const drawAll = () => { floorChart(); heightChart(); spotChart(); };
  drawAll();
  let timer;
  addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(drawAll, 150); });
}

/* ============================================================ test bar */
/**
 * The strip under the search bar while a test is recording. host gives it the
 * bits of the app it needs (map, floors, settings, toasts).
 */
export class TestBar {
  constructor(ft, host) {
    this.ft = ft;
    this.host = host;
    this.root = document.getElementById("testBar");
    this.timeEl = document.getElementById("tbTime");
    this.statusEl = document.getElementById("tbStatus");
    this.body = document.getElementById("tbBody");
    this.endEl = document.getElementById("tbEnd");
    this.mode = "idle";
    this.trip = null;     // {to, from, via, t, detected}
    this.pending = null;  // a finished trip still waiting for the app to switch
    this.tally = { trips: 0, right: 0 };
    this.flash = null;    // {text, until}
    this.until = 0;       // end of a countdown
    this.mark = null;
    this.via = "stairs";
    this.recent = [];     // last minute of positions
    this.recentGps = [];
    ft.addEventListener("change", () => this.sync());
    setInterval(() => this.tick(), 1000);
    this.sync();
  }

  sync() {
    const on = this.ft.active;
    if (!on) {
      this.mode = "idle";
      this.trip = null;
      this.pending = null;
      this.host.cancelPick();
      this.host.setMark(null);
    } else if (this.ft.truth == null && this.mode === "idle") {
      this.mode = "askFloor";
    }
    this.root.hidden = !on;
    document.body.classList.toggle("testing", on);
    this.render();
    this.host.layout();
  }

  /* ---------------------------------------------------------- feeds */
  onPos(p) {
    if (!this.ft.active) return;
    const now = Date.now();
    this.recent.push({ t: now, x: p.x, y: p.y, f: String(p.floor), mode: p.q?.mode, z: p.q?.zEst });
    while (this.recent.length && now - this.recent[0].t > 60000) this.recent.shift();
    const f = String(p.floor);
    const fromSensor = p.q?.mode === "sensor";
    if (this.trip && fromSensor && f === this.trip.to && !this.trip.detected) {
      this.trip.detected = now;
      this._buzz(`The app switched to floor ${f}`);
    }
    if (this.pending && fromSensor && f === this.pending.to && !this.pending.detected) {
      this.pending.detected = now;
      this._settle(true);
    }
    this._status();
  }

  onGps(fix, local) {
    if (!this.ft.active || !local) return;
    const now = Date.now();
    this.recentGps.push({ t: now, x: local[0], y: local[1] });
    while (this.recentGps.length && now - this.recentGps[0].t > 60000) this.recentGps.shift();
  }

  routeEnded(arrived) {
    if (!this.ft.active || !arrived || !this.host.setting("ftRateRoutes")) return;
    if (["idle", "askFloor"].includes(this.mode)) this._go("rate");
  }

  /* ---------------------------------------------------------- flow */
  _go(mode) {
    this.mode = mode;
    this.render();
    this.host.layout();
  }

  _say(text, ms = 7000) {
    this.flash = { text, until: Date.now() + ms };
    this._status();
  }

  _buzz(text) {
    if (this.host.setting("ftBuzz")) this.host.vibrate(180);
    this._say(text, 5000);
  }

  _setTruth(f, why) {
    this.ft.log("truth", { f: String(f), why });
    this._status();
  }

  _startTrip(to) {
    if (!this.host.usesSensor()) {
      // phone-only: the floor is whatever you pick, so there's nothing to score
      this._setTruth(to, "manual");
      this.host.setManualFloor(to);
      this._go("idle");
      return;
    }
    const from = this.ft.truth;
    this.ft.log("trip", { phase: "go", from, to, via: this.via });
    this.trip = { to, from, via: this.via, t: Date.now(), detected: null };
    this._go("trip");
  }

  _arrive() {
    const tr = this.trip;
    this.trip = null;
    this._setTruth(tr.to, "trip");
    this.tally.trips++;
    this.pending = { ...tr, arrivedAt: Date.now() };
    if (tr.detected) this._settle(true);
    else this._say(`Waiting for the app to show floor ${tr.to}...`, SWITCH_LIMIT_MS);
    this._go("idle");
  }

  /** Tell the tester how the last trip went. */
  _settle(caught) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (caught) {
      this.tally.right++;
      const d = (p.detected - p.arrivedAt) / 1000;
      this._say(d <= 0
        ? `Caught, ${Math.abs(d).toFixed(0)} s before your tap.`
        : `Caught, ${d.toFixed(0)} s after you arrived.`);
    } else {
      this.host.vibrate([120, 80, 120]);
      this._say(`Missed: no floor ${p.to} after ${SWITCH_LIMIT_MS / 1000} s.`);
    }
  }

  _startMark() {
    const floor = this.ft.truth || this.host.shownFloor();
    if (floor) this.host.focusFloor(floor);
    this.host.pickPoint((pt) => {
      this.mark = { ...pt, t: Date.now(), dur: this.host.setting("ftMarkSeconds") * 1000, label: this.host.placeName(pt) };
      this.host.setMark(pt);
      this.until = this.mark.t + this.mark.dur;
      this._go("collect");
    });
    this._go("pick");
  }

  _finishMark() {
    const m = this.mark;
    this.mark = null;
    if (!m) return;
    this.ft.log("mark", { t: m.t, x: m.x, y: m.y, f: m.floor, dur: m.dur, label: m.label });
    const shown = this.recent.filter((p) => p.t >= m.t && String(p.f) === String(m.floor));
    const raw = this.recentGps.filter((g) => g.t >= m.t - 2000);
    const off = (list) => list.length
      ? Math.hypot(avg(list.map((p) => p.x)) - m.x, avg(list.map((p) => p.y)) - m.y) : null;
    const a = off(shown), b = off(raw);
    let text = a == null ? "Saved. You weren't shown on this floor."
      : `Map ${this.host.fmtDist(a)} off`;
    if (a != null) text += b != null ? `, GPS alone ${this.host.fmtDist(b)}.` : ".";
    this._say(text, 9000);
    setTimeout(() => { if (!this.mark) this.host.setMark(null); }, 4000);
    this._go("idle");
  }

  _startStill() {
    const f = this.ft.truth;
    this.ft.log("still", { phase: "start", f });
    this.still = { f, t: Date.now() };
    this.until = Date.now() + 30000;
    this._go("still");
  }

  _finishStill() {
    const s = this.still;
    this.still = null;
    this.ft.log("still", { phase: "end", f: s.f });
    const zs = this.recent.filter((p) => p.t >= s.t && p.z != null).map((p) => p.z);
    this._say(zs.length
      ? `Height ${this.host.fmtHeight(avg(zs))}, ±${this.host.fmtHeight(sd(zs) ?? 0)}.`
      : "Saved. Heights go in the report.", 9000);
    this._go("idle");
  }

  _cancel() {
    if (this.mode === "trip") {
      this.ft.log("trip", { phase: "cancel" });
      this.trip = null;
    } else if (this.mode === "pick") {
      this.host.cancelPick();
    } else if (this.mode === "collect") {
      this.mark = null;
      this.host.setMark(null);
    } else if (this.mode === "still") {
      this.ft.log("still", { phase: "cancel" });
      this.still = null;
    }
    this._go(this.ft.truth == null ? "askFloor" : "idle");
  }

  async stop() {
    const ok = await this.host.confirm({
      title: "Stop the field test?",
      text: "Recording ends and you'll see the results. You can download the report from there.",
      ok: "Stop", danger: false,
    });
    if (!ok) return;
    if (["pick", "collect", "still", "trip"].includes(this.mode)) this._cancel();
    const meta = await this.ft.stop();
    if (meta) this.host.showResults(meta.id);
  }

  /* ---------------------------------------------------------- drawing */
  tick() {
    if (!this.ft.active) return;
    const s = Math.floor((Date.now() - this.ft.session.started) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    this.timeEl.textContent = h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
    if (this.pending && Date.now() - this.pending.arrivedAt > SWITCH_LIMIT_MS) this._settle(false);
    if (this.mode === "collect" || this.mode === "still") {
      const left = Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
      const c = this.body.querySelector(".tb-count");
      if (c) c.textContent = `${left} s`;
      if (left <= 0) {
        if (this.mode === "collect") this._finishMark();
        else this._finishStill();
      }
    }
    this._status();
  }

  _status() {
    if (!this.ft.active) return;
    if (this.flash && Date.now() < this.flash.until) {
      this.statusEl.textContent = this.flash.text;
      return;
    }
    this.flash = null;
    const truth = this.ft.truth;
    const shown = this.host.shownFloor();
    let text = truth ? `You: floor ${truth}` : "Floor not set";
    text += ` · App: ${shown ? `floor ${shown}` : "–"}`;
    if (this.tally.trips) text += ` · Trips ${this.tally.right}/${this.tally.trips}`;
    this.statusEl.textContent = text;
  }

  _btn(label, cls, fn, ic) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = `${ic ? icon(ic) : ""}<span>${esc(label)}</span>`;
    if (fn) b.addEventListener("click", fn);
    return b;
  }

  _row(text, ...buttons) {
    const row = document.createElement("div");
    row.className = "tb-row";
    if (text != null) {
      const span = document.createElement("span");
      span.className = "tb-text";
      span.innerHTML = text;
      row.appendChild(span);
    }
    buttons.forEach((b) => row.appendChild(b));
    return row;
  }

  _close() {
    const b = this._btn("", "tb-x", () => this._cancel(), "close");
    b.setAttribute("aria-label", "Cancel");
    return b;
  }

  render() {
    const body = this.body;
    body.innerHTML = "";
    this.endEl.innerHTML = "";
    if (!this.ft.active) return;
    if (this.mode === "idle" || this.mode === "askFloor") {
      this.endEl.appendChild(this._btn("Stop", "tb-stop", () => this.stop(), "stop_circle"));
    } else {
      this.endEl.appendChild(this._close());
    }
    const levels = this.host.levels();
    const truth = this.ft.truth;
    switch (this.mode) {
      case "askFloor": {
        body.appendChild(this._row("Which floor are you on?",
          ...levels.map((l) => this._btn(`${l}`, "tb-floor", () => { this._setTruth(l, "start"); this._go("idle"); }))));
        break;
      }
      case "idle": {
        const row = document.createElement("div");
        row.className = "tb-actions";
        row.append(
          this._btn("Change floor", "tb-chip", () => this._go("tripPick"), "stairs"),
          this._btn("Mark my spot", "tb-chip", () => this._startMark(), "pin_drop"),
          this._btn("Stand still", "tb-chip", () => this._startStill(), "timer"),
          this._btn("Note", "tb-chip", () => this._go("note"), "edit_note"),
        );
        body.appendChild(row);
        break;
      }
      case "tripPick": {
        const others = levels.filter((l) => l !== truth);
        const via = this._btn(this.via === "stairs" ? "Stairs" : "Elevator", "tb-via", () => {
          this.via = this.via === "stairs" ? "elevator" : "stairs";
          this.render();
        }, this.via === "stairs" ? "stairs" : "elevator");
        via.title = "Tap to switch between stairs and elevator";
        const row = this._row("Going to", ...others.map((l) => this._btn(`Floor ${l}`, "tb-floor", () => this._startTrip(l))), via);
        row.classList.add("tight");
        body.appendChild(row);
        body.appendChild(this._hint(this.host.usesSensor()
          ? "Tap before you start walking."
          : "Without a sensor this just sets your floor."));
        break;
      }
      case "trip": {
        const tr = this.trip;
        body.appendChild(this._row(`Walk to floor ${esc(tr.to)} by ${tr.via}`,
          this._btn(`I'm on floor ${tr.to}`, "tb-main", () => this._arrive())));
        body.appendChild(this._hint("Tap the moment you step off the stairs or out of the elevator."));
        break;
      }
      case "pick": {
        body.appendChild(this._row("Tap the map exactly where you're standing"));
        body.appendChild(this._hint("Use something you can spot on the map: a door, a corner, the end of a shelf."));
        break;
      }
      case "collect": {
        body.appendChild(this._row(`Stay where you are <b class="tb-count">${Math.ceil((this.until - Date.now()) / 1000)} s</b>`));
        break;
      }
      case "still": {
        body.appendChild(this._row(`Stand still on floor ${esc(truth)} <b class="tb-count">${Math.ceil((this.until - Date.now()) / 1000)} s</b>`));
        body.appendChild(this._hint("Hold the sensor at the same height the whole time."));
        break;
      }
      case "note": {
        const form = document.createElement("form");
        form.className = "tb-row";
        form.innerHTML = `<input class="tb-input" type="text" maxlength="200" placeholder="What did you notice?" aria-label="Note" />`;
        const input = form.querySelector("input");
        const save = this._btn("Save", "tb-main", null);
        save.type = "submit";
        form.append(save);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (text) {
            this.ft.log("note", { text });
            this._say("Note saved.", 3000);
          }
          this._go("idle");
        });
        body.appendChild(form);
        setTimeout(() => input.focus(), 50);
        break;
      }
      case "rate": {
        const rate = (ok) => {
          this.ft.log("rate", { ok });
          this._say("Thanks, saved.", 3000);
          this._go(ok === "yes" ? "idle" : "note");
        };
        const row = this._row("Did the directions get you there?",
          this._btn("Yes", "tb-floor", () => rate("yes")),
          this._btn("Mostly", "tb-floor", () => rate("partly")),
          this._btn("No", "tb-floor", () => rate("no")));
        row.classList.add("stacked");
        body.appendChild(row);
        break;
      }
      default:
        break;
    }
    this.tick();
  }

  _hint(text) {
    const p = document.createElement("p");
    p.className = "tb-hint";
    p.textContent = text;
    return p;
  }
}
