/*
 * App: first-run setup, search, place cards, directions, friends and settings
 * around the 3D map. MQTT and GPS live in net.js, routing in nav.js.
 */
import { MapScene } from "./map3d.js?v=set1";
import { Navigator } from "./nav.js?v=set1";
import { IntentEngine } from "./intent.js?v=set1";
import { Speaker, Listener, Guidance } from "./voice.js?v=set1";
import { Bus, GpsPublisher } from "./net.js?v=set1";
import { Social } from "./supa.js?v=set1";
import { icon, OUTLINE, FILLED } from "./icons.js?v=set1";
import { categoryOf, iconOf, AMENITY_KINDS } from "./categories.js?v=set1";
import { Settings, SettingsPage } from "./settings.js?v=set1";

const CFG = window.NAV_CONFIG;
const $ = (id) => document.getElementById(id);

const state = {
  uid: null, name: "", deviceId: "", blind: false, accessible: false,
  mode: "esp", myFloor: "1", // positioning mode: "esp" (sensor+GPS) | "gps" (GPS only)
  stairPref: "central",      // "central" | "west" - which staircase routes use
  appMode: "test",           // "test" (show anywhere) | "production" (geofence)
  pos: null, route: null, routeTarget: null,
  focus: "all", view: "home", place: null,
  friends: new Map(), // uid -> {name, online, pos}
  admitted: true,
  sensorLastSeen: 0, sensorRssi: null, latencyMs: null, mqtt: "connecting",
  catalog: [], library: null, // available libraries + the chosen one
  geo: null, smoother: makeGpsSmoother(), // client-side GPS conversion + smoothing
};

let model, scene, nav, intent, speaker, listener, guidance, bus, gps, social, settingsPage;

const APP_VERSION = "2026.09";
const settings = new Settings();

// option tables for Settings (the accent and text sizes are repeated in the
// small script at the top of index.html, which runs before this file)
const ACCENTS = {
  blue: { hex: "#1a66d2", label: "Blue" },
  teal: { hex: "#0f7f86", label: "Teal" },
  green: { hex: "#1e7f46", label: "Green" },
  purple: { hex: "#6a4bc4", label: "Purple" },
  orange: { hex: "#c4561a", label: "Orange" },
  pink: { hex: "#c23a73", label: "Pink" },
};
const TEXT_SIZES = { s: 0.92, m: 1, l: 1.12, xl: 1.25 };
const SPACING = { close: 1.7, normal: 2.4, wide: 3.2 };
const PACE = { slow: 0.75, normal: 1, fast: 1.25 };
const SMOOTHING = { responsive: 1.7, balanced: 1, steady: 0.55 };

/* ------------------------------------------------------------ small helpers */
const prefs = {
  get() {
    try { return JSON.parse(localStorage.getItem("libnav.prefs") || "{}"); } catch { return {}; }
  },
  set(patch) {
    try { localStorage.setItem("libnav.prefs", JSON.stringify({ ...prefs.get(), ...patch })); } catch { /* private mode */ }
  },
};

/** Where routes start before we have a position (from the library's model). */
const startPoint = () => model?.site?.start || { floor: 1, x: 0, y: 0, label: "the entrance" };
const levels = () => model.site.floors.map((f) => String(f.level));

/** Vertical-circulation profile for routing: step-free wins, else stair choice. */
function routeProfile() {
  if (state.accessible) return "elevator";
  return nav?.hasCore(state.stairPref) ? state.stairPref : "central";
}
const canSwitchStairs = () => nav.hasCore("central") && nav.hasCore("west");

/* Calibration is per library: saved locally and published retained to
 * libnav/site/<library id>/anchors. The Taipei library used to keep it under
 * the unscoped key, so that one is still read as a fallback. */
const anchorsKey = () => `libnav.anchors.${state.library.id}`;
const anchorsTopic = () => `libnav/site/${state.library.id}/anchors`;
function savedAnchors() {
  try {
    const raw = localStorage.getItem(anchorsKey()) ??
      (state.library.id === "main" ? localStorage.getItem("libnav.anchors") : null);
    return JSON.parse(raw || "null");
  } catch {
    return null;
  }
}

/** Fill every <svg data-icon> placeholder in the page with its symbol. */
function hydrateIcons(root = document) {
  root.querySelectorAll("svg[data-icon]").forEach((svg) => {
    const name = svg.dataset.icon;
    const d = (svg.dataset.filled ? FILLED[name] : null) || OUTLINE[name] || FILLED[name];
    if (!d) return;
    svg.setAttribute("viewBox", "0 -960 960 960");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<path d="${d}"/>`;
  });
}
function setIcon(svg, name) {
  svg.dataset.icon = name;
  hydrateIcons(svg.parentElement);
}

function badge(zone, size = "") {
  const cat = categoryOf(zone);
  return `<span class="badge-icon ${size}" style="background:${cat.color}">${icon(iconOf(zone), { filled: true })}</span>`;
}

const FRIEND_COLORS = ["#7650b8", "#c35a2a", "#2c8752", "#b8456d", "#1b827c", "#3a6cc2"];
function personColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FRIEND_COLORS[h % FRIEND_COLORS.length];
}
const initial = (name) => (name.trim()[0] || "?").toUpperCase();

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  return Math.abs(a) < 1e-6 ? poly[0] : [cx / (3 * a), cy / (3 * a)];
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** The named room a position is inside, if any. */
function zoneAt(pos) {
  if (!pos || !nav) return null;
  return Object.values(nav.zones).find((z) =>
    String(z.floor) === String(pos.floor) && z.kind !== "staff" && !z.noLabel &&
    !AMENITY_KINDS.has(z.kind) && inPoly(pos.x, pos.y, z.poly)) || null;
}

/* ================================================================ boot */
async function boot() {
  hydrateIcons();
  speaker = new Speaker($("announcer"));
  bus = new Bus();
  social = new Social(CFG);

  const p = prefs.get();
  $("nameInput").value = p.name || "";
  state.lastDeviceId = p.deviceId || ""; // preselect hint only - user still confirms
  state.mode = p.mode === "gps" ? "gps" : "esp";
  state.myFloor = String(p.myFloor || "1"); // checked against the model once it loads
  applyStartupSettings();
  $("blindToggle").checked = settings.get("lowVision");
  $("accessibleToggle").checked = settings.get("accessible");
  if (!social.enabled) {
    $("friendsSection").hidden = true;
    $("soloNote").hidden = false;
  }

  await loadLibraryCatalog(p.libraryId);

  // Three steps: 0) library, 1) name and options -> connect, 2) sensor or GPS only
  state.obStep = 0;
  $("welcomeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("startBtn");
    if (state.obStep === 0) {
      if (!state.library) return;
      btn.disabled = true;
      btn.textContent = "Loading map...";
      try {
        await openLibrary(state.library);
        setOnboardingStep(1);
      } catch (err) {
        toast(`Couldn't load that library: ${err.message}`, "error");
        btn.textContent = "Continue";
      }
      btn.disabled = false;
    } else if (state.obStep === 1) {
      btn.disabled = true;
      btn.textContent = "Connecting...";
      try {
        await startCore({
          name: $("nameInput").value.trim() || "Visitor",
          blind: $("blindToggle").checked,
          accessible: $("accessibleToggle").checked,
        });
        setOnboardingStep(2);
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

function setOnboardingStep(n) {
  state.obStep = n;
  $("stepLibrary").hidden = n !== 0;
  $("stepProfile").hidden = n !== 1;
  $("stepDevice").hidden = n !== 2;
  document.querySelectorAll(".ob-steps i").forEach((dot, i) => dot.classList.toggle("on", i === n));
  const btn = $("startBtn");
  btn.textContent = n === 2 ? "Start" : "Continue";
  btn.disabled = n === 2 && state.mode === "esp" && !state.deviceId;
  if (n === 1) setTimeout(() => $("nameInput").focus(), 50);
}

/* ------------------------------------------------------ library choice */
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
    const row = el(`<button type="button" class="option ${lib.available ? "" : "disabled"} ${selected ? "selected" : ""}"
        role="option" aria-selected="${selected}" ${lib.available ? "" : "aria-disabled=\"true\""}>
      <span class="opt-icon">${icon("local_library")}</span>
      <span class="opt-text"><b>${esc(lib.name)}</b><span class="sub">${esc(lib.location || "")}</span></span>
      ${lib.available ? `<span class="opt-check">${icon("check")}</span>` : '<span class="opt-tag">Soon</span>'}
    </button>`);
    if (lib.available) {
      row.addEventListener("click", () => {
        state.library = lib;
        renderLibraryList();
      });
    }
    box.appendChild(row);
  }
  $("startBtn").disabled = !state.library;
}

/** Load the chosen library's map model and build the 3D scene. */
async function openLibrary(lib) {
  model = await (await fetch(lib.model, { cache: "no-cache" })).json();
  scene = new MapScene($("scene"), model, sceneOptions());
  nav = new Navigator(model);
  nav.formatDistance = (m) => fmtDist(m, { long: true });
  applyPace();
  buildLevels();
  state.geo = null;
  state.smoother.reset();
  $("homeTitle").textContent = lib.name;
  prefs.set({ libraryId: lib.id });
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

/* ------------------------------------------------- sensor discovery */
function renderDeviceList() {
  const box = $("deviceList");
  if ($("stepDevice").hidden) return;
  const devices = (state.directory?.devices || [])
    .filter((d) => d.role === "user" && (d.site || "main") === state.library.id)
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    .slice(0, CFG.maxDevices);

  if (!devices.length) {
    box.innerHTML =
      `<div class="empty"><span class="spinner"></span>` +
      `Looking for sensors. Make sure yours is switched on.</div>`;
    return;
  }

  box.innerHTML = "";
  for (const d of devices) {
    const takenByOther = d.pairedBy && d.pairedBy !== state.uid;
    const usable = d.online && !takenByOther;
    const status = takenByOther ? "In use" : d.online ? "Available" : "Offline";
    const bars = d.rssi == null ? 0 : d.rssi > -55 ? 4 : d.rssi > -65 ? 3 : d.rssi > -75 ? 2 : 1;
    const selected = state.deviceId === d.id;
    const row = el(`<button type="button" class="option ${usable ? "" : "disabled"} ${selected ? "selected" : ""}"
        role="option" aria-selected="${selected}">
      <span class="sig" title="${d.rssi != null ? d.rssi + " dBm" : "no signal"}">
        ${[1, 2, 3, 4].map((i) => `<i class="${i <= bars ? "on" : ""}"></i>`).join("")}</span>
      <span class="opt-text"><b>${esc(d.id)}</b></span>
      <span class="dev-status">${status}</span>
      <span class="opt-check">${icon("check")}</span>
    </button>`);
    if (usable) {
      row.addEventListener("click", () => {
        state.deviceId = d.id;
        $("startBtn").disabled = false;
        renderDeviceList();
      });
    }
    box.appendChild(row);
  }
}

/* ----------------------------------------------------------- connect */
async function startCore(opts) {
  Object.assign(state, opts);
  settings.set("lowVision", !!opts.blind);
  settings.set("accessible", !!opts.accessible);

  // ---- identity
  let extraKeywords = [];
  if (social.enabled) {
    state.uid = await social.signIn(state.name);
    extraKeywords = await social.loadKeywords().catch(() => []);
    social.addEventListener("friends-changed", refreshFriends);
  } else {
    state.uid = prefs.get().uid || crypto.randomUUID();
    prefs.set({ ...opts, uid: state.uid });
  }
  intent = new IntentEngine(model, extraKeywords);
  buildChips();
  reflectAvatar();

  // ---- voice
  applyVoice();
  speaker.enabled = settings.get("voice");
  reflectVoiceButton();
  guidance = new Guidance(speaker, { blindMode: state.blind, onReroute: reroute });
  guidance.autoReroute = settings.get("reroute");
  guidance.vibrate = settings.get("vibrate");
  guidance.progressUpdates = settings.get("progressUpdates");
  guidance.formatDistance = (m) => fmtDist(m, { long: true });
  listener = new Listener(
    (text) => { $("searchInput").value = text; submitSearch(text, { spoken: true }); },
    (on) => document.body.classList.toggle("listening", on)
  );
  reflectMic();

  // ---- connectivity
  bus.connect(CFG, state.uid);
  bus.addEventListener("status", (e) => updateMqttDot(e.detail.state));
  bus.addEventListener("latency", (e) => {
    state.latencyMs = e.detail.ms;
    updateMqttDot(state.mqtt);
  });
  bus.client.on("connect", () => {
    publishPairing(); // re-assert (or clear) the claim on every (re)connect
    publishFloor();
    const anchors = savedAnchors();
    if (anchors) bus.publish(anchorsTopic(), anchors, { retain: true, qos: 1 });
  });

  bus.on(`libnav/user/${state.uid}/pos`, (t, payload) => onSelfPos(JSON.parse(payload)));
  bus.on(`libnav/user/${state.uid}/control`, (t, payload) => onControl(JSON.parse(payload)));
  bus.on("libnav/engine/status", (t, payload) => {
    const was = state.engineOnline;
    state.engineOnline = payload.toString() === "online";
    // only the sensor mode depends on the server; GPS-only works without it
    if (!state.engineOnline && was !== false && state.mode === "esp" && $("welcomeModal").hidden) {
      toast("The position server is offline, so your floor can't be detected right now.", "warn");
    }
  });
  // live sensor discovery feed (drives the pairing picker)
  bus.on("libnav/directory", (t, payload) => {
    try {
      state.directory = JSON.parse(payload);
      renderDeviceList();
    } catch { /* ignore malformed */ }
  });
  // live occupancy (retained, so it fills in on connect)
  bus.on("libnav/capacity", (t, payload) => {
    try { updateCapacityPill(capacityForLibrary(JSON.parse(payload))); } catch { /* ignore */ }
  });
  // telemetry of whichever unit is currently paired
  bus.on("libnav/dev/+/telemetry", (t, payload) => {
    if (!state.deviceId || t.split("/")[2] !== state.deviceId) return;
    const d = JSON.parse(payload);
    state.sensorLastSeen = Date.now();
    state.sensorRssi = d.rssi;
  });

  // ---- GPS
  gps = new GpsPublisher(bus, state.uid, CFG.gpsPublishHz, state.library.id);
  gps.addEventListener("fix", (e) => {
    state.gpsAcc = e.detail.acc;
    updateGpsDot(e.detail.acc);
    showLocalGps(e.detail); // move the dot as you walk, engine or not
  });
  gps.addEventListener("error", (e) => {
    updateGpsDot(null);
    toast(e.detail ? `GPS: ${e.detail}` : "Couldn't get a GPS position.", "warn");
  });
  gps.start();

  setInterval(updateSensorDot, 2000);
  wireUi();
  await refreshFriends();
}

/** Called once the user has explicitly chosen a mode (and sensor, if any). */
function finalizeStart() {
  prefs.set({
    name: state.name, deviceId: state.deviceId || "", mode: state.mode, myFloor: state.myFloor,
    libraryId: state.library.id,
  });
  publishPairing();
  publishFloor();
  if (social.enabled && state.deviceId) {
    social.registerDevice(state.deviceId).catch(() => {});
  }
  $("welcomeModal").hidden = true;

  const gpsOnly = state.mode === "gps";
  $("myFloorWrap").hidden = !gpsOnly;
  if (gpsOnly) $("myFloorSel").value = state.myFloor;
  focusFloor(gpsOnly ? state.myFloor : String(startPoint().floor));
  showView("home");
  addEventListener("resize", updateLayout);
  updateSensorDot();

  if (!gpsOnly && state.engineOnline === false) {
    toast("The position server is offline, so your floor can't be detected right now.", "warn");
  } else {
    toast(`Hi ${state.name}. Search for a subject or a room to get started.`, "ok");
  }
  speaker.speak(
    `Hi ${state.name}. ` +
    (gpsOnly ? `Using your phone's GPS. Floor ${state.myFloor}. ` : `Sensor ${state.deviceId} paired. `) +
    (state.blind ? "Directions will be read aloud. Say or type where you want to go." : "")
  , { interrupt: true });
}

/** Retained claim: {device} to pair, empty payload to release. */
function publishPairing() {
  if (!state.uid) return;
  const topic = `libnav/user/${state.uid}/pair`;
  if (state.deviceId) {
    bus.publish(topic, { device: state.deviceId, lib: state.library.id }, { retain: true, qos: 1 });
  } else {
    bus.publish(topic, "", { retain: true, qos: 1 });
  }
}

/** Retained manual floor for GPS-only mode; empty = sensor decides. */
function publishFloor() {
  if (!state.uid) return;
  const topic = `libnav/user/${state.uid}/floor`;
  if (state.mode === "gps") {
    bus.publish(topic, { floor: +state.myFloor, lib: state.library.id }, { retain: true, qos: 1 });
  } else {
    bus.publish(topic, "", { retain: true, qos: 1 });
  }
}

/* ============================================================ floors */
function buildLevels() {
  const box = $("levels");
  box.innerHTML = "";
  box.appendChild(el(`<button type="button" data-floor="all" title="All floors" aria-label="All floors">${icon("layers")}</button>`));
  for (const l of [...levels()].reverse()) {
    box.appendChild(el(`<button type="button" data-floor="${l}" aria-label="Floor ${l}">${l}</button>`));
  }
  $("myFloorSel").innerHTML = levels().map((l) => `<option value="${l}">Floor ${l}</option>`).join("");
  if (!levels().includes(state.myFloor)) state.myFloor = levels()[0];
}

function focusFloor(level) {
  level = String(level);
  // the flat view shows one floor at a time
  if (level === "all" && settings.get("mapView") === "2d") level = currentFloor();
  // the whole stack is only readable with the floors pulled apart
  if ((level === "all") !== scene.exploded) scene.setExploded(level === "all");
  state.focus = level;
  scene.setFloorFocus(level);
  reflectLevels();
  if (state.view === "home") renderHome();
}

function reflectLevels() {
  const here = state.pos ? String(state.pos.floor) : state.mode === "gps" ? state.myFloor : null;
  const flat = settings.get("mapView") === "2d";
  $("levels").querySelectorAll("button").forEach((b) => {
    b.hidden = flat && b.dataset.floor === "all";
    b.classList.toggle("active", b.dataset.floor === state.focus);
    b.classList.toggle("here", b.dataset.floor === here);
  });
}

/* ============================================================ sheet */
function showView(name, { open } = {}) {
  state.view = name;
  for (const v of ["home", "results", "place", "route"]) {
    $(`view${cap(v)}`).hidden = v !== name;
  }
  if (open !== undefined) setSheet(open ? "open" : "peek");
  if (name === "home") renderHome();
  $("sheetBody").scrollTop = 0;
  updateLayout();
}

/** How much of the sheet shows when collapsed, and the map area the panels leave free. */
function updateLayout() {
  const wide = matchMedia("(min-width: 900px)").matches;
  let peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 150;
  if (!wide) {
    const anchors = { home: ".status-row", place: ".place-actions", route: ".route-head" };
    const view = $(`view${cap(state.view)}`);
    let anchor = anchors[state.view] && view.querySelector(anchors[state.view]);
    if (state.view === "route" && !$("routeVia").hidden) anchor = $("routeVia");
    if (anchor && anchor.offsetHeight) peek = anchor.offsetTop + anchor.offsetHeight + 16;
  }
  document.documentElement.style.setProperty("--peek", `${wide ? 0 : Math.round(peek)}px`);
  if (!scene || !$("welcomeModal").hidden) return;
  const navigating = document.body.classList.contains("navigating");
  const topEl = navigating && !wide ? $("navBanner") : $("top");
  scene.setViewPadding({
    top: wide ? 0 : topEl.getBoundingClientRect().bottom + 6,
    bottom: wide ? 0 : peek,
    left: wide ? 432 : 0,
  });
}

function setSheet(s) {
  $("sheet").dataset.state = s;
}

/** Drag the sheet up and down on phones; a tap on the handle toggles it. */
function wireSheetDrag() {
  const sheet = $("sheet");
  let startY = null, startOffset = 0, dy = 0;
  const peekPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 150;
  const offsetFor = (s) => (s === "open" ? 0 : sheet.offsetHeight - peekPx());
  const down = (e) => {
    if (matchMedia("(min-width: 900px)").matches) return;
    if (e.target.closest("button, input, select, a") && e.currentTarget !== $("sheetHandle")) return;
    startY = e.clientY;
    dy = 0;
    startOffset = offsetFor(sheet.dataset.state);
    sheet.classList.add("dragging");
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (startY === null) return;
    dy = e.clientY - startY;
    const off = Math.max(0, Math.min(offsetFor("peek"), startOffset + dy));
    sheet.style.transform = `translateY(${off}px)`;
  };
  const up = () => {
    if (startY === null) return;
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    if (Math.abs(dy) < 6) setSheet(sheet.dataset.state === "open" ? "peek" : "open");
    else setSheet(dy < 0 ? "open" : "peek");
    startY = null;
  };
  for (const target of [$("sheetHandle"), ...document.querySelectorAll(".home-head, .place-head, .route-head")]) {
    target.addEventListener("pointerdown", down);
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }
  $("sheetHandle").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSheet(sheet.dataset.state === "open" ? "peek" : "open");
    }
  });
}

/* ------------------------------------------------------------ home */
function renderHome() {
  if (!nav) return;
  renderHomeSub();
  const floor = state.focus !== "all" ? state.focus : currentFloor();
  $("placeListTitle").textContent = `On floor ${floor}`;
  const zones = Object.values(nav.zones)
    .filter((z) => String(z.floor) === floor && z.kind !== "staff" && !z.noLabel)
    .sort((a, b) => (AMENITY_KINDS.has(a.kind) - AMENITY_KINDS.has(b.kind)) || a.name.localeCompare(b.name));
  const box = $("placeList");
  box.innerHTML = "";
  for (const z of zones) box.appendChild(placeRow(z));
}

function renderHomeSub() {
  const p = state.pos;
  let text;
  if (p) {
    const room = zoneAt(p);
    text = `You're on floor ${p.floor}` + (room ? `, in ${room.name}` : "");
  } else if (!$("awayNotice").hidden) {
    text = "You're not at the library right now.";
  } else if (state.mode === "gps") {
    text = "Your dot shows up once your phone has a GPS fix.";
  } else {
    text = "Finding where you are...";
  }
  $("homeSub").textContent = text;
}

function placeRow(zone, { note = "", sub = "", recent = false } = {}) {
  const dist = distanceText(zone);
  const row = el(`<button type="button" class="row">
    ${recent ? `<span class="badge-icon muted">${icon("history")}</span>` : badge(zone)}
    <span class="row-text">
      <span class="row-title">${esc(zone.name)}</span>
      <span class="row-sub">${esc(sub || `${categoryOf(zone).label} · Floor ${zone.floor}`)}</span>
    </span>
    ${dist ? `<span class="row-meta">${dist}</span>` : ""}
  </button>`);
  row.addEventListener("click", () => openPlace(zone, { note }));
  return row;
}

function distanceText(zone) {
  if (!state.pos || String(state.pos.floor) !== String(zone.floor)) return "";
  const [cx, cy] = centroid(zone.poly);
  return fmtDist(Math.hypot(cx - state.pos.x, cy - state.pos.y));
}

/* ------------------------------------------------------------ chips */
function buildChips() {
  const box = $("chips");
  box.innerHTML = "";
  for (const c of model.site.quickChips || []) {
    const look = lookFor(c.q);
    const chip = el(`<button type="button" class="chip" style="color:${look.color}">
      ${icon(look.icon, { filled: true })}<span style="color:var(--text)">${esc(c.label)}</span></button>`);
    chip.addEventListener("click", () => {
      $("searchInput").value = c.label;
      submitSearch(c.q);
    });
    box.appendChild(chip);
  }
}

/** Icon and colour a search query would lead to, for chips. */
function lookFor(q) {
  const r = intent.resolve(q);
  const id = r.kind === "zone" ? r.zoneId : r.kind === "nearest" ? r.candidates[0] : null;
  const z = id && nav.zones[id];
  if (!z) return { icon: "search", color: "var(--text-2)" };
  const byIntent = { newspapers: "newspaper" }[r.intent];
  return { icon: byIntent || iconOf(z), color: categoryOf(z).color };
}

/* ============================================================ search */
function onSearchInput() {
  const q = $("searchInput").value.trim();
  $("btnClear").hidden = !q;
  if (!q) {
    if (document.activeElement === $("searchInput") && renderRecent()) {
      if (state.view !== "results") showView("results", { open: true });
    } else if (state.view === "results") {
      showView("home", { open: false });
    }
    return;
  }
  renderResults(q);
  if (state.view !== "results") showView("results", { open: true });
}

function renderResults(q) {
  const lower = q.toLowerCase();
  const box = $("resultList");
  box.innerHTML = "";
  const seen = new Set();
  let count = 0;

  // friends by name
  for (const [fuid, f] of state.friends) {
    if (!f.name.toLowerCase().includes(lower)) continue;
    box.appendChild(friendRow(fuid, f));
    count++;
  }

  // what the search words point at
  for (const s of intent.suggest(q, 6)) {
    const r = intent.resolve(s.term);
    if (r.kind === "zone" && nav.zones[r.zoneId] && !seen.has(r.zoneId)) {
      seen.add(r.zoneId);
      const z = nav.zones[r.zoneId];
      const sub = s.label.toLowerCase() === z.name.toLowerCase() ? "" : `${cap(s.label)} · Floor ${z.floor}`;
      box.appendChild(placeRow(z, { note: r.note, sub }));
      count++;
    } else if (r.kind === "nearest" && !seen.has(`i:${r.intent}`)) {
      seen.add(`i:${r.intent}`);
      const best = nearestOf(r.candidates);
      if (!best) continue;
      const z = nav.zones[best.id];
      box.appendChild(placeRow(z, { note: r.lead, sub: `Closest match for "${s.label}" · Floor ${z.floor}` }));
      count++;
    }
  }

  // rooms by name
  for (const z of Object.values(nav.zones)) {
    if (seen.has(z.id) || z.kind === "staff" || z.noLabel) continue;
    if (!z.name.toLowerCase().includes(lower)) continue;
    seen.add(z.id);
    box.appendChild(placeRow(z));
    if (++count > 12) break;
  }

  if (!count) {
    box.innerHTML = `<div class="empty-state"><b>No matches for "${esc(q)}"</b>${esc(model.site.searchHint || "")}</div>`;
  }
}

function nearestOf(candidates) {
  const start = state.pos || startPoint();
  return nav.nearest({ floor: start.floor, x: start.x, y: start.y }, candidates, routeProfile());
}

/** Run a search: friends first, then the library's search words. */
function submitSearch(text, { spoken = false } = {}) {
  const query = text.trim();
  if (!query) return;
  // hands-free, or the user asked for it: start walking straight away
  const auto = spoken || state.blind || settings.get("autoStart");

  const friendQuery = query.toLowerCase().replace(/^(find|where is|where's|go to|navigate to)\s+/i, "");
  for (const [fuid, f] of state.friends) {
    if (f.name.toLowerCase() === friendQuery) {
      if (auto) goToFriend(fuid); else openFriend(fuid);
      return;
    }
  }

  const res = intent.resolve(query);
  if (res.kind === "zone") {
    const zone = nav.zones[res.zoneId];
    if (auto) {
      speaker.speak(res.reply);
      navigateTo(zone.id);
    } else {
      openPlace(zone, { note: res.note });
    }
  } else if (res.kind === "nearest") {
    const best = nearestOf(res.candidates);
    if (!best) {
      toast("Nothing reachable matched that.", "warn");
      return;
    }
    const zone = nav.zones[best.id];
    if (auto) {
      speaker.speak(`${res.lead} ${zone.name}, floor ${zone.floor}.`);
      navigateTo(zone.id);
    } else {
      openPlace(zone, { note: res.lead });
    }
  } else {
    renderResults(query);
    showView("results", { open: true });
    speaker.speak(res.reply || "Not sure where that is.");
  }
}

function clearSearch() {
  $("searchInput").value = "";
  $("btnClear").hidden = true;
  $("btnBack").hidden = true;
  $("searchLead").hidden = false;
  state.place = null;
  scene.highlightZone(null);
  showView("home", { open: false });
}

/* ------------------------------------------------------------ recent */
const recentKey = () => `libnav.recent.${state.library.id}`;
function recentList() {
  try { return JSON.parse(localStorage.getItem(recentKey()) || "[]"); } catch { return []; }
}
function rememberPlace(zone) {
  if (!settings.get("recent")) return;
  const list = [{ id: zone.id }, ...recentList().filter((r) => r.id !== zone.id)].slice(0, 8);
  try { localStorage.setItem(recentKey(), JSON.stringify(list)); } catch { /* ignore */ }
}
function clearRecent() {
  try { localStorage.removeItem(recentKey()); } catch { /* ignore */ }
}
/** Recent places in the results list; false if there are none to show. */
function renderRecent() {
  const zones = settings.get("recent") ? recentList().map((r) => nav.zones[r.id]).filter(Boolean) : [];
  if (!zones.length) return false;
  const box = $("resultList");
  box.innerHTML = "";
  const head = el(`<div class="list-head"><h3 class="section-title">Recent</h3>
    <button type="button" class="link-btn">Clear</button></div>`);
  head.querySelector("button").addEventListener("click", () => {
    clearRecent();
    showView("home", { open: false });
  });
  box.appendChild(head);
  for (const z of zones) box.appendChild(placeRow(z, { recent: true }));
  return true;
}

/* ------------------------------------------------------------ place */
function placeMeta(zone) {
  const dist = distanceText(zone);
  return [categoryOf(zone).label, `Floor ${zone.floor}`, dist && `${dist} away`].filter(Boolean).join(" · ");
}

function openPlace(zone, { note = "" } = {}) {
  state.place = zone;
  rememberPlace(zone);
  $("searchInput").value = zone.name;
  $("btnClear").hidden = true;
  $("btnBack").hidden = false;
  $("searchLead").hidden = true;
  $("searchInput").blur();

  const cat = categoryOf(zone);
  const staff = zone.kind === "staff";
  $("placeBadge").outerHTML = `<span id="placeBadge" class="badge-icon lg" style="background:${cat.color}">${icon(iconOf(zone), { filled: true })}</span>`;
  $("zoneName").textContent = zone.name;
  $("zoneFloor").textContent = placeMeta(zone);
  $("placeNote").hidden = !note;
  $("placeNote").textContent = note;
  $("zoneDesc").textContent = zone.desc || (staff ? "Staff only, not open to visitors." : "");
  $("zoneDesc").hidden = !$("zoneDesc").textContent;

  // Real photo: an explicit zone.photo, else the drop-in convention
  // web/photos/<ZONE-ID>.jpg. The photo area only shows once one loads.
  const img = $("zonePhotoImg");
  $("placePhoto").hidden = true;
  img.onload = () => { if (state.place === zone) $("placePhoto").hidden = false; };
  img.onerror = () => { $("placePhoto").hidden = true; };
  img.alt = zone.name;
  img.src = zone.photo || `photos/${encodeURIComponent(zone.id)}.jpg`;

  $("zoneGoBtn").hidden = staff;
  $("zoneGoBtn").onclick = () => {
    speaker.speak(`Directions to ${zone.name}.`);
    navigateTo(zone.id);
  };
  $("btnShowOnMap").onclick = () => showZoneOnMap(zone);

  showView("place", { open: false });
  showZoneOnMap(zone);
}

function showZoneOnMap(zone) {
  scene.highlightZone(zone.id);
  if (state.focus !== String(zone.floor)) focusFloor(zone.floor);
  const [x, y] = centroid(zone.poly);
  scene.focusOn({ floor: zone.floor, x, y });
  setSheet("peek");
}

function openFriend(fuid) {
  const f = state.friends.get(fuid);
  if (!f) return;
  state.place = null;
  $("searchInput").value = f.name;
  $("btnBack").hidden = false;
  $("searchLead").hidden = true;
  $("placeBadge").outerHTML = `<span id="placeBadge" class="badge-icon lg person" style="background:${personColor(f.name)}">${esc(initial(f.name))}</span>`;
  $("zoneName").textContent = f.name;
  $("zoneFloor").textContent = f.pos ? `Friend · Floor ${f.pos.floor}` : "Friend · no position right now";
  $("placeNote").hidden = true;
  $("zoneDesc").hidden = true;
  $("placePhoto").hidden = true;
  $("zoneGoBtn").hidden = !f.pos;
  $("zoneGoBtn").onclick = () => goToFriend(fuid);
  $("btnShowOnMap").onclick = () => {
    if (!f.pos) return;
    focusFloor(f.pos.floor);
    scene.focusOn(f.pos);
    setSheet("peek");
  };
  showView("place", { open: false });
  if (f.pos) { focusFloor(f.pos.floor); scene.focusOn(f.pos); }
}

/* ============================================================ positions */
function onSelfPos(p) {
  state.lastFusedAt = Date.now(); // engine is live -> local GPS fallback stands down
  // production mode: even engine-fused positions are hidden when the phone's
  // own GPS says we are outside the library geofence
  if (state.appMode === "production" && gps?.lastFix && !passesGeofence(gps.lastFix)) {
    return;
  }
  hideAwayNotice();
  setPosition(p);
}

/** Shared by engine positions and the phone's own GPS. */
function setPosition(p) {
  const floorChanged = !state.pos || String(state.pos.floor) !== String(p.floor);
  state.pos = p;
  scene.updateMarker(state.uid, p, { self: true });
  if (floorChanged) {
    reflectLevels();
    // follow the dot to its floor unless the user is looking at something else
    if (settings.get("autoFloor") && (state.route || !state.place) && state.focus !== "all") {
      focusFloor(String(p.floor));
    }
  }
  if (state.view === "home") renderHomeSub();

  if (guidance?.active && state.route) {
    const off = Navigator.offRouteDistance(state.route, p);
    const result = guidance.update(p, off);
    if (result === "arrived") endRoute(true);
    else updateRouteProgress(p);
  }
}

/* ---- live GPS position (used when the fusion engine isn't supplying one) --
 * On the deployed page with no engine running, this is what makes your dot
 * appear and move as you walk. It mirrors the engine's lat/lng -> local-metre
 * conversion. Until you calibrate, the frame is auto-anchored to wherever you
 * first stood, so movement still shows even if it isn't yet aligned to the
 * real building. */
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
  const saved = savedAnchors();
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
  const box = $("awayNotice");
  box.querySelector(".away-dist").textContent = fmtFar(distanceM);
  box.querySelector(".away-radius").textContent = fmtDist(radius);
  box.hidden = false;
  if (state.view === "home") renderHomeSub();
}
function hideAwayNotice() {
  const box = $("awayNotice");
  if (!box.hidden) box.hidden = true;
}

/** Switch between test and production modes (the setting does the rest). */
function setAppMode(mode) {
  settings.set("appMode", mode === "production" ? "production" : "test");
}

function onAppModeChanged() {
  state.appMode = settings.get("appMode");
  state.geo = null;            // production/test use different anchoring
  state.smoother.reset();
  hideAwayNotice();
  if (state.appMode === "test") {
    toast("Your dot now shows anywhere.", "ok");
  } else {
    toast("Your dot now only shows at the library.", "ok");
  }
  if (gps?.lastFix) showLocalGps(gps.lastFix);
}

/* Accuracy-weighted low-pass with per-update motion clamp. Turns jittery raw
 * GPS into a stable, smoothly moving marker; a single wild fix can't yank it
 * across the building. Works in local metres, so it is reset whenever the geo
 * frame changes (new library / recalibration). */
function makeGpsSmoother() {
  let sx = null, sy = null, st = 0;
  return {
    strength: 1, // above 1 follows new fixes faster, below 1 moves more calmly
    reset() { sx = null; sy = null; st = 0; },
    update(x, y, acc, now) {
      if (sx === null) { sx = x; sy = y; st = now; return [x, y]; }
      const dt = Math.max(0.05, (now - st) / 1000);
      st = now;
      const base = Math.min(0.6, Math.max(0.12, 15 / (acc + 15))); // trust good fixes more
      const gain = Math.min(0.95, Math.max(0.05, base * this.strength));
      let nx = sx + gain * (x - sx);
      let ny = sy + gain * (y - sy);
      // cap correction to a plausible walking envelope for this interval
      const maxStep = (2.0 * dt + acc * 0.15) * this.strength;
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

  const firstFix = !state.geo;
  const toLocal = ensureGeo(fix);
  if (firstFix && state.appMode === "test" && !savedAnchors()) {
    toast("Test mode: your dot isn't lined up with the building yet. You can calibrate it in Settings.", "ok");
  }
  const W = model.site.width, D = model.site.depth;
  let [x, y] = toLocal(fix.lat, fix.lng);
  [x, y] = state.smoother.update(x, y, fix.acc ?? 30, Date.now());
  x = Math.max(-8, Math.min(W + 8, x));
  y = Math.max(-8, Math.min(D + 8, y));

  const floor = state.mode === "gps"
    ? state.myFloor
    : String(state.pos?.floor || state.myFloor || levels()[0]);

  // snap onto corridors once the map is calibrated (skip while auto-anchored,
  // where the frame isn't yet aligned to the building)
  if (savedAnchors() && settings.get("snapToPaths")) [x, y] = snapToGraph(floor, x, y);

  setPosition({ x, y, floor: Number(floor), q: { gpsAcc: fix.acc, mode: "local-gps" } });
}

function onControl(msg) {
  if (msg.action === "reject") {
    const first = state.admitted;
    state.admitted = false;
    state.lastRejectAt = Date.now();
    if (msg.active) {
      $("capacityText").textContent =
        `${msg.active} of ${msg.max || CFG.maxDevices} sensors are in use. ` +
        "You're in the queue and will connect as soon as one frees up.";
    }
    $("capacityOverlay").hidden = false;
    if (first) speaker.speak("All sensors are in use. You're in the queue.");
  } else if (msg.action === "admit") {
    if (!state.admitted) toast("You're connected", "ok");
    state.admitted = true;
    $("capacityOverlay").hidden = true;
  } else if (msg.action === "pair_ok") {
    toast(`Sensor ${msg.device} is paired`, "ok");
  } else if (msg.action === "pair_denied") {
    const why = msg.reason === "in-use"
      ? `${msg.device} is already being used by someone else`
      : msg.reason === "other-library"
        ? `${msg.device} belongs to a different library`
        : `${msg.device} can't be paired (${msg.reason})`;
    state.deviceId = "";
    publishPairing();
    toast(why, "warn");
    speaker.speak(`Pairing didn't work. ${why}. Please pick another sensor.`);
    // reopen the picker so the user chooses a different unit (or GPS only)
    $("welcomeModal").hidden = false;
    setOnboardingStep(2);
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
    toast("You're connected", "ok");
  }
}, 3000);

/* ============================================================ navigation */
function navigateTo(target) {
  const start = state.pos
    ? { floor: state.pos.floor, x: state.pos.x, y: state.pos.y }
    : startPoint();
  const route = nav.route(start, target, routeProfile());
  if (!route) {
    toast("Couldn't find a way there.", "warn");
    return;
  }
  state.route = route;
  state.routeTarget = target;
  scene.showPath(route.points);
  scene.highlightZone(typeof target === "string" ? target : null);
  const startFloor = String(route.points[0].floor);
  if (state.focus !== "all" && state.focus !== startFloor) focusFloor(startFloor);
  scene.focusOn(route.points[0]);

  document.body.classList.add("navigating");
  guidance.start(route);
  renderRoute();
  showView("route", { open: false });
  updateRouteProgress(state.pos);
  updateLayout();
}

const VIA_ICON = { stairs: "stairs", elevator: "elevator", escalator: "escalator" };
function stepIcon(ins) {
  if (ins.type === "arrive") return "flag";
  if (ins.type === "floor") return VIA_ICON[ins.kind] || "stairs";
  if (/left/.test(ins.text)) return "turn_left";
  if (/right/.test(ins.text)) return "turn_right";
  return "straight";
}

function renderRoute() {
  const r = state.route;
  if (!r) return;
  const mins = Math.max(1, Math.round(r.etaS / 60));
  $("routeTime").textContent = `${mins} min`;
  $("routeDist").textContent = `(${fmtDist(r.totalM)})`;
  $("routeDest").textContent = state.pos
    ? `To ${r.targetName}`
    : `From ${startPoint().label || "the entrance"} to ${r.targetName}`;

  const crossesFloors = r.points.some((p, i) => i && p.floor !== r.points[i - 1].floor);
  const profile = routeProfile();
  const via = $("routeVia");
  via.hidden = !crossesFloors;
  via.disabled = state.accessible || !canSwitchStairs();
  via.innerHTML = `${icon(profile === "elevator" ? "elevator" : "stairs")}` +
    `<span>Via the ${esc((model.site.cores?.[profile] || profile).toLowerCase())}</span>` +
    (via.disabled ? "" : `<span class="change">Change</span>`);

  const list = $("stepList");
  list.innerHTML = "";
  r.instructions.forEach((ins, i) => {
    list.appendChild(el(`<li data-i="${i}">${icon(stepIcon(ins))}<span class="step-text">${esc(ins.text)}</span></li>`));
  });
}

/** Refresh remaining distance, the step list and the banner for a new position. */
function updateRouteProgress(pos) {
  const r = state.route;
  if (!r) return;
  const pending = r.instructions.filter((ins) => !guidance.spoken.has(ins));
  const current = pending[0] || r.instructions[r.instructions.length - 1];

  $("stepList").querySelectorAll("li").forEach((li) => {
    const ins = r.instructions[+li.dataset.i];
    li.classList.toggle("done", guidance.spoken.has(ins));
    li.classList.toggle("next", ins === current);
  });

  let remaining = r.totalM;
  if (pos) {
    const last = r.points[r.points.length - 1];
    if (String(last.floor) === String(pos.floor)) {
      remaining = Math.round(Math.hypot(last.x - pos.x, last.y - pos.y));
    }
  }
  $("routeDist").textContent = `(${fmtDist(remaining)})`;

  $("nbIcon").innerHTML = icon(stepIcon(current));
  const main = current.type === "turn" ? current.short : current.text;
  let sub = "";
  if (pos && current.point && current.type !== "arrive" &&
      String(current.point.floor) === String(pos.floor)) {
    const d = Math.hypot(current.point.x - pos.x, current.point.y - pos.y);
    sub = current.type === "turn" ? `In ${fmtDist(d)}` : `${fmtDist(d)} ahead`;
  }
  const next = pending[1];
  if (next) sub = [sub, `then ${lowerFirst(next.short || next.text)}`].filter(Boolean).join(", ");
  else if (current.type !== "arrive") sub = sub || `Toward ${r.targetName}`;
  $("nbMain").textContent = main;
  $("nbSub").textContent = cap(sub);
  $("navBanner").hidden = false;
}

/** Swap between the two staircases, then re-route. */
function toggleStairPref() {
  if (state.accessible) {
    toast("Avoid stairs is on, so routes use the elevator.", "warn");
    return;
  }
  if (!canSwitchStairs()) return;
  const next = routeProfile() === "central" ? "west" : "central";
  const label = `the ${(model.site.cores?.[next] || next).toLowerCase()}`;
  toast(`Now going via ${label}`, "ok");
  speaker.speak(`Now going via ${label}.`);
  settings.set("stairPref", next); // re-routes
}

function reroute() {
  if (state.routeTarget) navigateTo(state.routeTarget);
}

function endRoute(arrived = false) {
  const name = state.route?.targetName;
  guidance.stop(arrived);
  scene.clearPath();
  scene.highlightZone(null);
  document.body.classList.remove("navigating");
  $("navBanner").hidden = true;
  state.route = null;
  state.routeTarget = null;
  clearSearch();
  if (arrived && name) toast(`You've arrived at ${name}`, "ok");
}

function onZoneTap(zoneId) {
  if (state.route) return; // don't pull the route away while walking
  const zone = nav.zones[zoneId];
  if (zone && !zone.noLabel) openPlace(zone);
}

/* ============================================================ friends */
async function refreshFriends() {
  if (!social.enabled) return;
  const { accepted, incoming, outgoing } = await social.listFriends();

  const badgeEl = $("friendBadge");
  badgeEl.hidden = incoming.length === 0;
  badgeEl.textContent = incoming.length;

  const reqBox = $("friendRequests");
  reqBox.innerHTML = "";
  for (const req of incoming) {
    const row = el(`<div class="row">
      <span class="badge-icon person" style="background:${personColor(req.name)}">${esc(initial(req.name))}</span>
      <span class="row-text"><span class="row-title">${esc(req.name)}</span><span class="row-sub">Wants to be friends</span></span>
      <button class="mini ok">Accept</button><button class="mini">Decline</button></div>`);
    const [ok, no] = row.querySelectorAll("button");
    ok.onclick = () => social.respond(req.id, true).then(refreshFriends);
    no.onclick = () => social.respond(req.id, false).then(refreshFriends);
    reqBox.appendChild(row);
  }

  const current = new Set(accepted.map((f) => f.uid));
  // drop markers/subscriptions for removed friends
  for (const [fuid] of state.friends) {
    if (!current.has(fuid)) {
      bus.unsubscribe(`libnav/user/${fuid}/pos`);
      bus.unsubscribe(`libnav/user/${fuid}/presence`);
      scene.removeMarker(fuid);
      state.friends.delete(fuid);
    }
  }
  for (const f of accepted) {
    if (state.friends.has(f.uid)) continue;
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
  state.outgoing = outgoing;
  renderFriendRows();
}

function friendRow(fuid, f, { actions = false } = {}) {
  const where = f.pos ? `Floor ${f.pos.floor}` : f.online ? "No position yet" : "Offline";
  const row = el(`<div class="row">
    <span class="badge-icon person" style="background:${personColor(f.name)}">${esc(initial(f.name))}</span>
    <button type="button" class="row-text" style="text-align:left">
      <span class="row-title">${esc(f.name)}</span><span class="row-sub">${where}</span></button>
    ${actions ? `<button class="mini" ${f.pos ? "" : "disabled"}>Show</button>
      <button class="mini ok" ${f.pos ? "" : "disabled"}>Go</button>` : ""}
  </div>`);
  row.querySelector(".row-text").onclick = () => { closePanels(); openFriend(fuid); };
  if (actions) {
    const [show, go] = row.querySelectorAll(".mini");
    show.onclick = () => {
      closePanels();
      focusFloor(f.pos.floor);
      scene.focusOn(f.pos);
    };
    go.onclick = () => { closePanels(); goToFriend(fuid); };
  }
  return row;
}

function renderFriendRows() {
  const list = $("friendList");
  list.innerHTML = "";
  for (const [fuid, f] of state.friends) list.appendChild(friendRow(fuid, f, { actions: true }));
  for (const o of state.outgoing || []) {
    list.appendChild(el(`<div class="row">
      <span class="badge-icon person" style="background:#b7bec6">${esc(initial(o.name))}</span>
      <span class="row-text"><span class="row-title">${esc(o.name)}</span><span class="row-sub">Request sent</span></span></div>`));
  }
  if (!list.children.length && !$("friendRequests").children.length) {
    list.innerHTML = `<div class="empty-state">No friends yet. Search for someone by the name they use in the app.</div>`;
  }
}

function goToFriend(fuid) {
  const f = state.friends.get(fuid);
  if (!f?.pos) {
    toast(`${f?.name || "That friend"} has no position right now.`, "warn");
    return;
  }
  speaker.speak(`${f.name} is on floor ${f.pos.floor}. Getting directions.`);
  navigateTo({ floor: f.pos.floor, x: f.pos.x, y: f.pos.y, name: f.name });
}

/* ============================================================ panels */
function openProfile() {
  reflectAvatar();
  $("meName").textContent = state.name;
  $("meMode").textContent = (state.mode === "gps" ? "Phone GPS only" : `Sensor ${state.deviceId}`) +
    ` · ${state.library.name}`;
  $("settingsModal").hidden = true;
  $("profilePanel").hidden = false;
}

function openSettings(section = null) {
  $("profilePanel").hidden = true;
  settingsPage.open(section);
}

function closePanels() {
  $("profilePanel").hidden = true;
  $("settingsModal").hidden = true;
}

/* ============================================================ UI wiring */
function wireUi() {
  wireSheetDrag();

  // search
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    submitSearch($("searchInput").value);
  });
  $("searchInput").addEventListener("input", onSearchInput);
  $("searchInput").addEventListener("focus", () => {
    if (state.view !== "place") onSearchInput();
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearSearch();
  });
  $("btnClear").addEventListener("click", () => { clearSearch(); $("searchInput").focus(); });
  $("btnBack").addEventListener("click", clearSearch);
  $("btnClosePlace").addEventListener("click", clearSearch);
  $("btnMic").addEventListener("click", () => listener.toggle());

  // floors and map buttons
  $("levels").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) focusFloor(b.dataset.floor);
  });
  $("btnLocate").addEventListener("click", () => {
    if (!state.pos) {
      toast("No position yet. Waiting for GPS.", "warn");
      return;
    }
    focusFloor(String(state.pos.floor));
    scene.focusOn(state.pos);
  });
  $("btnVoice").addEventListener("click", () => settings.set("voice", !settings.get("voice")));

  $("myFloorSel").addEventListener("change", () => {
    state.myFloor = $("myFloorSel").value;
    publishFloor();
    prefs.set({ myFloor: state.myFloor });
    speaker.speak(`Floor set to ${state.myFloor}.`);
    focusFloor(state.myFloor);
    if (gps?.lastFix) showLocalGps(gps.lastFix); // move the dot to the new floor now
  });

  // route
  $("btnEndRoute").addEventListener("click", () => endRoute(false));
  $("routeVia").addEventListener("click", toggleStairPref);

  // panels
  $("btnProfile").addEventListener("click", openProfile);
  $("btnCloseProfile").addEventListener("click", closePanels);
  settingsPage = new SettingsPage({
    panel: $("settingsModal"), body: $("settingsBody"), title: $("settingsTitle"),
    back: $("btnSettingsBack"), store: settings, sections: settingsSections,
  });
  // voices arrive late in some browsers; refresh the list if it's showing
  speaker.addEventListener("voices", () => { if (!$("settingsModal").hidden) settingsPage.refresh(); });
  $("btnSettings").addEventListener("click", () => openSettings());
  $("btnOpenSettings").addEventListener("click", () => openSettings());
  $("btnCloseSettings").addEventListener("click", closePanels);
  $("btnSwitchLibrary").addEventListener("click", () => location.reload());

  $("friendSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("friendSearchInput").value.trim();
    if (!q) return;
    const results = await social.searchUsers(q);
    const box = $("friendSearchResults");
    box.innerHTML = results.length ? "" : `<div class="empty-state">Nobody by that name.</div>`;
    for (const r of results) {
      const row = el(`<div class="row">
        <span class="badge-icon person" style="background:${personColor(r.display_name)}">${esc(initial(r.display_name))}</span>
        <span class="row-text"><span class="row-title">${esc(r.display_name)}</span></span>
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanels();
  });
}

function reflectVoiceButton() {
  const b = $("btnVoice");
  b.classList.toggle("on", speaker.enabled);
  b.setAttribute("aria-pressed", String(speaker.enabled));
  setIcon(b.querySelector("svg"), speaker.enabled ? "volume_up" : "volume_off");
}

/* ============================================================ settings */
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const isDark = () => {
  const t = settings.get("theme");
  return t === "dark" || (t === "system" && !!darkQuery?.matches);
};
const accentHex = () => (ACCENTS[settings.get("accent")] || ACCENTS.blue).hex;
const uiScale = () => TEXT_SIZES[settings.get("textSize")] || 1;

/** The floor the home list and the flat view fall back to. */
function currentFloor() {
  return String(state.pos?.floor || (state.mode === "gps" ? state.myFloor : startPoint().floor));
}

function sceneOptions() {
  return {
    onZoneClick: onZoneTap,
    dark: isDark(),
    accent: accentHex(),
    uiScale: uiScale(),
    labelMode: settings.get("labels"),
    reduceMotion: settings.get("reduceMotion"),
    viewMode: settings.get("mapView"),
    showAccuracy: settings.get("showAccuracy"),
    showFriends: settings.get("showFriends"),
    floorSpacing: SPACING[settings.get("floorSpacing")] || SPACING.normal,
    quality: settings.get("quality"),
    followSelf: settings.get("followMe"),
  };
}

/** Settings that matter before a library is picked. */
function applyStartupSettings() {
  applyTheme();
  applyAccent();
  applyTextSize();
  document.body.classList.toggle("reduce-motion", settings.get("reduceMotion"));
  document.body.classList.toggle("no-chips", !settings.get("showChips"));
  document.body.classList.toggle("no-status", !settings.get("showStatus"));
  document.body.classList.toggle("blind", settings.get("lowVision"));
  state.blind = settings.get("lowVision");
  state.accessible = settings.get("accessible");
  state.stairPref = settings.get("stairPref") === "west" ? "west" : "central";
  state.appMode = settings.get("appMode") === "production" ? "production" : "test";
  state.smoother.strength = SMOOTHING[settings.get("gpsSmoothing")] || 1;
}

function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1f242b" : "#ffffff");
  scene?.setTheme(dark);
}
darkQuery?.addEventListener?.("change", () => {
  if (settings.get("theme") === "system") applyTheme();
});

function applyAccent() {
  document.documentElement.style.setProperty("--accent", accentHex());
  scene?.setAccent(accentHex());
}

function applyTextSize() {
  document.documentElement.style.setProperty("--ts", uiScale());
  scene?.setUiScale(uiScale());
  updateLayout();
}

function applyVoice() {
  speaker.voiceName = settings.get("voiceName");
  speaker.rate = settings.get("voiceRate");
  speaker.volume = settings.get("voiceVolume");
}

function applyPace() {
  if (nav) nav.walkSpeed = (model.site.walkSpeed || 1.2) * (PACE[settings.get("walkPace")] || 1);
}

function applyUnits() {
  if (state.view === "home") renderHome();
  if (state.view === "place" && state.place) $("zoneFloor").textContent = placeMeta(state.place);
  if (state.gpsAcc != null) updateGpsDot(state.gpsAcc);
  rerouteQuietly(); // step texts carry distances
}

/** Plan the current route again after a setting that changes it. */
function rerouteQuietly() {
  if (state.routeTarget && guidance?.active) navigateTo(state.routeTarget);
}

function reflectMic() {
  $("btnMic").hidden = !settings.get("showMic") || !listener?.available;
}

function avatarColor() {
  const c = settings.get("avatarColor");
  return c && c !== "auto" ? c : personColor(state.name || "?");
}

function reflectAvatar() {
  for (const id of ["avatarInitial", "meAvatar"]) $(id).textContent = initial(state.name || "?");
  $("btnProfile").style.background = avatarColor();
  $("meAvatar").style.background = avatarColor();
}

function applySetting(key, value) {
  switch (key) {
    case "theme": applyTheme(); break;
    case "accent": applyAccent(); break;
    case "textSize": applyTextSize(); break;
    case "reduceMotion":
      document.body.classList.toggle("reduce-motion", value);
      scene?.setReduceMotion(value);
      break;
    case "mapView":
      if (!scene) break;
      scene.setViewMode(value);
      if (value === "2d" && state.focus === "all") focusFloor(currentFloor());
      reflectLevels();
      break;
    case "labels": scene?.setLabelMode(value); break;
    case "followMe": if (scene) scene.followSelf = value; break;
    case "showAccuracy": scene?.setShowAccuracy(value); break;
    case "floorSpacing": scene?.setFloorSpacing(SPACING[value] || SPACING.normal); break;
    case "quality": scene?.setQuality(value); break;
    case "showFriends": scene?.setShowFriends(value); break;
    case "units": applyUnits(); break;
    case "accessible": state.accessible = value; rerouteQuietly(); break;
    case "stairPref": state.stairPref = value; rerouteQuietly(); break;
    case "walkPace": applyPace(); rerouteQuietly(); break;
    case "reroute": if (guidance) guidance.autoReroute = value; break;
    case "vibrate":
      if (guidance) guidance.vibrate = value;
      if (value) navigator.vibrate?.(80); // so you know what it feels like
      break;
    case "voice":
      speaker.enabled = value;
      reflectVoiceButton();
      if (value) speaker.speak("Directions will be read aloud.", { interrupt: true });
      else speaker.stop(); // cut off whatever is being said
      break;
    case "lowVision":
      state.blind = value;
      document.body.classList.toggle("blind", value);
      if (guidance) guidance.blindMode = value;
      if (value) settings.set("voice", true);
      if (social?.enabled && state.uid) social.updateProfile({ blind_mode: value }).catch(() => {});
      updateLayout();
      break;
    case "voiceName": case "voiceRate": case "voiceVolume": applyVoice(); break;
    case "progressUpdates": if (guidance) guidance.progressUpdates = value; break;
    case "showChips":
      document.body.classList.toggle("no-chips", !value);
      updateLayout();
      break;
    case "showMic": reflectMic(); break;
    case "appMode": onAppModeChanged(); break;
    case "gpsSmoothing": state.smoother.strength = SMOOTHING[value] || 1; break;
    case "snapToPaths": if (gps?.lastFix) showLocalGps(gps.lastFix); break;
    case "avatarColor": reflectAvatar(); break;
    case "showStatus":
      document.body.classList.toggle("no-status", !value);
      updateLayout();
      break;
    default: break; // autoFloor, autoStart and recent are read where they're used
  }
}
settings.addEventListener("change", (e) => applySetting(e.detail.key, e.detail.value));

/* ------------------------------------------------------------ units */
function units() {
  const u = settings.get("units");
  return u === "auto" ? (model?.site?.units || "metric") : u;
}

/** "12 m" / "40 ft", or with long: true "12 meters" / "40 feet" for speech. */
function fmtDist(m, { long = false } = {}) {
  if (units() === "imperial") {
    const raw = m * 3.28084;
    const ft = raw < 50 ? Math.max(1, Math.round(raw)) : Math.round(raw / 5) * 5;
    return long ? `${ft} ${ft === 1 ? "foot" : "feet"}` : `${ft} ft`;
  }
  const r = Math.max(1, Math.round(m));
  return long ? `${r} ${r === 1 ? "meter" : "meters"}` : `${r} m`;
}

/** Longer distances, for "you're 3.2 km from the library". */
function fmtFar(m) {
  if (units() === "imperial") return m >= 320 ? `${(m / 1609.34).toFixed(1)} mi` : fmtDist(m);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : fmtDist(m);
}

/* ------------------------------------------------------------ actions */
function askConfirm({ title, text, ok = "OK", danger = true }) {
  return new Promise((resolve) => {
    const box = $("confirmDialog");
    const okBtn = $("confirmOk");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? "danger" : "primary"}`;
    box.querySelector(".dialog-icon").hidden = !danger;
    box.hidden = false;
    const done = (answer) => {
      box.hidden = true;
      okBtn.onclick = null;
      $("confirmCancel").onclick = null;
      resolve(answer);
    };
    okBtn.onclick = () => done(true);
    $("confirmCancel").onclick = () => done(false);
    okBtn.focus();
  });
}

async function renameMe(name) {
  name = name.trim();
  if (name === state.name) return;
  if (name.length < 2) {
    toast("A name needs at least 2 characters.", "warn");
    settingsPage.refresh();
    return;
  }
  if (social.enabled) {
    try {
      await social.updateProfile({ display_name: name });
    } catch (err) {
      toast(err.message, "warn");
      settingsPage.refresh();
      return;
    }
  }
  state.name = name;
  prefs.set({ name });
  $("nameInput").value = name;
  $("meName").textContent = name;
  reflectAvatar();
  toast("Name updated", "ok");
  settingsPage.refresh();
}

/** Go back to the "How should we find you?" step. */
function changePositioning() {
  closePanels();
  $("welcomeModal").hidden = false;
  setOnboardingStep(2);
  setPositionMode(state.mode);
  renderDeviceList();
}

function testVoice() {
  applyVoice();
  speaker.speak(`This is how directions will sound. In ${fmtDist(20, { long: true })}, turn left.`,
    { interrupt: true, force: true });
}

async function resetSettings() {
  const ok = await askConfirm({
    title: "Reset all settings?",
    text: "Everything in Settings goes back to how it started. Your name and the map calibration stay.",
    ok: "Reset", danger: false,
  });
  if (!ok) return;
  settings.reset();
  toast("Settings reset", "ok");
}

async function resetCalibration() {
  const ok = await askConfirm({
    title: "Reset the calibration?",
    text: "The map goes back to the position stored for this library.",
    ok: "Reset", danger: false,
  });
  if (!ok) return;
  try {
    localStorage.removeItem(anchorsKey());
    if (state.library.id === "main") localStorage.removeItem("libnav.anchors");
  } catch { /* ignore */ }
  const { origin, xAxis } = model.site.geoAnchors;
  bus.publish(anchorsTopic(), { origin, xAxis }, { retain: true, qos: 1 });
  state.geo = null;
  state.smoother.reset();
  if (gps?.lastFix) showLocalGps(gps.lastFix);
  toast("Calibration reset", "ok");
  settingsPage.refresh();
}

async function forgetMe() {
  const ok = await askConfirm({
    title: "Forget me on this device?",
    text: "Your name, settings, calibration and recent places are removed from this browser, and your sensor is released.",
    ok: "Forget me",
  });
  if (!ok) return;
  state.deviceId = "";
  publishPairing();
  if (social.enabled) await social.signOut().catch(() => {});
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("libnav.")).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
  setTimeout(() => location.reload(), 400);
}

/* ------------------------------------------------------------ custom rows */
function positioningRow() {
  const how = state.mode === "gps"
    ? "Just your phone. You set the floor yourself."
    : `Sensor ${state.deviceId} and your phone's GPS`;
  const row = el(`<div class="set-row">
    <span class="set-text"><b>How we find you</b><span class="sub">${esc(how)}</span></span>
    <button type="button" class="btn tonal small">Change</button></div>`);
  row.querySelector("button").addEventListener("click", changePositioning);
  return row;
}

function calibrationForm() {
  const a = savedAnchors() || model.site.geoAnchors;
  const box = el(`<div class="set-row stack calib">
    <p class="sub">Tie two corners of the building to GPS. Stand at each corner and tap
      "Use my location", or paste coordinates from Google Maps.</p>
    <fieldset class="coords"><legend>North-west corner</legend>
      <div class="field-row">
        <input data-f="oLat" type="number" step="any" placeholder="Latitude" aria-label="North-west latitude" />
        <input data-f="oLng" type="number" step="any" placeholder="Longitude" aria-label="North-west longitude" />
      </div>
      <button type="button" data-here="o" class="btn text small">${icon("my_location")}Use my location</button>
    </fieldset>
    <fieldset class="coords"><legend>North-east corner, ${esc(fmtDist(model.site.width))} along the top edge</legend>
      <div class="field-row">
        <input data-f="xLat" type="number" step="any" placeholder="Latitude" aria-label="North-east latitude" />
        <input data-f="xLng" type="number" step="any" placeholder="Longitude" aria-label="North-east longitude" />
      </div>
      <button type="button" data-here="x" class="btn text small">${icon("my_location")}Use my location</button>
    </fieldset>
    <button type="button" data-save class="btn primary block">Save calibration</button>
  </div>`);
  const f = (k) => box.querySelector(`[data-f="${k}"]`);
  f("oLat").value = a.origin.lat; f("oLng").value = a.origin.lng;
  f("xLat").value = a.xAxis.lat; f("xLng").value = a.xAxis.lng;
  box.querySelectorAll("[data-here]").forEach((b) => b.addEventListener("click", () => {
    const fix = gps?.lastFix;
    if (!fix) { toast("No GPS fix yet", "warn"); return; }
    f(`${b.dataset.here}Lat`).value = fix.lat.toFixed(7);
    f(`${b.dataset.here}Lng`).value = fix.lng.toFixed(7);
  }));
  box.querySelector("[data-save]").addEventListener("click", () => {
    const v = ["oLat", "oLng", "xLat", "xLng"].map((k) => parseFloat(f(k).value));
    if (v.some((n) => !Number.isFinite(n))) {
      toast("Fill in all four numbers first.", "warn");
      return;
    }
    const anchors = { origin: { lat: v[0], lng: v[1] }, xAxis: { lat: v[2], lng: v[3] } };
    try { localStorage.setItem(anchorsKey(), JSON.stringify(anchors)); } catch { /* ignore */ }
    bus.publish(anchorsTopic(), anchors, { retain: true, qos: 1 });
    state.geo = null; // rebuild the local converter from the new calibration
    state.smoother.reset();
    if (gps?.lastFix) showLocalGps(gps.lastFix);
    toast("Calibration saved", "ok");
    settingsPage.back();
  });
  return box;
}

/* ------------------------------------------------------------ sections */
const labelOf = (options, value) => options.find((o) => o.value === value)?.label || "";

const THEME_OPTS = [
  { value: "system", label: "Automatic" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" },
];
const TEXT_OPTS = [
  { value: "s", label: "Small" }, { value: "m", label: "Default" },
  { value: "l", label: "Large" }, { value: "xl", label: "Larger" },
];
const VIEW_OPTS = [{ value: "3d", label: "3D" }, { value: "2d", label: "Flat" }];
const LABEL_OPTS = [
  { value: "names", label: "Names" }, { value: "icons", label: "Icons only" }, { value: "off", label: "Off" },
];
const SPACING_OPTS = [
  { value: "close", label: "Close" }, { value: "normal", label: "Normal" }, { value: "wide", label: "Wide" },
];
const UNIT_OPTS = [
  { value: "auto", label: "Automatic" }, { value: "metric", label: "Meters" }, { value: "imperial", label: "Feet" },
];
const QUALITY_OPTS = [
  { value: "saver", label: "Battery saver" }, { value: "balanced", label: "Balanced" }, { value: "sharp", label: "Sharp" },
];
const PACE_OPTS = [{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }];
const SMOOTH_OPTS = [
  { value: "responsive", label: "Responsive" }, { value: "balanced", label: "Balanced" }, { value: "steady", label: "Steady" },
];

function settingsSections() {
  const get = (k) => settings.get(k);
  const coreName = (k) => model?.site?.cores?.[k] || (k === "west" ? "Second stairs" : "Main stairs");
  const radius = fmtDist(model?.site?.geofenceRadius || 200);
  const autoUnits = (model?.site?.units || "metric") === "imperial" ? "feet" : "meters";
  const voiceOptions = () => [
    { value: "", label: "Automatic" },
    ...speaker.voices().map((v) => ({
      value: v.name,
      label: `${v.name.replace(/^(Microsoft|Google)\s+/, "").replace(/\s+-\s+.*$/, "")} (${v.lang})`,
    })),
  ];

  return [
    {
      id: "appearance", group: "Preferences", title: "Appearance", icon: "palette", color: "#7650b8",
      summary: () => `${labelOf(THEME_OPTS, get("theme"))} · ${(ACCENTS[get("accent")] || ACCENTS.blue).label} · ${labelOf(TEXT_OPTS, get("textSize"))} text`,
      items: [
        { type: "choice", key: "theme", label: "Theme", sub: "Automatic follows your phone's light or dark mode.",
          options: THEME_OPTS, keywords: "dark mode night light colours" },
        { type: "swatch", key: "accent", label: "Accent colour", keywords: "color colour highlight",
          options: Object.entries(ACCENTS).map(([value, a]) => ({ value, color: a.hex, label: a.label })) },
        { type: "choice", key: "textSize", label: "Text size", sub: "Also sizes the labels on the map.",
          options: TEXT_OPTS, keywords: "font bigger larger small zoom" },
        { type: "toggle", key: "reduceMotion", label: "Reduce motion",
          sub: "No sliding panels, pulsing dots or gliding camera.", keywords: "animation" },
      ],
    },
    {
      id: "map", group: "Preferences", title: "Map", icon: "map", color: "#2c8752",
      summary: () => `${labelOf(VIEW_OPTS, get("mapView"))} · ${labelOf(LABEL_OPTS, get("labels"))} · ${units() === "imperial" ? "Feet" : "Meters"}`,
      items: [
        { type: "choice", key: "mapView", label: "Map view", sub: "Flat looks straight down at one floor at a time.",
          options: VIEW_OPTS, keywords: "2d 3d top down perspective" },
        { type: "choice", key: "labels", label: "Room labels", options: LABEL_OPTS, keywords: "names icons text" },
        { type: "toggle", key: "followMe", label: "Follow my position", sub: "Keep the map centred on you as you walk." },
        { type: "toggle", key: "showAccuracy", label: "Show GPS accuracy", sub: "The shaded circle around your dot." },
        { type: "toggle", key: "showFriends", label: "Show friends on the map", hidden: () => !social?.enabled },
        { type: "choice", key: "floorSpacing", label: "Space between floors", sub: "In the all-floors view.",
          options: SPACING_OPTS, hidden: () => get("mapView") === "2d" },
        { type: "choice", key: "units", label: "Units", sub: `Automatic uses ${autoUnits} for this library.`,
          options: UNIT_OPTS, keywords: "meters metres feet distance imperial metric" },
        { type: "choice", key: "quality", label: "Graphics", sub: "Battery saver draws fewer frames and pixels.",
          options: QUALITY_OPTS, keywords: "performance battery fps sharp" },
      ],
    },
    {
      id: "directions", group: "Preferences", title: "Directions", icon: "route", color: "#c35a2a",
      summary: () => [
        get("accessible") ? "Avoiding stairs" : `Via the ${coreName(state.stairPref).toLowerCase()}`,
        `${labelOf(PACE_OPTS, get("walkPace"))} pace`,
      ].join(" · "),
      items: [
        { type: "toggle", key: "accessible", label: "Avoid stairs", sub: "Routes take the elevator between floors.",
          keywords: "wheelchair step-free elevator lift stroller" },
        { type: "choice", key: "stairPref", label: "Preferred stairs",
          options: [{ value: "central", label: coreName("central") }, { value: "west", label: coreName("west") }],
          hidden: () => !nav || !canSwitchStairs() || get("accessible") },
        { type: "choice", key: "walkPace", label: "Walking pace", sub: "Changes the time estimates.", options: PACE_OPTS,
          keywords: "speed time eta" },
        { type: "toggle", key: "reroute", label: "Re-route when I go the wrong way",
          sub: `After 5 seconds more than ${fmtDist(15)} off the route.`, keywords: "recalculate" },
        { type: "toggle", key: "autoFloor", label: "Switch floors with me",
          sub: "Show the floor you're on after you take the stairs." },
        { type: "toggle", key: "vibrate", label: "Vibrate at turns", sub: "A short buzz at each turn and floor change.",
          hidden: () => !("vibrate" in navigator), keywords: "haptic buzz" },
      ],
    },
    {
      id: "voice", group: "Preferences", title: "Voice and accessibility", icon: "accessibility_new", color: "#1b827c",
      summary: () => [get("voice") ? "Directions read aloud" : "Voice off", get("lowVision") ? "Low-vision mode" : ""]
        .filter(Boolean).join(" · "),
      items: [
        { type: "toggle", key: "voice", label: "Read directions aloud", hidden: () => !speaker?.supported,
          keywords: "speech speak sound" },
        { type: "toggle", key: "lowVision", label: "Low-vision mode",
          sub: "Larger controls, directions start as soon as you pick a place, and a reminder of the distance left every 20 seconds.",
          keywords: "blind accessibility large" },
        { type: "toggle", key: "progressUpdates", label: "Distance reminders",
          sub: "Say how far is left every 20 seconds.", hidden: () => get("lowVision") },
        { type: "header", label: "Voice", hidden: () => !speaker?.supported },
        { type: "select", key: "voiceName", label: "Voice", options: voiceOptions, hidden: () => !speaker?.supported },
        { type: "range", key: "voiceRate", label: "Speaking speed", min: 0.6, max: 1.6, step: 0.1,
          format: (v) => `${v.toFixed(1)}×`, hidden: () => !speaker?.supported, keywords: "rate fast slow" },
        { type: "range", key: "voiceVolume", label: "Volume", min: 0.2, max: 1, step: 0.1,
          format: (v) => `${Math.round(v * 100)}%`, hidden: () => !speaker?.supported, keywords: "loud quiet" },
        { type: "action", label: "Play a sample", icon: "volume_up", run: testVoice, hidden: () => !speaker?.supported },
      ],
    },
    {
      id: "search", group: "Preferences", title: "Search", icon: "search", color: "#3a6cc2",
      summary: () => (get("autoStart") ? "Starts directions right away" : "Opens a place card first"),
      items: [
        { type: "toggle", key: "autoStart", label: "Start directions right away",
          sub: "Skip the place card after a search.", keywords: "navigate immediately" },
        { type: "toggle", key: "showChips", label: "Quick search buttons", sub: "The row of buttons under the search bar.",
          keywords: "chips shortcuts" },
        { type: "toggle", key: "showMic", label: "Voice search button", hidden: () => !listener?.available,
          keywords: "microphone mic speak" },
        { type: "toggle", key: "recent", label: "Remember recent places", sub: "Shown when you tap the search bar.",
          keywords: "history" },
        { type: "action", label: "Clear recent places", icon: "history",
          run: () => { clearRecent(); toast("Recent places cleared", "ok"); } },
      ],
    },
    {
      id: "location", group: "Preferences", title: "Location", icon: "my_location", color: "#b8456d",
      summary: () => `${state.mode === "gps" ? "Phone only" : `Sensor ${state.deviceId}`} · ${get("appMode") === "production" ? "At the library only" : "Test mode"}`,
      items: [
        { type: "custom", render: positioningRow, label: "How we find you", keywords: "sensor gps positioning change" },
        { type: "choice", key: "appMode", label: "When to show my dot",
          sub: get("appMode") === "production"
            ? `Hidden when you're more than ${radius} from the library.`
            : "Test mode: shows anywhere, handy for trying it out at home.",
          options: [{ value: "test", label: "Anywhere" }, { value: "production", label: "At the library" }],
          keywords: "test production geofence privacy" },
        { type: "choice", key: "gpsSmoothing", label: "GPS smoothing",
          sub: "Steady hides jitter, responsive keeps up faster.", options: SMOOTH_OPTS, keywords: "jitter jumpy" },
        { type: "toggle", key: "snapToPaths", label: "Snap to walkways",
          sub: "Keep your dot on the paths once the map is calibrated.", keywords: "corridor" },
        { type: "header", label: "Map calibration" },
        { type: "page", label: "Calibrate the map", icon: "pin_drop", to: "calibration",
          sub: savedAnchors() ? "Calibrated on this device" : "Using the position stored for this library",
          keywords: "gps corners anchors align" },
        { type: "action", label: "Reset calibration", icon: "restart_alt", run: resetCalibration,
          hidden: () => !savedAnchors() },
      ],
    },
    { id: "calibration", title: "Map calibration", hidden: true, items: [{ type: "custom", render: calibrationForm }] },
    {
      id: "you", group: "You", title: "Profile", icon: "person", color: "#6a4bc4",
      summary: () => state.name,
      items: [
        { type: "text", label: "Your name", maxLength: 24, placeholder: "Your name",
          sub: social?.enabled ? "Friends see this next to your dot." : "Shown on your avatar.",
          get: () => state.name, set: renameMe, keywords: "rename display" },
        { type: "swatch", key: "avatarColor", label: "Avatar colour", keywords: "color colour picture",
          options: [
            { value: "auto", color: personColor(state.name || "?"), label: "Automatic", text: "A" },
            ...FRIEND_COLORS.map((c, i) => ({ value: c, color: c, label: `Colour ${i + 1}` })),
          ] },
        { type: "toggle", key: "showStatus", label: "Show connection status",
          sub: "The server, GPS and sensor pills in the panel.", keywords: "server latency" },
        { type: "header", label: "This device" },
        { type: "action", label: "Reset all settings", icon: "restart_alt", run: resetSettings, keywords: "defaults" },
        { type: "action", label: "Forget me on this device", icon: "logout", danger: true, run: forgetMe,
          keywords: "sign out delete data privacy" },
      ],
    },
    {
      id: "about", group: "You", title: "About", icon: "info", color: "#59626d",
      summary: () => `Library Nav ${APP_VERSION}`,
      items: [
        { type: "info", label: "Library", value: () => state.library?.name || "" },
        { type: "info", label: "Server", value: () => state.mqtt === "connected"
          ? `Connected${state.latencyMs != null ? `, ${state.latencyMs} ms` : ""}` : cap(state.mqtt || "offline") },
        { type: "info", label: "Your ID", value: () => (state.uid || "").slice(0, 8) },
        { type: "info", label: "Version", value: () => APP_VERSION },
        { type: "link", label: "How it works", icon: "info", href: "about.html" },
        { type: "link", label: "Source code", icon: "code", href: "https://github.com/Ted369369/Indoor-3D-Navigation-Platform" },
        { type: "link", label: "Icons: Material Symbols", sub: "Apache License 2.0", icon: "palette",
          href: "https://github.com/google/material-design-icons" },
      ],
    },
  ];
}

/* ============================================================ indicators */
function setStat(id, cls, label, title) {
  const s = $(id);
  s.className = `stat ${cls}`;
  s.querySelector(".stat-label").textContent = label;
  s.title = title;
}

function updateMqttDot(s) {
  state.mqtt = s;
  const cls = s === "connected" ? "ok" : s === "reconnecting" ? "warn" : "err";
  const label = s === "connected"
    ? (state.latencyMs != null ? `Server ${state.latencyMs} ms` : "Server")
    : s === "reconnecting" ? "Reconnecting" : "Offline";
  setStat("connMqtt", cls, label, `Server: ${s}`);
}

function updateGpsDot(acc) {
  if (acc == null) {
    setStat("connGps", "err", "No GPS", "GPS unavailable");
    return;
  }
  const cls = acc < 25 ? "ok" : acc < 60 ? "warn" : "err";
  setStat("connGps", cls, `GPS ±${fmtDist(acc)}`, `GPS accuracy: ±${fmtDist(acc)}`);
}

function updateSensorDot() {
  if (state.mode === "gps") {
    setStat("connSensor", "", "No sensor", "Phone GPS only: floor set by hand");
    return;
  }
  if (!state.deviceId) { setStat("connSensor", "", "No sensor", "No sensor paired"); return; }
  const age = Date.now() - state.sensorLastSeen;
  const cls = age < 5000 ? "ok" : age < 15000 ? "warn" : "err";
  setStat("connSensor", cls, state.deviceId,
    `Sensor ${state.deviceId}: ` + (age < 15000 ? `online, ${state.sensorRssi} dBm` : "no data"));
}

/** libnav/capacity carries every library; pull out the one we're in. */
function capacityForLibrary(cap) {
  if (!cap?.sites) return cap; // older engine: one shared count
  const here = cap.sites[state.library.id] || { active: 0, waiting: 0 };
  return { ...here, max: cap.max };
}

function updateCapacityPill(capacity) {
  const pill = $("capPill");
  if (!capacity) return;
  const active = capacity.active ?? 0, max = capacity.max ?? CFG.maxDevices;
  const wasHidden = pill.hidden;
  pill.hidden = false;
  pill.querySelector(".cap-count").textContent = `${active} of ${max} in use`;
  if (wasHidden) updateLayout();
  const full = active >= max;
  pill.classList.toggle("full", full);
  pill.title = full
    ? "All sensors in use" + (capacity.waiting ? `, ${capacity.waiting} waiting` : "")
    : `${active} of ${max} sensors in use`;
}

/* ============================================================ utils */
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
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
  toast(`Something went wrong while starting: ${err.message}`, "error");
});

// debug/testing handle (harmless in production)
window.__nav = { state, renderDeviceList, showLocalGps, openPlace, navigateTo, endRoute,
  submitSearch: (q) => submitSearch(q),
  zonesOf: () => nav?.zones,
  scene: () => scene,
  setAppMode, distanceToLibrary, updateCapacityPill, focusFloor, showView, setSheet,
  settings, openSettings,
  feedFix: (fix) => { if (gps) gps.lastFix = fix; showLocalGps(fix); },
  floorVisibility: () => Object.fromEntries(
    Object.entries(scene.floorGroups).map(([lvl, g]) => [lvl, g.visible])),
  markerCount: () => scene?.markers?.size ?? 0,
  selfMarker: () => scene?.markers?.get(state.uid)?.target };
