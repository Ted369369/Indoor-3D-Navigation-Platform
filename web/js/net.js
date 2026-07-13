/*
 * MQTT connectivity layer.
 * Wraps mqtt.js (global `mqtt` from the CDN bundle) with:
 *  - auto-reconnect + status events
 *  - JSON publish/subscribe helpers
 *  - broker round-trip latency measurement via a self-echo topic
 */
export class Bus extends EventTarget {
  constructor() {
    super();
    this.client = null;
    this.uid = null;
    this.latencyMs = null;
    this._pingTimer = null;
    this._handlers = []; // [pattern, fn]
  }

  connect(cfg, uid) {
    this.uid = uid;
    const willTopic = `libnav/user/${uid}/presence`;
    this.client = mqtt.connect(cfg.mqttUrl, {
      username: cfg.mqttUser,
      password: cfg.mqttPass,
      clientId: `web-${uid.slice(0, 18)}-${Math.random().toString(16).slice(2, 6)}`,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
      will: { topic: willTopic, payload: "offline", qos: 1, retain: true },
    });

    this.client.on("connect", () => {
      this.publish(willTopic, "online", { retain: true, qos: 1 });
      this.subscribe(`libnav/user/${uid}/echo`);
      this._startPing();
      this._emit("status", { state: "connected" });
    });
    this.client.on("reconnect", () => this._emit("status", { state: "reconnecting" }));
    this.client.on("close", () => this._emit("status", { state: "offline" }));
    this.client.on("error", (err) => this._emit("status", { state: "error", error: err.message }));

    this.client.on("message", (topic, payload) => {
      if (topic === `libnav/user/${uid}/echo`) {
        try {
          const t = JSON.parse(payload.toString()).t;
          this.latencyMs = Date.now() - t;
          this._emit("latency", { ms: this.latencyMs });
        } catch { /* ignore */ }
        return;
      }
      for (const [pattern, fn] of this._handlers) {
        if (Bus.topicMatch(pattern, topic)) fn(topic, payload);
      }
    });
  }

  /** Subscribe and route matching messages to fn(topic, payloadBuffer). */
  on(pattern, fn) {
    this._handlers.push([pattern, fn]);
    this.subscribe(pattern);
  }

  subscribe(topic) {
    this.client?.subscribe(topic, { qos: 0 });
  }

  unsubscribe(topic) {
    this.client?.unsubscribe(topic);
    this._handlers = this._handlers.filter(([p]) => p !== topic);
  }

  publish(topic, data, opts = {}) {
    if (!this.client?.connected) return false;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.client.publish(topic, payload, { qos: opts.qos ?? 0, retain: opts.retain ?? false });
    return true;
  }

  get connected() {
    return !!this.client?.connected;
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      this.publish(`libnav/user/${this.uid}/echo`, { t: Date.now() });
    }, 5000);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  static topicMatch(pattern, topic) {
    if (pattern === topic) return true;
    const p = pattern.split("/");
    const t = topic.split("/");
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "#") return true;
      if (p[i] === "+") continue;
      if (p[i] !== t[i]) return false;
    }
    return p.length === t.length;
  }
}

/** Browser geolocation -> MQTT gps topic, throttled to gpsPublishHz. */
export class GpsPublisher extends EventTarget {
  constructor(bus, uid, hz = 1) {
    super();
    this.bus = bus;
    this.uid = uid;
    this.minInterval = 1000 / hz;
    this.watchId = null;
    this.lastSent = 0;
    this.lastFix = null;
  }

  start() {
    if (!("geolocation" in navigator)) {
      this.dispatchEvent(new CustomEvent("error", { detail: "Geolocation unsupported" }));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
          ts: pos.timestamp,
        };
        this.dispatchEvent(new CustomEvent("fix", { detail: this.lastFix }));
        const now = Date.now();
        if (now - this.lastSent >= this.minInterval) {
          this.lastSent = now;
          this.bus.publish(`libnav/user/${this.uid}/gps`, this.lastFix);
        }
      },
      (err) => this.dispatchEvent(new CustomEvent("error", { detail: err.message })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}
