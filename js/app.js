/*
 * Application orchestrator: boots the 3D scene, connectivity, chat intent,
 * voice guidance, friends, and connection-quality indicators.
 */
import { MapScene } from "./map3d.js?v=modes1";
import { Navigator } from "./nav.js?v=modes1";
import { IntentEngine } from "./intent.js?v=modes1";
import { Speaker, Listener, Guidance } from "./voice.js?v=modes1";
import { Bus, GpsPublisher } from "./net.js?v=modes1";
import { Social } from "./supa.js?v=modes1";

const CFG = window.NAV_CONFIG;
const $ = (id) => document.getElementById(id);
const DEFAULT_START = { floor: 1, x: 26.5, y: 26.5 }; // 1F entrance lobby
const FLOORS = ["1", "2", "3", "4", "5"];

/** Vertical-circulation profile for routing: step-free wins, else stair choice. */
function routeProfile() {
  return state.accessible ? "elevator" : state.stairPref;
}

const state = {
  uid: null, name: "", deviceId: "", blind: false, accessible: false,
  mode: "esp", myFloor: "1", // positioning mode: "esp" (sensor+GPS) | "gps" (GPS only)
  stairPref: "central",      // "central" | "west" - which staircase routes use
  appMode: "test",           // "test" (show anywhere) | "production" (200 m geofence)
  pos: null, route: null, routeTarget: null,
  friends: new Map(), // uid -> {name, online, pos, subscribed}
  admitted: true,
  sensorLastSeen: 0, sensorRssi: null, pressureOk: false,
  catalog: [], library: null, // available libraries + the chosen one
  geo: null, smoother: makeGpsSmoother(), // client-side GPS conversion + smoothing
};

let model, scene, nav, intent, speaker, listener, guidance, bus, gps, social;

/* ============================== boot ==================================== */
async function boot() {
  // Model + 3D scene are created only after a library is chosen (step 0).
  speaker = new Speaker($("announcer"));
  bus = new Bus();
  social = new Social(CFG);

  const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  $("nameInput").value = prefs.name || "";
  state.lastDeviceId = prefs.deviceId || ""; // preselect hint only - user still confirms
  state.mode = prefs.mode === "gps" ? "gps" : "esp";
  state.myFloor = FLOORS.includes(prefs.myFloor) ? prefs.myFloor : "1";
  state.stairPref = prefs.stairPref === "west" ? "west" : "central";
  state.appMode = prefs.appMode === "production" ? "production" : "test";
  $("blindToggle").checked = !!prefs.blind;
  $("accessibleToggle").checked = !!prefs.accessible;
  if (!social.enabled) $("soloNote").hidden = false;

  await loadLibraryCatalog(prefs.libraryId);

  // Three-step onboarding: 0) library, 1) profile -> connect, 2) sensor/mode.
  let welcomeStep = 0;
  $("welcomeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("startBtn");
    if (welcomeStep === 0) {
      if (!state.library) return;
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        await openLibrary(state.library);
        welcomeStep = 1;
        $("stepLibrary").hidden = true;
        $("stepProfile").hidden = false;
        btn.textContent = "Continue";
        btn.disabled = false;
      } catch (err) {
        toast(`Could not load library: ${err.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Continue";
      }
    } else if (welcomeStep === 1) {
      btn.disabled = true;
      btn.textContent = "Connecting…";
      try {
        await startCore({
          name: $("nameInput").value.trim() || "Visitor",
          blind: $("blindToggle").checked,
          accessible: $("accessibleToggle").checked,
        });
        welcomeStep = 2;
        $("stepProfile").hidden = true;
        $("stepDevice").hidden = false;
        btn.textContent = "Start navigating";
        setPositionMode(state.mode);
        renderDeviceList();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "Continue";
      }
    } else {
      if (state.mode === "esp" && !state.deviceId) return;
      finalizeStart();
    }
  });
  $("modeEsp").addEventListener("click", () => setPositionMode("esp"));
  $("modeGps").addEventListener("click", () => setPositionMode("gps"));
}

/* ------------------------- library selection ---------------------------- */
async function loadLibraryCatalog(preferredId) {
  let catalog;
  try {
    catalog = await (await fetch("data/libraries.json", { cache: "no-cache" })).json();
  } catch {
    // fall back to the single bundled map so the app still works
    catalog = { libraries: [
      { id: "main", name: "Library", location: "", model: "data/map_model.json", available: true },
    ] };
  }
  state.catalog = catalog.libraries || [];
  const available = state.catalog.filter((l) => l.available);
  state.library =
    state.catalog.find((l) => l.id === preferredId && l.available) || available[0] || null;
  renderLibraryList();
}

function renderLibraryList() {
  const box = $("libraryList");
  box.innerHTML = "";
  for (const lib of state.catalog) {
    const selected = state.library?.id === lib.id;
    const row = el(`<div class="lib-row ${lib.available ? "" : "disabled"} ${selected ? "selected" : ""}"
        role="option" aria-selected="${selected}" tabindex="${lib.available ? 0 : -1}">
      <span class="lib-icon">${lib.available ? "📚" : "🔒"}</span>
      <span class="lib-text"><b>${esc(lib.name)}</b><span>${esc(lib.location || "")}</span></span>
      ${lib.available ? '<span class="lib-check">✓</span>' : '<span class="lib-soon">Soon</span>'}</div>`);
    if (lib.available) {
      const pick = () => {
        state.library = lib;
        renderLibraryList();
        $("startBtn").disabled = false;
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    }
    box.appendChild(row);
  }
  $("startBtn").disabled = !state.library;
}

/** Load the chosen library's map model and build the 3D scene. */
async function openLibrary(lib) {
  model = await (await fetch(lib.model, { cache: "no-cache" })).json();
  scene = new MapScene($("scene"), model, { onZoneClick: onZoneTap });
  nav = new Navigator(model);
  state.geo = null;
  state.smoother.reset();
  const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs, libraryId: lib.id }));
}

/** Switch between "esp" (sensor + GPS) and "gps" (GPS only, manual floor). */
function setPositionMode(mode) {
  state.mode = mode;
  const esp = mode === "esp";
  $("modeEsp").classList.toggle("selected", esp);
  $("modeEsp").setAttribute("aria-checked", esp);
  $("modeGps").classList.toggle("selected", !esp);
  $("modeGps").setAttribute("aria-checked", !esp);
  $("espPickWrap").hidden = !esp;
  if (!esp) state.deviceId = "";
  $("startBtn").disabled = esp && !state.deviceId;
}

/* ------------------------- sensor discovery picker ---------------------- */
function renderDeviceList() {
  const box = $("deviceList");
  if ($("stepDevice").hidden) return;
  const devices = (state.directory?.devices || [])
    .filter((d) => d.role === "user")
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    .slice(0, CFG.maxDevices);

  if (!devices.length) {
    box.innerHTML =
      `<div class="dev-empty"><div class="spinner"></div>` +
      `Searching for nearby sensors… make sure your unit is powered on.</div>`;
    return;
  }

  box.innerHTML = "";
  for (const d of devices) {
    const takenByOther = d.pairedBy && d.pairedBy !== state.uid;
    const usable = d.online && !takenByOther;
    const status = takenByOther ? "In use" : d.online ? "Available" : "Offline";
    const bars = d.rssi == null ? 0 : d.rssi > -55 ? 4 : d.rssi > -65 ? 3 : d.rssi > -75 ? 2 : 1;
    const row = el(`<div class="dev-row ${usable ? "" : "disabled"} ${state.deviceId === d.id ? "selected" : ""}"
        role="option" aria-selected="${state.deviceId === d.id}" tabindex="${usable ? 0 : -1}">
      <span class="sig" title="${d.rssi != null ? d.rssi + " dBm" : "no signal"}">
        ${[1, 2, 3, 4].map((i) => `<i class="${i <= bars ? "on" : ""}"></i>`).join("")}</span>
      <span class="dev-id">${esc(d.id)}</span>
      <span class="dev-status">${status}</span></div>`);
    if (usable) {
      const select = () => {
        state.deviceId = d.id;
        $("startBtn").disabled = false;
        renderDeviceList();
      };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      });
    }
    box.appendChild(row);
  }

  // returning visitor convenience: highlight last unit, still needs a tap
  if (!state.deviceId && state.lastDeviceId) {
    const prev = devices.find((d) => d.id === state.lastDeviceId && d.online &&
      (!d.pairedBy || d.pairedBy === state.uid));
    if (prev) {
      const rows = box.querySelectorAll(".dev-row");
      const idx = devices.indexOf(prev);
      rows[idx]?.classList.add("suggested");
    }
  }
}

async function startCore(opts) {
  Object.assign(state, opts);

  // ---- identity
  let extraKeywords = [];
  if (social.enabled) {
    state.uid = await social.signIn(state.name);
    extraKeywords = await social.loadKeywords().catch(() => []);
    social.addEventListener("friends-changed", refreshFriends);
  } else {
    const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
    state.uid = prefs.uid || crypto.randomUUID();
    localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs, ...opts, uid: state.uid }));
    $("btnFriends").style.display = "none";
  }
  intent = new IntentEngine(model, extraKeywords);

  // ---- voice
  speaker.enabled = state.blind || JSON.parse(localStorage.getItem("libnav.voice") || "false");
  if (state.blind) {
    document.body.classList.add("blind");
    speaker.enabled = true;
  }
  reflectVoiceButton();
  guidance = new Guidance(speaker, { blindMode: state.blind, onReroute: reroute });
  listener = new Listener(
    (text) => { $("chatInput").value = text; submitChat(); },
    (on) => $("btnMic").classList.toggle("listening", on)
  );
  if (!listener.available) $("btnMic").hidden = true;

  // ---- connectivity
  bus.connect(CFG, state.uid);
  bus.addEventListener("status", (e) => updateMqttDot(e.detail.state));
  bus.addEventListener("latency", (e) => {
    $("latency").textContent = `${e.detail.ms} ms`;
  });
  bus.client.on("connect", () => {
    publishPairing(); // re-assert (or clear) the claim on every (re)connect
    publishFloor();
    const anchors = JSON.parse(localStorage.getItem("libnav.anchors") || "null");
    if (anchors) bus.publish("libnav/site/anchors", anchors, { retain: true, qos: 1 });
  });

  bus.on(`libnav/user/${state.uid}/pos`, (t, payload) => onSelfPos(JSON.parse(payload)));
  bus.on(`libnav/user/${state.uid}/control`, (t, payload) => onControl(JSON.parse(payload)));
  bus.on("libnav/engine/status", (t, payload) => {
    state.engineOnline = payload.toString() === "online";
    if (!state.engineOnline) toast("Position engine offline - live tracking paused", "warn");
  });
  // live sensor discovery feed (drives the pairing picker + sensor dot)
  bus.on("libnav/directory", (t, payload) => {
    try {
      state.directory = JSON.parse(payload);
      renderDeviceList();
    } catch { /* ignore malformed */ }
  });
  // telemetry of whichever unit is currently paired (wildcard + guard, so
  // re-pairing needs no re-subscription bookkeeping)
  bus.on("libnav/dev/+/telemetry", (t, payload) => {
    if (!state.deviceId || t.split("/")[2] !== state.deviceId) return;
    const d = JSON.parse(payload);
    state.sensorLastSeen = Date.now();
    state.sensorRssi = d.rssi;
  });

  // ---- GPS
  gps = new GpsPublisher(bus, state.uid, CFG.gpsPublishHz);
  gps.addEventListener("fix", (e) => {
    updateGpsDot(e.detail.acc);
    showLocalGps(e.detail); // move the dot as you walk, engine or not
  });
  gps.addEventListener("error", (e) => {
    updateGpsDot(null);
    toast(`GPS: ${e.detail}`, "warn");
  });
  gps.start();

  setInterval(updateSensorDot, 2000);

  wireUi();
  await refreshFriends();
}

/** Called once the user has explicitly chosen a mode (and sensor, if any). */
function finalizeStart() {
  const prev = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  localStorage.setItem("libnav.prefs", JSON.stringify({
    ...prev,
    name: state.name, blind: state.blind, accessible: state.accessible,
    deviceId: state.deviceId || "", mode: state.mode, myFloor: state.myFloor,
    libraryId: state.library?.id || prev.libraryId,
  }));
  publishPairing();
  publishFloor();
  if (social.enabled && state.deviceId) {
    social.registerDevice(state.deviceId).catch(() => {});
  }
  $("welcomeModal").hidden = true;

  const gpsOnly = state.mode === "gps";
  $("myFloorSel").hidden = !gpsOnly;
  if (gpsOnly) $("myFloorSel").value = state.myFloor;

  const sensorNote = gpsOnly
    ? `GPS-only mode - tell me your floor with the "I'm on" selector in the top bar.`
    : `Sensor ${state.deviceId} is paired with your GPS.`;
  chatSystem(
    `Welcome, ${state.name}. ${sensorNote} Ask me for a book subject ` +
    `("C language", "Qing dynasty history"), a place ("somewhere to study", ` +
    `"newspapers"), or a friend's name.`
  );
  speaker.speak(
    `Welcome to the library navigator, ${state.name}. ` +
    (gpsOnly
      ? `G P S only mode. You are set to floor ${state.myFloor}. `
      : `Sensor ${state.deviceId} paired. `) +
    (state.blind ? "Voice guidance is on. Type or dictate where you want to go." : "")
  , { interrupt: true });
}

/** Retained claim: {device} to pair, empty payload to release. */
function publishPairing() {
  if (!state.uid) return;
  const topic = `libnav/user/${state.uid}/pair`;
  if (state.deviceId) {
    bus.publish(topic, { device: state.deviceId }, { retain: true, qos: 1 });
  } else {
    bus.publish(topic, "", { retain: true, qos: 1 });
  }
}

/** Retained manual floor for GPS-only mode; empty = sensor decides. */
function publishFloor() {
  if (!state.uid) return;
  const topic = `libnav/user/${state.uid}/floor`;
  if (state.mode === "gps") {
    bus.publish(topic, { floor: +state.myFloor }, { retain: true, qos: 1 });
  } else {
    bus.publish(topic, "", { retain: true, qos: 1 });
  }
}

/* ============================== positions =============================== */
function onSelfPos(p) {
  state.lastFusedAt = Date.now(); // engine is live -> local GPS fallback stands down
  // production mode: even engine-fused positions are hidden when the phone's
  // own GPS says we are outside the library geofence
  if (state.appMode === "production" && gps?.lastFix && !passesGeofence(gps.lastFix)) {
    return;
  }
  hideAwayNotice();
  state.pos = p;
  state.pressureOk = !!p.q?.pressureOk;
  scene.updateMarker(state.uid, p, { self: true });
  $("floorNow").textContent = `Floor ${p.floor}`;

  if (guidance?.active && state.route) {
    const off = Navigator.offRouteDistance(state.route, p);
    const result = guidance.update(p, off);
    if (result === "arrived") endRoute(true);
    updateRouteBanner(p);
  }
}

/* ---- live GPS position (used when the fusion engine isn't supplying one) --
 * On the deployed page with no engine running, this is what makes your dot
 * appear and move as you walk. It mirrors the engine's lat/lng -> local-metre
 * conversion. Until you calibrate (gear button), the frame is auto-anchored to
 * wherever you first stood, so movement still shows even if it isn't yet
 * aligned to the real building. */
function makeGeo(anchors) {
  const lat0 = anchors.origin.lat, lng0 = anchors.origin.lng;
  const mLat = 111132.0;
  const mLng = 111320.0 * Math.cos((lat0 * Math.PI) / 180);
  const e = (anchors.xAxis.lng - lng0) * mLng;
  const n = (anchors.xAxis.lat - lat0) * mLat;
  const norm = Math.hypot(e, n) || 1;
  const ux = [e / norm, n / norm];
  const uy = [ux[1], -ux[0]];
  return (lat, lng) => {
    const de = (lng - lng0) * mLng;
    const dn = (lat - lat0) * mLat;
    return [de * ux[0] + dn * ux[1], de * uy[0] + dn * uy[1]];
  };
}

function ensureGeo(fix) {
  if (state.geo) return state.geo;
  const saved = JSON.parse(localStorage.getItem("libnav.anchors") || "null");
  if (saved) {
    state.geo = makeGeo(saved);
  } else if (state.appMode === "production") {
    // production: anchor to the real building position (never auto-anchor) so
    // the marker lands where you actually are inside the library
    state.geo = makeGeo(model.site.geoAnchors);
  } else {
    // test mode, no calibration: anchor the local frame to the first fix so the
    // dot sits at the map origin and walking is visible anywhere immediately
    const mLng = 111320.0 * Math.cos((fix.lat * Math.PI) / 180);
    state.geo = makeGeo({
      origin: { lat: fix.lat, lng: fix.lng },
      xAxis: { lat: fix.lat, lng: fix.lng + model.site.width / mLng },
    });
    toast("Test mode: showing your live GPS anywhere. Use ⚙ to align or switch to production.", "ok");
  }
  return state.geo;
}

/** Great-circle distance in metres between two lat/lng points. */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Distance (m) from a fix to the library centre, or null if not configured. */
function distanceToLibrary(fix) {
  const c = model?.site?.center;
  if (!c) return null;
  return haversine(fix.lat, fix.lng, c.lat, c.lng);
}

/**
 * Production-mode geofence. Returns true if the marker may be shown.
 * In test mode always true. In production, hides the marker and shows an
 * "away" notice when the phone is beyond geofenceRadius of the library.
 */
function passesGeofence(fix) {
  if (state.appMode !== "production" || !fix) return true;
  const d = distanceToLibrary(fix);
  const radius = model.site.geofenceRadius || 200;
  if (d != null && d > radius) {
    scene?.removeMarker(state.uid);
    state.pos = null;
    showAwayNotice(d, radius);
    return false;
  }
  hideAwayNotice();
  return true;
}

function showAwayNotice(distanceM, radius) {
  const el = $("awayNotice");
  if (!el) return;
  const km = distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.round(distanceM)} m`;
  el.querySelector(".away-dist").textContent = km;
  el.querySelector(".away-radius").textContent = `${radius} m`;
  el.hidden = false;
  $("floorNow").textContent = "Away";
}
function hideAwayNotice() {
  const el = $("awayNotice");
  if (el && !el.hidden) el.hidden = true;
}

/** Switch between test and production modes; re-evaluate the current position. */
function setAppMode(mode) {
  state.appMode = mode === "production" ? "production" : "test";
  const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs, appMode: state.appMode }));
  state.geo = null;            // production/test use different anchoring
  state.smoother.reset();
  hideAwayNotice();
  if (state.appMode === "test") {
    toast("Test mode: your position shows anywhere.", "ok");
  } else {
    toast("Production mode: your position shows only within the library.", "ok");
  }
  speaker?.speak(state.appMode === "production"
    ? "Production mode. Your position will show only near the library."
    : "Test mode. Your position shows anywhere.");
  if (gps?.lastFix) showLocalGps(gps.lastFix);
}

/* Accuracy-weighted low-pass with per-update motion clamp. Turns jittery raw
 * GPS into a stable, smoothly moving marker; a single wild fix can't yank it
 * across the building. Works in local metres, so it is reset whenever the geo
 * frame changes (new library / recalibration). */
function makeGpsSmoother() {
  let sx = null, sy = null, st = 0;
  return {
    reset() { sx = null; sy = null; st = 0; },
    update(x, y, acc, now) {
      if (sx === null) { sx = x; sy = y; st = now; return [x, y]; }
      const dt = Math.max(0.05, (now - st) / 1000);
      st = now;
      const gain = Math.min(0.6, Math.max(0.12, 15 / (acc + 15))); // trust good fixes more
      let nx = sx + gain * (x - sx);
      let ny = sy + gain * (y - sy);
      // cap correction to a plausible walking envelope for this interval
      const maxStep = 2.0 * dt + acc * 0.15;
      const d = Math.hypot(nx - sx, ny - sy);
      if (d > maxStep) { const k = maxStep / d; nx = sx + (nx - sx) * k; ny = sy + (ny - sy) * k; }
      sx = nx; sy = ny;
      return [sx, sy];
    },
  };
}

/** Nearest point on the floor's walkable graph, if within `maxDist` metres. */
function snapToGraph(floorStr, x, y, maxDist = 10) {
  const floor = model.floors[floorStr];
  if (!floor) return [x, y];
  const nodes = {};
  for (const n of floor.nodes) nodes[n.id] = n;
  let bx = x, by = y, bd = Infinity;
  for (const [a, b] of floor.edges) {
    const na = nodes[a], nb = nodes[b];
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - na.x) * dx + (y - na.y) * dy) / l2)) : 0;
    const qx = na.x + t * dx, qy = na.y + t * dy;
    const d = Math.hypot(x - qx, y - qy);
    if (d < bd) { bd = d; bx = qx; by = qy; }
  }
  return bd <= maxDist ? [bx, by] : [x, y];
}

function showLocalGps(fix) {
  if (!state.uid || !scene) return;
  // defer to the fusion engine whenever it is actively publishing
  if (state.lastFusedAt && Date.now() - state.lastFusedAt < 6000) return;
  // drop unusable fixes so the marker never teleports on a bad reading
  if (fix.acc != null && fix.acc > 100) return;
  // production mode: hide the marker unless we are near the library
  if (!passesGeofence(fix)) return;

  const toLocal = ensureGeo(fix);
  const W = model.site.width, D = model.site.depth;
  let [x, y] = toLocal(fix.lat, fix.lng);
  [x, y] = state.smoother.update(x, y, fix.acc ?? 30, Date.now());
  x = Math.max(-8, Math.min(W + 8, x));
  y = Math.max(-8, Math.min(D + 8, y));

  const floor = state.mode === "gps"
    ? state.myFloor
    : String(state.pos?.floor || state.myFloor || "2");

  // snap onto corridors once the map is calibrated (skip while auto-anchored,
  // where the frame isn't yet aligned to the building)
  if (localStorage.getItem("libnav.anchors")) [x, y] = snapToGraph(floor, x, y);

  const pos = { x, y, floor: Number(floor), q: { gpsAcc: fix.acc, mode: "local-gps" } };
  state.pos = pos;
  scene.updateMarker(state.uid, pos, { self: true });
  $("floorNow").textContent = `Floor ${floor}`;

  if (guidance?.active && state.route) {
    const off = Navigator.offRouteDistance(state.route, pos);
    const r = guidance.update(pos, off);
    if (r === "arrived") endRoute(true);
    updateRouteBanner(pos);
  }
}

function onControl(msg) {
  if (msg.action === "reject") {
    const first = state.admitted;
    state.admitted = false;
    state.lastRejectAt = Date.now();
    if (msg.active) {
      $("capacityText").innerHTML =
        `Active devices: <b>${msg.active} / ${msg.max || CFG.maxDevices}</b>.<br />` +
        "You are queued and will connect automatically when a slot frees up.";
    }
    $("capacityOverlay").hidden = false;
    if (first) speaker.speak("The system is at full capacity. You are in the queue.");
  } else if (msg.action === "admit") {
    if (!state.admitted) toast("A slot opened up - you are connected", "ok");
    state.admitted = true;
    $("capacityOverlay").hidden = true;
  } else if (msg.action === "pair_ok") {
    toast(`Sensor ${msg.device} paired`, "ok");
  } else if (msg.action === "pair_denied") {
    const why = msg.reason === "in-use"
      ? `${msg.device} is already in use by another visitor`
      : `${msg.device} cannot be paired (${msg.reason})`;
    state.deviceId = "";
    publishPairing();
    toast(why, "warn");
    speaker.speak(`Pairing failed. ${why}. Please pick another sensor.`);
    // reopen the picker so the user chooses a different unit (or GPS-only)
    $("stepProfile").hidden = true;
    $("stepDevice").hidden = false;
    $("startBtn").textContent = "Start navigating";
    $("welcomeModal").hidden = false;
    setPositionMode("esp");
    renderDeviceList();
  }
}

// Self-healing: the engine re-sends "reject" every 5 s while we are queued.
// If that heartbeat stops (slot freed but the admit was lost, engine restart,
// stale state), clear the overlay instead of blocking the user forever.
setInterval(() => {
  if (!$("capacityOverlay").hidden && Date.now() - (state.lastRejectAt || 0) > 15000) {
    state.admitted = true;
    $("capacityOverlay").hidden = true;
    toast("Capacity hold cleared - resuming", "ok");
  }
}, 3000);

/* ============================== navigation ============================== */
function navigateTo(target, lead = "") {
  const start = state.pos
    ? { floor: state.pos.floor, x: state.pos.x, y: state.pos.y }
    : DEFAULT_START;
  const route = nav.route(start, target, routeProfile());
  if (!route) {
    chatSystem("Sorry, I could not compute a route to that destination.");
    return;
  }
  state.route = route;
  state.routeTarget = target;
  scene.showPath(route.points);
  scene.highlightZone(typeof target === "string" ? target : null);
  if (!state.pos) {
    chatSystem("No live position yet - route starts from the floor 1 entrance.");
  }

  $("routeBanner").hidden = false;
  $("routeDest").textContent = route.targetName;
  updateRouteBanner(state.pos);
  guidance.start(route);
  if (lead) chatSystem(lead);
}

function updateRouteBanner(pos) {
  const r = state.route;
  if (!r) return;
  let remaining = r.totalM;
  if (pos) {
    const last = r.points[r.points.length - 1];
    if (String(last.floor) === String(pos.floor)) {
      remaining = Math.round(Math.hypot(last.x - pos.x, last.y - pos.y));
    }
  }
  const mins = Math.max(1, Math.round(r.etaS / 60));
  $("routeMeta").textContent = `${remaining} m · ~${mins} min · ${r.instructions.length - 1} steps`;
  // show the vertical option in use, and let the user switch it
  const viaLabel = { central: "Central stairs", west: "Stairs by elevator", elevator: "Elevator" }[routeProfile()];
  const crossesFloors = r.points.some((p, i) => i && p.floor !== r.points[i - 1].floor);
  $("routeVia").hidden = !crossesFloors;
  $("routeVia").textContent = `via ${viaLabel}`;
}

/** Cycle the stair preference (central ⇄ elevator-side) and re-route. */
function toggleStairPref() {
  if (state.accessible) {
    toast("Step-free mode is on - routes use the elevator.", "warn");
    return;
  }
  state.stairPref = state.stairPref === "central" ? "west" : "central";
  const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs, stairPref: state.stairPref }));
  const label = state.stairPref === "central" ? "the central stairs" : "the stairs by the elevator";
  toast(`Routing via ${label}`, "ok");
  speaker.speak(`Now routing via ${label}.`);
  if (state.routeTarget) navigateTo(state.routeTarget);
}

function reroute() {
  if (state.routeTarget) navigateTo(state.routeTarget);
}

function endRoute(arrived = false) {
  guidance.stop(arrived);
  scene.clearPath();
  scene.highlightZone(null);
  $("routeBanner").hidden = true;
  state.route = null;
  state.routeTarget = null;
  if (arrived) chatSystem("You have arrived. Anything else?");
}

function onZoneTap(zoneId) {
  const zone = nav.zones[zoneId];
  if (!zone) return;
  openZoneInfo(zone);
}

/* ---- zone info popup (name, description, real photo, navigate) ---------- */
function openZoneInfo(zone) {
  const staff = zone.kind === "staff";
  $("zoneName").textContent = zone.name;
  $("zoneFloor").textContent = `Floor ${zone.floor}`;
  $("zoneDesc").textContent =
    zone.desc || (staff ? "Staff-only area, not open to visitors." : "");
  $("zoneDesc").hidden = !$("zoneDesc").textContent;

  // Real photo: an explicit zone.photo, else the drop-in convention
  // web/photos/<ZONE-ID>.jpg. Missing files fall back to a colour placeholder,
  // so adding a photo needs no code change - just drop the file in.
  const img = $("zonePhotoImg");
  const ph = $("zonePhotoPlaceholder");
  const src = zone.photo || `photos/${encodeURIComponent(zone.id)}.jpg`;
  ph.style.background = zone.color;
  ph.textContent = "";
  img.hidden = true;
  ph.hidden = false;
  img.onload = () => { img.hidden = false; ph.hidden = true; };
  img.onerror = () => { img.hidden = true; ph.hidden = false; ph.textContent = "No photo yet"; };
  img.alt = zone.name;
  img.src = src;

  const goBtn = $("zoneGoBtn");
  goBtn.hidden = staff;
  goBtn.onclick = () => {
    $("zoneModal").hidden = true;
    chatSystem(`Navigating to ${zone.name}.`);
    speaker.speak(`Navigating to ${zone.name}.`);
    navigateTo(zone.id);
  };
  $("zoneModal").hidden = false;
}

/* ============================== chat ==================================== */
function submitChat() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  $("suggestions").innerHTML = "";
  chatBubble(text, "user");

  // friend queries take priority: "where is amy" / "find amy" / "amy"
  const friendQuery = text.toLowerCase().replace(/^(find|where is|where's|go to|navigate to)\s+/i, "");
  for (const [fuid, f] of state.friends) {
    if (f.name.toLowerCase() === friendQuery) {
      goToFriend(fuid);
      return;
    }
  }

  const res = intent.resolve(text);
  if (res.kind === "zone") {
    chatSystem(res.reply);
    speaker.speak(res.reply);
    navigateTo(res.zoneId);
  } else if (res.kind === "nearest") {
    const start = state.pos || DEFAULT_START;
    const best = nav.nearest(
      { floor: start.floor, x: start.x, y: start.y },
      res.candidates,
      routeProfile()
    );
    if (best) {
      const reply = `${res.lead} ${nav.zones[best.id].name}, floor ${nav.zones[best.id].floor}.`;
      chatSystem(reply);
      speaker.speak(reply);
      navigateTo(best.id);
    } else {
      chatSystem("No reachable destination found.");
    }
  } else {
    chatSystem(res.reply || "Sorry, I did not understand that.");
    speaker.speak(res.reply || "Sorry, I did not understand that.");
  }
}

function chatBubble(text, who) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  // flag unread when a reply arrives while the panel is collapsed
  if (who === "system" && $("chatPanel").hidden) {
    $("chatUnread").hidden = false;
  }
}
const chatSystem = (text) => chatBubble(text, "system");

/** Hide the assistant to reveal the map, or bring it back. */
function setChatCollapsed(collapsed) {
  $("chatPanel").hidden = collapsed;
  $("btnChatOpen").hidden = !collapsed;
  if (!collapsed) $("chatUnread").hidden = true;
  localStorage.setItem("libnav.chatCollapsed", JSON.stringify(collapsed));
}

/* ============================== friends ================================= */
async function refreshFriends() {
  if (!social.enabled) return;
  const { accepted, incoming, outgoing } = await social.listFriends();

  const badge = $("friendBadge");
  badge.hidden = incoming.length === 0;
  badge.textContent = incoming.length;

  $("friendRequests").innerHTML = "";
  for (const req of incoming) {
    const row = el(`<div class="friend-row">
      <span class="fname">${esc(req.name)}</span><span class="fmeta">wants to connect</span>
      <button class="mini ok">Accept</button><button class="mini">Decline</button></div>`);
    const [ok, no] = row.querySelectorAll("button");
    ok.onclick = () => social.respond(req.id, true).then(refreshFriends);
    no.onclick = () => social.respond(req.id, false).then(refreshFriends);
    $("friendRequests").appendChild(row);
  }

  const list = $("friendList");
  list.innerHTML = "";
  const current = new Set(accepted.map((f) => f.uid));
  // drop markers/subscriptions for removed friends
  for (const [fuid, f] of state.friends) {
    if (!current.has(fuid)) {
      bus.unsubscribe(`libnav/user/${fuid}/pos`);
      bus.unsubscribe(`libnav/user/${fuid}/presence`);
      scene.removeMarker(fuid);
      state.friends.delete(fuid);
    }
  }
  for (const f of accepted) {
    if (!state.friends.has(f.uid)) {
      state.friends.set(f.uid, { name: f.name, online: false, pos: null });
      bus.on(`libnav/user/${f.uid}/pos`, (t, payload) => {
        const pos = JSON.parse(payload);
        const fr = state.friends.get(f.uid);
        if (fr) { fr.pos = pos; fr.online = true; }
        scene.updateMarker(f.uid, pos, { name: f.name });
        renderFriendRows();
      });
      bus.on(`libnav/user/${f.uid}/presence`, (t, payload) => {
        const fr = state.friends.get(f.uid);
        if (fr) fr.online = payload.toString() === "online";
        renderFriendRows();
      });
    }
  }
  renderFriendRows();

  for (const o of outgoing) {
    list.appendChild(el(
      `<div class="friend-row pending"><span class="fname">${esc(o.name)}</span>
       <span class="fmeta">request sent…</span></div>`
    ));
  }
}

function renderFriendRows() {
  const list = $("friendList");
  list.querySelectorAll(".friend-row.live").forEach((n) => n.remove());
  for (const [fuid, f] of state.friends) {
    const floor = f.pos ? `Floor ${f.pos.floor}` : "no signal";
    const row = el(`<div class="friend-row live">
      <span class="dot ${f.online && f.pos ? "ok" : ""}"></span>
      <span class="fname">${esc(f.name)}</span><span class="fmeta">${floor}</span>
      <button class="mini" ${f.pos ? "" : "disabled"}>Locate</button>
      <button class="mini ok" ${f.pos ? "" : "disabled"}>Go</button></div>`);
    const [locate, go] = row.querySelectorAll("button");
    locate.onclick = () => {
      scene.setFloorFocus(String(f.pos.floor));
      setActiveChip(String(f.pos.floor));
      scene.focusOn(f.pos);
    };
    go.onclick = () => goToFriend(fuid);
    list.prepend(row);
  }
}

function goToFriend(fuid) {
  const f = state.friends.get(fuid);
  if (!f?.pos) {
    chatSystem(`${f?.name || "That friend"} has no live position right now.`);
    return;
  }
  const reply = `${f.name} is on floor ${f.pos.floor}. Navigating to them.`;
  chatSystem(reply);
  speaker.speak(reply);
  navigateTo({ floor: f.pos.floor, x: f.pos.x, y: f.pos.y, name: f.name });
}

/* ============================== UI wiring =============================== */
function wireUi() {
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); submitChat(); });

  $("myFloorSel").addEventListener("change", () => {
    state.myFloor = $("myFloorSel").value;
    publishFloor();
    const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
    localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs, myFloor: state.myFloor }));
    toast(`Your floor is set to ${state.myFloor}F`, "ok");
    speaker.speak(`Floor set to ${state.myFloor}.`);
    if (gps?.lastFix) showLocalGps(gps.lastFix); // move the dot to the new floor now
  });

  $("chatInput").addEventListener("input", () => {
    const sugg = intent.suggest($("chatInput").value);
    const box = $("suggestions");
    box.innerHTML = "";
    for (const s of sugg) {
      const chip = el(`<button type="button" class="chip">${esc(s.label)}</button>`);
      chip.onclick = () => { $("chatInput").value = s.term; submitChat(); };
      box.appendChild(chip);
    }
  });

  document.querySelectorAll("#quickChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("chatInput").value = chip.dataset.q;
      submitChat();
    });
  });

  // collapse / reopen the assistant so it doesn't cover the map
  $("btnChatCollapse").addEventListener("click", () => setChatCollapsed(true));
  $("btnChatOpen").addEventListener("click", () => setChatCollapsed(false));
  setChatCollapsed(JSON.parse(localStorage.getItem("libnav.chatCollapsed") || "false"));

  document.querySelectorAll("#floorChips .fchip").forEach((chip) => {
    chip.addEventListener("click", () => {
      scene.setFloorFocus(chip.dataset.floor);
      setActiveChip(chip.dataset.floor);
    });
  });
  $("btnExplode").addEventListener("click", () => {
    const on = $("btnExplode").classList.toggle("active");
    scene.setExploded(on);
  });

  $("btnVoice").addEventListener("click", () => {
    speaker.enabled = !speaker.enabled;
    localStorage.setItem("libnav.voice", JSON.stringify(speaker.enabled));
    reflectVoiceButton();
    if (speaker.enabled) {
      speaker.speak("Voice guidance on.", { interrupt: true });
    } else {
      speaker.stop(); // cut off whatever is currently being spoken
    }
  });
  $("btnMic").addEventListener("click", () => listener.toggle());

  $("btnFriends").addEventListener("click", () => {
    $("friendsPanel").classList.toggle("open");
  });
  $("btnCloseFriends").addEventListener("click", () => {
    $("friendsPanel").classList.remove("open");
  });
  $("friendSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("friendSearchInput").value.trim();
    if (!q) return;
    const results = await social.searchUsers(q);
    const box = $("friendSearchResults");
    box.innerHTML = results.length ? "" : "<div class='fmeta pad'>No users found.</div>";
    for (const r of results) {
      const row = el(`<div class="friend-row"><span class="fname">${esc(r.display_name)}</span>
        <button class="mini ok">Add</button></div>`);
      row.querySelector("button").onclick = async () => {
        await social.sendRequest(r.id);
        row.querySelector("button").textContent = "Sent";
        row.querySelector("button").disabled = true;
        refreshFriends();
      };
      box.appendChild(row);
    }
  });

  $("btnEndRoute").addEventListener("click", () => endRoute(false));
  $("routeVia").addEventListener("click", toggleStairPref);

  // zone info popup
  $("btnCloseZone").addEventListener("click", () => { $("zoneModal").hidden = true; });
  $("zoneModal").addEventListener("click", (e) => {
    if (e.target === $("zoneModal")) $("zoneModal").hidden = true;
  });

  // settings / calibration
  $("btnSettings").addEventListener("click", () => {
    const a = JSON.parse(localStorage.getItem("libnav.anchors") || "null")
      || model.site.geoAnchors;
    $("originLat").value = a.origin.lat; $("originLng").value = a.origin.lng;
    $("xLat").value = a.xAxis.lat; $("xLng").value = a.xAxis.lng;
    const radio = document.querySelector(`input[name="appMode"][value="${state.appMode}"]`);
    if (radio) radio.checked = true;
    $("settingsModal").hidden = false;
  });
  // app mode applies immediately (no need to save the calibration form)
  document.querySelectorAll('input[name="appMode"]').forEach((r) => {
    r.addEventListener("change", () => { if (r.checked) setAppMode(r.value); });
  });
  $("btnCloseSettings").addEventListener("click", () => { $("settingsModal").hidden = true; });
  const useHere = (latEl, lngEl) => () => {
    const fix = gps?.lastFix;
    if (!fix) { toast("No GPS fix yet", "warn"); return; }
    $(latEl).value = fix.lat.toFixed(7);
    $(lngEl).value = fix.lng.toFixed(7);
  };
  $("btnUseHereOrigin").addEventListener("click", useHere("originLat", "originLng"));
  $("btnUseHereX").addEventListener("click", useHere("xLat", "xLng"));
  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const anchors = {
      origin: { lat: +$("originLat").value, lng: +$("originLng").value },
      xAxis: { lat: +$("xLat").value, lng: +$("xLng").value },
    };
    localStorage.setItem("libnav.anchors", JSON.stringify(anchors));
    bus.publish("libnav/site/anchors", anchors, { retain: true, qos: 1 });
    state.geo = null; // rebuild the local converter from the new calibration
    state.smoother.reset();
    if (gps?.lastFix) showLocalGps(gps.lastFix);
    $("settingsModal").hidden = true;
    toast("Geo anchors saved and broadcast to the engine", "ok");
  });
}

function setActiveChip(floor) {
  document.querySelectorAll("#floorChips .fchip").forEach((c) => {
    c.classList.toggle("active", c.dataset.floor === floor);
  });
}

function reflectVoiceButton() {
  $("btnVoice").classList.toggle("active", speaker.enabled);
  $("btnVoice").setAttribute("aria-pressed", speaker.enabled);
}

/* ============================== indicators ============================== */
function updateMqttDot(s) {
  const dot = $("connMqtt");
  dot.className = "dot " + (s === "connected" ? "ok" : s === "reconnecting" ? "warn" : "err");
  dot.title = `Server: ${s}`;
}

function updateGpsDot(acc) {
  const dot = $("connGps");
  if (acc == null) { dot.className = "dot err"; dot.title = "GPS: unavailable"; return; }
  dot.className = "dot " + (acc < 25 ? "ok" : acc < 60 ? "warn" : "err");
  dot.title = `GPS accuracy: ±${Math.round(acc)} m`;
}

function updateSensorDot() {
  const dot = $("connSensor");
  if (state.mode === "gps") {
    dot.className = "dot";
    dot.title = "GPS-only mode - floor set manually";
    return;
  }
  if (!state.deviceId) { dot.className = "dot"; dot.title = "No sensor paired"; return; }
  const age = Date.now() - state.sensorLastSeen;
  const cls = age < 5000 ? "ok" : age < 15000 ? "warn" : "err";
  dot.className = "dot " + cls;
  dot.title = `Sensor ${state.deviceId}: ` +
    (age < 15000 ? `online, RSSI ${state.sensorRssi} dBm` : "no data");
}

/* ============================== utils =================================== */
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 4200);
}

boot().catch((err) => {
  console.error(err);
  toast(`Startup failed: ${err.message}`, "error");
});

// debug/testing handle (harmless in production)
window.__nav = { state, renderDeviceList, showLocalGps, setChatCollapsed,
  openZoneInfo, navigateTo, submitChat: () => submitChat(),
  zonesOf: () => nav?.zones,
  scene: () => scene,
  setAppMode, distanceToLibrary,
  feedFix: (fix) => { if (gps) gps.lastFix = fix; showLocalGps(fix); },
  floorVisibility: () => Object.fromEntries(
    Object.entries(scene.floorGroups).map(([lvl, g]) => [lvl, {
      visible: g.visible,
      slabOpacity: +(g.children.find(c => c.userData?.baseOpacity === 0.92)?.material.opacity ?? 0).toFixed(2),
    }])),
  markerCount: () => scene?.markers?.size ?? 0,
  selfMarker: () => scene?.markers?.get(state.uid)?.target };
