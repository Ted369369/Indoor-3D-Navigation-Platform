/*
 * Voice layer: text-to-speech guidance (works on Android + iOS) and
 * speech-to-text input where available (Chrome/Android; iOS Safari has no
 * SpeechRecognition, so the mic button hides itself there).
 * Acts as the blind-user interface: in blind mode everything important is
 * spoken and mirrored to an aria-live region.
 */

export class Speaker extends EventTarget {
  constructor(announcerEl) {
    super();
    this.enabled = false;
    this.announcer = announcerEl;
    this.voiceName = ""; // "" = pick automatically
    this.rate = 1;
    this.volume = 1;
    if (this.supported) {
      // voices load late in some browsers; tell the settings screen when they arrive
      speechSynthesis.addEventListener?.("voiceschanged", () => this.dispatchEvent(new Event("voices")));
    }
  }

  get supported() {
    return "speechSynthesis" in window;
  }

  /** English voices the device offers. */
  voices() {
    if (!this.supported) return [];
    return speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("en"));
  }

  _voice() {
    const list = this.voices();
    return list.find((v) => v.name === this.voiceName) ||
      list.find((v) => v.lang === "en-US" && v.localService) ||
      list[0] || null;
  }

  /** `force` speaks even when spoken directions are off (the settings test button). */
  speak(text, { interrupt = false, force = false } = {}) {
    if (this.announcer && !force) this.announcer.textContent = text; // screen readers
    if ((!this.enabled && !force) || !this.supported) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this._voice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || "en-US";
    u.rate = this.rate;
    u.volume = this.volume;
    speechSynthesis.speak(u);
  }

  stop() {
    if (this.supported) speechSynthesis.cancel();
  }
}

export class Listener {
  constructor(onResult, onStateChange) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.available = !!SR;
    if (!this.available) return;
    this.rec = new SR();
    this.rec.lang = "en-US";
    this.rec.interimResults = false;
    this.rec.maxAlternatives = 1;
    this.listening = false;
    this.rec.onresult = (e) => onResult(e.results[0][0].transcript);
    this.rec.onend = () => { this.listening = false; onStateChange(false); };
    this.rec.onerror = () => { this.listening = false; onStateChange(false); };
    this._onStateChange = onStateChange;
  }

  toggle() {
    if (!this.available) return;
    if (this.listening) {
      this.rec.stop();
    } else {
      this.listening = true;
      this._onStateChange(true);
      this.rec.start();
    }
  }
}

/**
 * Turn-by-turn guidance: watches live positions against the active route and
 * speaks instructions at the right distance. Detects off-route drift and
 * asks the app to recalculate.
 */
export class Guidance {
  constructor(speaker, { onReroute, blindMode = false } = {}) {
    this.speaker = speaker;
    this.onReroute = onReroute;
    this.blindMode = blindMode;
    this.progressUpdates = false; // "N meters left" every 20 s, also on in blind mode
    this.autoReroute = true;
    this.vibrate = false;
    this.formatDistance = (m) => `${Math.round(m)} meters`;
    this.route = null;
    this.spoken = new Set();
    this.offRouteSince = null;
    this.lastProgressAnnounce = 0;
  }

  start(route) {
    this.route = route;
    this.spoken = new Set();
    this.offRouteSince = null;
    const eta = Math.max(1, Math.round(route.etaS / 60));
    this.speaker.speak(
      `Route started to ${route.targetName}. Distance ${this.formatDistance(route.totalM)}, about ${eta} minute${eta > 1 ? "s" : ""}.`,
      { interrupt: true }
    );
  }

  stop(silent = false) {
    if (this.route && !silent) this.speaker.speak("Navigation ended.");
    this.route = null;
  }

  get active() {
    return !!this.route;
  }

  _buzz(pattern) {
    if (this.vibrate && navigator.vibrate) navigator.vibrate(pattern);
  }

  /** Feed fused positions ({x, y, floor}); returns 'arrived' when done. */
  update(pos, offRouteDist) {
    if (!this.route) return null;

    for (const ins of this.route.instructions) {
      if (this.spoken.has(ins)) continue;
      if (String(ins.point.floor) !== String(pos.floor)) continue;
      const d = Math.hypot(ins.point.x - pos.x, ins.point.y - pos.y);

      if (ins.type === "arrive" && d < 5) {
        this.spoken.add(ins);
        this.speaker.speak(ins.text, { interrupt: true });
        this._buzz([200, 80, 200]);
        this.route = null;
        return "arrived";
      }
      if (ins.type === "floor" && d < 8) {
        this.spoken.add(ins);
        this.speaker.speak(ins.text);
        this._buzz([120, 60, 120]);
      }
      if (ins.type === "turn" && d < 6) {
        this.spoken.add(ins);
        this.speaker.speak(ins.short || ins.text);
        this._buzz(120);
      }
    }

    // periodic reassurance for blind users
    const now = Date.now();
    if ((this.blindMode || this.progressUpdates) && now - this.lastProgressAnnounce > 20000) {
      this.lastProgressAnnounce = now;
      const last = this.route.points[this.route.points.length - 1];
      if (String(last.floor) === String(pos.floor)) {
        const d = Math.hypot(last.x - pos.x, last.y - pos.y);
        if (d > 6) this.speaker.speak(`${this.formatDistance(d)} left on this floor.`);
      }
    }

    // off-route detection (same-floor drift beyond 15 m for 5 s)
    if (this.autoReroute && offRouteDist > 15) {
      if (!this.offRouteSince) this.offRouteSince = now;
      else if (now - this.offRouteSince > 5000) {
        this.offRouteSince = null;
        this.speaker.speak("You seem off route. Recalculating.", { interrupt: true });
        this.onReroute?.();
        return "reroute";
      }
    } else {
      this.offRouteSince = null;
    }
    return null;
  }
}
