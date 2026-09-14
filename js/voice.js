/*
 * Voice layer: text-to-speech guidance (works on Android + iOS) and
 * speech-to-text input where available (Chrome/Android; iOS Safari has no
 * SpeechRecognition, so the mic button hides itself there).
 * Acts as the blind-user interface: in blind mode everything important is
 * spoken and mirrored to an aria-live region.
 */

export class Speaker {
  constructor(announcerEl) {
    this.enabled = false;
    this.announcer = announcerEl;
    this.voice = null;
    if ("speechSynthesis" in window) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice =
          voices.find((v) => v.lang === "en-US" && v.localService) ||
          voices.find((v) => v.lang.startsWith("en")) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  get supported() {
    return "speechSynthesis" in window;
  }

  speak(text, { interrupt = false } = {}) {
    if (this.announcer) this.announcer.textContent = text; // screen readers
    if (!this.enabled || !this.supported) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = "en-US";
    u.rate = 1.0;
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
      `Route started to ${route.targetName}. Distance ${route.totalM} meters, about ${eta} minute${eta > 1 ? "s" : ""}.`,
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
        this.route = null;
        return "arrived";
      }
      if (ins.type === "floor" && d < 8) {
        this.spoken.add(ins);
        this.speaker.speak(ins.text);
      }
      if (ins.type === "turn" && d < 6) {
        this.spoken.add(ins);
        this.speaker.speak(ins.short || ins.text);
      }
    }

    // periodic reassurance for blind users
    const now = Date.now();
    if (this.blindMode && now - this.lastProgressAnnounce > 20000) {
      this.lastProgressAnnounce = now;
      const last = this.route.points[this.route.points.length - 1];
      if (String(last.floor) === String(pos.floor)) {
        const d = Math.round(Math.hypot(last.x - pos.x, last.y - pos.y));
        if (d > 6) this.speaker.speak(`${d} meters remaining on this floor.`);
      }
    }

    // off-route detection (same-floor drift beyond 15 m for 5 s)
    if (offRouteDist > 15) {
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
