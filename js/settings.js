/*
 * Settings: a small store kept in localStorage, and the settings screen.
 *
 * The screen is built from a list of sections the app hands over, so adding
 * a setting means adding one entry there and one case where it gets applied.
 */
import { icon } from "./icons.js?v=set1";

const KEY = "libnav.settings";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const DEFAULTS = {
  // appearance
  theme: "system", accent: "blue", textSize: "m", reduceMotion: false,
  // map
  mapView: "3d", labels: "names", followMe: true, showAccuracy: true,
  floorSpacing: "normal", quality: "balanced", showFriends: true, units: "auto",
  // directions
  accessible: false, stairPref: "central", walkPace: "normal", reroute: true,
  vibrate: false, autoFloor: true,
  // voice and accessibility
  voice: false, lowVision: false, voiceName: "", voiceRate: 1, voiceVolume: 1,
  progressUpdates: false,
  // search
  showChips: true, showMic: true, autoStart: false, recent: true,
  // location
  appMode: "test", gpsSmoothing: "balanced", snapToPaths: true,
  // you
  avatarColor: "auto", showStatus: true,
};

export class Settings extends EventTarget {
  constructor() {
    super();
    this.values = { ...DEFAULTS, reduceMotion: reducedMotion() };
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* ignore */ }
    if (saved && typeof saved === "object") {
      for (const k of Object.keys(DEFAULTS)) if (k in saved) this.values[k] = saved[k];
    } else {
      this._migrate();
    }
  }

  /** Older versions kept a few of these in libnav.prefs and libnav.voice. */
  _migrate() {
    try {
      const p = JSON.parse(localStorage.getItem("libnav.prefs") || "{}");
      if (p.blind) this.values.lowVision = true;
      if (p.accessible) this.values.accessible = true;
      if (p.stairPref === "west") this.values.stairPref = "west";
      if (p.appMode === "production") this.values.appMode = "production";
      if (JSON.parse(localStorage.getItem("libnav.voice") || "false")) this.values.voice = true;
      if (p.blind) this.values.voice = true;
    } catch { /* nothing to migrate */ }
    this._save();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this._save();
    this.dispatchEvent(new CustomEvent("change", { detail: { key, value } }));
  }

  /** Back to defaults; fires a change for every value that moves. */
  reset() {
    const old = this.values;
    this.values = { ...DEFAULTS, reduceMotion: reducedMotion() };
    this._save();
    for (const key of Object.keys(this.values)) {
      if (old[key] !== this.values[key]) {
        this.dispatchEvent(new CustomEvent("change", { detail: { key, value: this.values[key] } }));
      }
    }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
  }
}

/*
 * The settings screen. `sections()` returns:
 *   [{ id, title, icon, color, summary(), hidden?, items: [...] }]
 * Item types:
 *   header   { label }
 *   toggle   { key, label, sub }
 *   choice   { key, label, sub, options: [{ value, label }] }      segmented buttons
 *   select   { key, label, sub, options() }                         native drop-down
 *   range    { key, label, min, max, step, format(v) }
 *   swatch   { key, label, options: [{ value, color, label }] }
 *   text     { label, sub, placeholder, maxLength, get(), set(v) }
 *   page     { label, sub, icon, to }                               opens another section
 *   action   { label, sub, icon, danger, run() }
 *   link     { label, icon, href }
 *   info     { label, value() }
 *   note     { text }
 *   custom   { render() -> Element }
 * Any item may have hidden() and keywords (extra words for the search box).
 * `key` items read and write the store unless they bring their own get/set.
 */
export class SettingsPage {
  constructor({ panel, body, title, back, store, sections }) {
    this.panel = panel;
    this.body = body;
    this.titleEl = title;
    this.backBtn = back;
    this.store = store;
    this.sections = sections;
    this.stack = [];
    this.query = "";
    this.editing = null;

    back.addEventListener("click", () => this.back());
    store.addEventListener("change", (e) => {
      // a slider being dragged re-renders itself; everything else redraws the page,
      // since one setting can show or hide others
      if (this.panel.hidden || e.detail.key === this.editing) return;
      this.refresh();
    });
  }

  open(sectionId = null) {
    this.stack = sectionId ? [sectionId] : [];
    this.query = "";
    this.panel.hidden = false;
    this.render();
    this.body.scrollTop = 0;
  }

  back() {
    this.stack.pop();
    this.render();
    this.body.scrollTop = 0;
  }

  show(sectionId) {
    this.stack.push(sectionId);
    this.render();
    this.body.scrollTop = 0;
  }

  /** Redraw the current page and keep the scroll position. */
  refresh() {
    const top = this.body.scrollTop;
    const focusedSearch = document.activeElement?.classList.contains("set-search-input");
    this.render();
    this.body.scrollTop = top;
    if (focusedSearch) {
      const input = this.body.querySelector(".set-search-input");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  render() {
    const all = this.sections();
    const current = all.find((s) => s.id === this.stack[this.stack.length - 1]);
    this.backBtn.hidden = !current;
    this.titleEl.textContent = current ? current.title : "Settings";
    this.body.innerHTML = "";
    if (current) {
      this._renderItems(current.items, this.body);
    } else {
      this._renderRoot(all);
    }
  }

  /* ------------------------------------------------------------ root */
  _renderRoot(all) {
    const search = el(`<label class="set-search">
      ${icon("search")}
      <input class="set-search-input" type="search" placeholder="Search settings" aria-label="Search settings" />
    </label>`);
    const input = search.querySelector("input");
    input.value = this.query;
    input.addEventListener("input", () => {
      this.query = input.value;
      this._renderRootBody(all, box);
    });
    this.body.appendChild(search);
    const box = el(`<div></div>`);
    this.body.appendChild(box);
    this._renderRootBody(all, box);
  }

  _renderRootBody(all, box) {
    box.innerHTML = "";
    const q = this.query.trim().toLowerCase();
    if (q) {
      this._renderSearch(all, q, box);
      return;
    }
    const groups = [];
    for (const s of all) {
      if (s.hidden) continue;
      const g = s.group || "";
      let last = groups[groups.length - 1];
      if (!last || last.name !== g) groups.push((last = { name: g, sections: [] }));
      last.sections.push(s);
    }
    for (const g of groups) {
      if (g.name) box.appendChild(el(`<h3 class="section-title">${esc(g.name)}</h3>`));
      const card = el(`<div class="set-card"></div>`);
      for (const s of g.sections) {
        const summary = s.summary ? s.summary() : "";
        const row = el(`<button type="button" class="set-row nav">
          <span class="set-icon" style="background:${s.color}">${icon(s.icon, { filled: true })}</span>
          <span class="set-text"><b>${esc(s.title)}</b>${summary ? `<span class="sub">${esc(summary)}</span>` : ""}</span>
          ${icon("chevron_right", { cls: "ic chev" })}
        </button>`);
        row.addEventListener("click", () => this.show(s.id));
        card.appendChild(row);
      }
      box.appendChild(card);
    }
  }

  _renderSearch(all, q, box) {
    let found = 0;
    for (const s of all) {
      const hits = s.items.filter((it) => {
        if (["header", "note"].includes(it.type) || (it.type === "custom" && !it.label) || it.hidden?.()) return false;
        const text = [it.label, it.sub, it.keywords, s.title].filter(Boolean).join(" ").toLowerCase();
        return q.split(/\s+/).every((w) => text.includes(w));
      });
      if (!hits.length) continue;
      found += hits.length;
      box.appendChild(el(`<h3 class="section-title">${esc(s.title)}</h3>`));
      const card = el(`<div class="set-card"></div>`);
      for (const it of hits) {
        const node = this._renderItem(it);
        if (node) card.appendChild(node);
      }
      box.appendChild(card);
    }
    if (!found) {
      box.appendChild(el(`<div class="empty-state"><b>No settings match "${esc(q)}"</b>Try a word like "dark", "voice", "feet" or "stairs".</div>`));
    }
  }

  /* ------------------------------------------------------------ pages */
  _renderItems(items, root) {
    let card = null;
    const flush = () => { card = null; };
    for (const it of items) {
      if (it.hidden?.()) continue;
      if (it.type === "header") {
        flush();
        root.appendChild(el(`<h3 class="section-title">${esc(it.label)}</h3>`));
        continue;
      }
      if (it.type === "note") {
        flush();
        root.appendChild(el(`<p class="set-note">${esc(it.text)}</p>`));
        continue;
      }
      const node = this._renderItem(it);
      if (!node) continue;
      if (!card) {
        card = el(`<div class="set-card"></div>`);
        root.appendChild(card);
      }
      card.appendChild(node);
    }
  }

  _get(it) {
    return it.get ? it.get() : this.store.get(it.key);
  }

  _set(it, v) {
    if (it.set) it.set(v);
    else this.store.set(it.key, v);
  }

  _text(it) {
    return `<span class="set-text"><b>${esc(it.label)}</b>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}</span>`;
  }

  _renderItem(it) {
    switch (it.type) {
      case "toggle": {
        const row = el(`<label class="set-row">${this._text(it)}<input class="switch" type="checkbox" role="switch" /></label>`);
        const input = row.querySelector("input");
        input.checked = !!this._get(it);
        input.addEventListener("change", () => this._set(it, input.checked));
        return row;
      }
      case "choice": {
        const row = el(`<div class="set-row stack">${this._text(it)}<div class="seg" role="radiogroup" aria-label="${esc(it.label)}"></div></div>`);
        const seg = row.querySelector(".seg");
        const value = this._get(it);
        for (const o of it.options) {
          const b = el(`<button type="button" role="radio" aria-checked="${o.value === value}" class="${o.value === value ? "on" : ""}">${esc(o.label)}</button>`);
          b.addEventListener("click", () => this._set(it, o.value));
          seg.appendChild(b);
        }
        return row;
      }
      case "select": {
        const row = el(`<label class="set-row">${this._text(it)}<select class="set-select"></select></label>`);
        const sel = row.querySelector("select");
        const value = this._get(it);
        for (const o of it.options()) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          opt.selected = o.value === value;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => this._set(it, sel.value));
        return row;
      }
      case "range": {
        const row = el(`<div class="set-row stack">
          <span class="set-text"><b>${esc(it.label)}</b></span>
          <div class="set-range"><input type="range" min="${it.min}" max="${it.max}" step="${it.step}" aria-label="${esc(it.label)}" /><output></output></div>
        </div>`);
        const input = row.querySelector("input");
        const out = row.querySelector("output");
        input.value = this._get(it);
        out.textContent = it.format(+input.value);
        input.addEventListener("input", () => {
          this.editing = it.key;
          out.textContent = it.format(+input.value);
          this._set(it, +input.value);
          this.editing = null;
        });
        return row;
      }
      case "swatch": {
        const row = el(`<div class="set-row stack">${this._text(it)}<div class="swatches" role="radiogroup" aria-label="${esc(it.label)}"></div></div>`);
        const box = row.querySelector(".swatches");
        const value = this._get(it);
        for (const o of it.options) {
          const on = o.value === value;
          const b = el(`<button type="button" role="radio" aria-checked="${on}" aria-label="${esc(o.label)}" title="${esc(o.label)}"
            class="swatch ${on ? "on" : ""}" style="--sw:${o.color}">${o.text ? esc(o.text) : ""}</button>`);
          b.addEventListener("click", () => this._set(it, o.value));
          box.appendChild(b);
        }
        return row;
      }
      case "text": {
        const row = el(`<div class="set-row stack">${this._text(it)}
          <form class="field-row"><input type="text" maxlength="${it.maxLength || 40}" placeholder="${esc(it.placeholder || "")}" aria-label="${esc(it.label)}" />
          <button type="submit" class="btn tonal small">Save</button></form></div>`);
        const input = row.querySelector("input");
        input.value = this._get(it) || "";
        row.querySelector("form").addEventListener("submit", (e) => {
          e.preventDefault();
          this._set(it, input.value.trim());
        });
        return row;
      }
      case "page": {
        const row = el(`<button type="button" class="set-row nav">
          ${it.icon ? icon(it.icon) : ""}${this._text(it)}${icon("chevron_right", { cls: "ic chev" })}</button>`);
        row.addEventListener("click", () => this.show(it.to));
        return row;
      }
      case "action": {
        const row = el(`<button type="button" class="set-row nav ${it.danger ? "danger" : ""}">
          ${it.icon ? icon(it.icon) : ""}${this._text(it)}</button>`);
        row.addEventListener("click", () => it.run());
        return row;
      }
      case "link": {
        const row = el(`<a class="set-row nav" href="${esc(it.href)}" ${/^https?:/.test(it.href) ? 'target="_blank" rel="noopener"' : ""}>
          ${it.icon ? icon(it.icon) : ""}${this._text(it)}${icon(/^https?:/.test(it.href) ? "open_in_new" : "chevron_right", { cls: "ic chev" })}</a>`);
        return row;
      }
      case "info": {
        return el(`<div class="set-row">${this._text(it)}<span class="set-value">${esc(it.value())}</span></div>`);
      }
      case "custom":
        return it.render();
      default:
        return null;
    }
  }
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
