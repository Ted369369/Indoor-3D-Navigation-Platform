/*
 * Chat intent engine.
 * Maps free-text queries ("c language", "I want to study Qing dynasty
 * history", "where can I self-study?") to navigation targets.
 *
 * The word list lives in each library's model file (`keywords`, `intents`,
 * `site.floorLanding`), since every building shelves things differently.
 * Rows are {t, a[], zone?, intent?, note?}; matching is exact alias first,
 * then fuzzy (Fuse.js global).
 *
 * Extra terms can be added server-side in the Supabase `keywords` table;
 * they are merged into the dictionary at startup.
 */

export class IntentEngine {
  constructor(model, extraKeywords = []) {
    this.model = model;
    this.zones = {};
    for (const [level, floor] of Object.entries(model.floors)) {
      for (const z of floor.zones) this.zones[z.id] = { ...z, floor: level };
    }
    this.intents = model.intents || {};
    this.levels = model.site.floors.map((f) => String(f.level));

    // Supabase rows are shared between libraries, so keep only the ones that
    // point at a zone in this building (or at a generic intent)
    this.dict = [...(model.keywords || [])];
    for (const row of extraKeywords) {
      const zone = row.zone_id || undefined;
      const intentName = row.intent === "zone" ? undefined : row.intent || undefined;
      if (zone && !this.zones[zone]) continue;
      if (!zone && !this.intents[intentName]) continue;
      this.dict.push({ t: row.term, a: row.aliases || [], zone, intent: intentName });
    }
    this.fuse = new Fuse(this.dict, {
      keys: [{ name: "t", weight: 0.7 }, { name: "a", weight: 0.3 }],
      threshold: 0.34,
      ignoreLocation: true,
      includeScore: true,
    });
  }

  /**
   * Resolve a query to an action.
   * @returns {kind:'zone'|'nearest'|'unknown', ...}
   */
  resolve(rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return { kind: "unknown" };

    // explicit floor request: "go to floor 2" / "2樓"
    const floorMatch = q.match(/(?:floor\s*(\d))|(\d)\s*樓/);
    const landing = this.model.site.floorLanding || {};
    if (floorMatch && q.length < 20) {
      const f = floorMatch[1] || floorMatch[2];
      const zoneId = landing[f];
      if (zoneId && this.zones[zoneId]) {
        return {
          kind: "zone", zoneId,
          reply: `Heading to floor ${f}. I'll take you to the ${this.zones[zoneId].name}.`,
        };
      }
      if (!this.levels.includes(f)) {
        return { kind: "unknown", reply: `This library has no floor ${f}.` };
      }
    }

    // alias containment beats fuzzy search; the longest matching term wins, so
    // "passports" goes to passports and not to "sports"
    let hit = null;
    let hitLen = 0;
    for (const row of this.dict) {
      for (const t of [row.t, ...row.a].map((s) => s.toLowerCase())) {
        const len = q === t ? Infinity : t.length >= 2 && q.includes(t) ? t.length : 0;
        if (len > hitLen) { hit = row; hitLen = len; }
      }
    }
    if (!hit) {
      const results = this.fuse.search(q);
      if (results.length && results[0].score < 0.45) hit = results[0].item;
    }
    if (!hit) return { kind: "unknown", reply: this._unknownReply() };

    if (hit.intent) {
      const spec = this.intents[hit.intent];
      if (!spec) return { kind: "unknown", reply: this._unknownReply() };
      return { kind: "nearest", candidates: spec.candidates, lead: spec.lead, term: hit.t };
    }
    const zone = this.zones[hit.zone];
    if (!zone) return { kind: "unknown", reply: this._unknownReply() };
    const note = hit.note ? ` ${hit.note}` : "";
    return {
      kind: "zone",
      zoneId: hit.zone,
      term: hit.t,
      reply: `"${cap(hit.t)}" is in the ${zone.name} on floor ${zone.floor}.${note} Starting navigation.`,
    };
  }

  /** Autocomplete suggestions while typing. */
  suggest(prefix, limit = 5) {
    const q = prefix.trim().toLowerCase();
    if (q.length < 1) return [];
    const out = [];
    const seen = new Set();
    for (const row of this.dict) {
      for (const term of [row.t, ...row.a]) {
        if (term.toLowerCase().startsWith(q) && !seen.has(row.t)) {
          seen.add(row.t);
          out.push({ label: term, term: row.t });
        }
      }
      if (out.length >= limit) return out;
    }
    for (const r of this.fuse.search(q).slice(0, limit)) {
      if (!seen.has(r.item.t)) {
        seen.add(r.item.t);
        out.push({ label: r.item.t, term: r.item.t });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  _unknownReply() {
    const hint = this.model.site.searchHint || "";
    return `I couldn't match that to a part of the library. ${hint}`.trim();
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
