/*
 * Application orchestrator: boots the 3D scene, connectivity, chat intent,
 * voice guidance, friends, and connection-quality indicators.
 */
import { MapScene } from "./map3d.js";
import { Navigator } from "./nav.js";
import { IntentEngine } from "./intent.js";
import { Speaker, Listener, Guidance } from "./voice.js";
import { Bus, GpsPublisher } from "./net.js";
import { Social } from "./supa.js";

const CFG = window.NAV_CONFIG;
const $ = (id) => document.getElementById(id);
const DEFAULT_START = { floor: 2, x: 25, y: 19 }; // 2F escalator hall (entrance)

const state = {
  uid: null, name: "", deviceId: "", blind: false, accessible: false,
  pos: null, route: null, routeTarget: null,
  friends: new Map(), // uid -> {name, online, pos, subscribed}
  admitted: true,
  sensorLastSeen: 0, sensorRssi: null, pressureOk: false,
};

let model, scene, nav, intent, speaker, listener, guidance, bus, gps, social;

/* ============================== boot ==================================== */
async function boot() {
  model = await (await fetch("data/map_model.json")).json();
  scene = new MapScene($("scene"), model, { onZoneClick: onZoneTap });
  nav = new Navigator(model);
  speaker = new Speaker($("announcer"));
  bus = new Bus();
  social = new Social(CFG);

  const prefs = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
  $("nameInput").value = prefs.name || "";
  $("deviceInput").value = prefs.deviceId || "";
  $("blindToggle").checked = !!prefs.blind;
  $("accessibleToggle").checked = !!prefs.accessible;
  if (!social.enabled) $("soloNote").hidden = false;

  $("welcomeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("startBtn");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    try {
      await start({
        name: $("nameInput").value.trim() || "Visitor",
        deviceId: $("deviceInput").value.trim().toUpperCase(),
        blind: $("blindToggle").checked,
        accessible: $("accessibleToggle").checked,
      });
      $("welcomeModal").hidden = true;
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Start navigating";
    }
  });
}

async function start(opts) {
  Object.assign(state, opts);
  localStorage.setItem("libnav.prefs", JSON.stringify({
    ...opts, uid: JSON.parse(localStorage.getItem("libnav.prefs") || "{}").uid,
  }));

  // ---- identity
  let extraKeywords = [];
  if (social.enabled) {
    state.uid = await social.signIn(state.name);
    social.registerDevice(state.deviceId).catch(() => {});
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
    if (state.deviceId) {
      bus.publish(`libnav/user/${state.uid}/pair`, { device: state.deviceId },
        { retain: true, qos: 1 });
    }
    const anchors = JSON.parse(localStorage.getItem("libnav.anchors") || "null");
    if (anchors) bus.publish("libnav/site/anchors", anchors, { retain: true, qos: 1 });
  });

  bus.on(`libnav/user/${state.uid}/pos`, (t, payload) => onSelfPos(JSON.parse(payload)));
  bus.on(`libnav/user/${state.uid}/control`, (t, payload) => onControl(JSON.parse(payload)));
  bus.on("libnav/engine/status", (t, payload) => {
    state.engineOnline = payload.toString() === "online";
    if (!state.engineOnline) toast("Position engine offline - live tracking paused", "warn");
  });
  if (state.deviceId) {
    bus.on(`libnav/dev/${state.deviceId}/telemetry`, (t, payload) => {
      const d = JSON.parse(payload);
      state.sensorLastSeen = Date.now();
      state.sensorRssi = d.rssi;
    });
  }

  // ---- GPS
  gps = new GpsPublisher(bus, state.uid, CFG.gpsPublishHz);
  gps.addEventListener("fix", (e) => updateGpsDot(e.detail.acc));
  gps.addEventListener("error", (e) => {
    updateGpsDot(null);
    toast(`GPS: ${e.detail}`, "warn");
  });
  gps.start();

  setInterval(updateSensorDot, 2000);

  wireUi();
  await refreshFriends();

  chatSystem(
    `Welcome, ${state.name}. Ask me for a book subject ("C language", ` +
    `"Qing dynasty history"), a place ("somewhere to study", "newspapers"), ` +
    `or a friend's name.`
  );
  speaker.speak(
    `Welcome to the library navigator, ${state.name}. ` +
    (state.blind ? "Voice guidance is on. Type or dictate where you want to go." : "")
  , { interrupt: true });
}

/* ============================== positions =============================== */
function onSelfPos(p) {
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

function onControl(msg) {
  if (msg.action === "reject") {
    state.admitted = false;
    $("capacityOverlay").hidden = false;
    speaker.speak("The system is at full capacity. You are in the queue.");
  } else if (msg.action === "admit") {
    if (!state.admitted) toast("A slot opened up - you are connected", "ok");
    state.admitted = true;
    $("capacityOverlay").hidden = true;
  }
}

/* ============================== navigation ============================== */
function navigateTo(target, lead = "") {
  const start = state.pos
    ? { floor: state.pos.floor, x: state.pos.x, y: state.pos.y }
    : DEFAULT_START;
  const profile = state.accessible ? "accessible" : "normal";
  const route = nav.route(start, target, profile);
  if (!route) {
    chatSystem("Sorry, I could not compute a route to that destination.");
    return;
  }
  state.route = route;
  state.routeTarget = target;
  scene.showPath(route.points);
  scene.highlightZone(typeof target === "string" ? target : null);
  if (!state.pos) {
    chatSystem("No live position yet - route starts from the floor 2 entrance.");
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
  if (!zone || zone.kind === "staff") {
    if (zone) chatSystem(`${zone.name} is staff-only and not open to visitors.`);
    return;
  }
  chatSystem(`Navigating to ${zone.name} (tapped on the map).`);
  navigateTo(zoneId);
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
      state.accessible ? "accessible" : "normal"
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
}
const chatSystem = (text) => chatBubble(text, "system");

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
    speaker.speak("Voice guidance on.", { interrupt: true });
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

  // settings / calibration
  $("btnSettings").addEventListener("click", () => {
    const a = JSON.parse(localStorage.getItem("libnav.anchors") || "null")
      || model.site.geoAnchors;
    $("originLat").value = a.origin.lat; $("originLng").value = a.origin.lng;
    $("xLat").value = a.xAxis.lat; $("xLng").value = a.xAxis.lng;
    $("settingsModal").hidden = false;
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
