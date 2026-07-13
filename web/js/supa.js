/*
 * Supabase layer: anonymous auth, profile, friend graph, keyword extensions.
 * Uses the global `supabase` UMD bundle. If the project is not configured in
 * config.js the app degrades to solo mode (navigation works, friends hidden).
 */
export class Social extends EventTarget {
  constructor(cfg) {
    super();
    this.enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
    if (!this.enabled) return;
    this.db = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    this.uid = null;
  }

  /** Sign in anonymously (or reuse the stored session) and upsert the profile. */
  async signIn(displayName) {
    const { data: { session } } = await this.db.auth.getSession();
    if (!session) {
      const { error } = await this.db.auth.signInAnonymously();
      if (error) throw new Error(`Auth failed: ${error.message}`);
    }
    const { data: { user } } = await this.db.auth.getUser();
    this.uid = user.id;

    const { error: pErr } = await this.db.from("profiles").upsert(
      { id: this.uid, display_name: displayName },
      { onConflict: "id" }
    );
    if (pErr && pErr.code === "23505") {
      throw new Error(`The name "${displayName}" is already taken - pick another.`);
    }

    this.db
      .channel("friendships-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" },
        () => this.dispatchEvent(new Event("friends-changed")))
      .subscribe();
    return this.uid;
  }

  async registerDevice(deviceId) {
    if (!deviceId) return;
    await this.db.from("devices").upsert({ id: deviceId, role: "user" }, { onConflict: "id" });
    await this.db.from("pairings").update({ active: false })
      .eq("user_id", this.uid).eq("active", true);
    await this.db.from("pairings").insert({ user_id: this.uid, device_id: deviceId });
  }

  async searchUsers(query) {
    const { data } = await this.db
      .from("profiles")
      .select("id, display_name")
      .ilike("display_name", `%${query}%`)
      .neq("id", this.uid)
      .limit(8);
    return data || [];
  }

  async sendRequest(addresseeId) {
    const { error } = await this.db.from("friendships").insert({
      requester: this.uid, addressee: addresseeId,
    });
    return !error;
  }

  async respond(friendshipId, accept) {
    await this.db.from("friendships").update({
      status: accept ? "accepted" : "declined",
      responded_at: new Date().toISOString(),
    }).eq("id", friendshipId);
  }

  /** @returns {accepted: [{uid,name}], incoming: [{id,uid,name}], outgoing: [names]} */
  async listFriends() {
    const { data: rows } = await this.db
      .from("friendships")
      .select("id, requester, addressee, status")
      .or(`requester.eq.${this.uid},addressee.eq.${this.uid}`);
    if (!rows) return { accepted: [], incoming: [], outgoing: [] };

    const otherIds = [...new Set(rows.map(
      (r) => (r.requester === this.uid ? r.addressee : r.requester)
    ))];
    const names = {};
    if (otherIds.length) {
      const { data: profiles } = await this.db
        .from("profiles").select("id, display_name").in("id", otherIds);
      for (const p of profiles || []) names[p.id] = p.display_name;
    }

    const accepted = [], incoming = [], outgoing = [];
    for (const r of rows) {
      const other = r.requester === this.uid ? r.addressee : r.requester;
      const entry = { id: r.id, uid: other, name: names[other] || "unknown" };
      if (r.status === "accepted") accepted.push(entry);
      else if (r.status === "pending" && r.addressee === this.uid) incoming.push(entry);
      else if (r.status === "pending") outgoing.push(entry);
    }
    return { accepted, incoming, outgoing };
  }

  async loadKeywords() {
    const { data } = await this.db.from("keywords").select("term, aliases, zone_id, intent");
    return data || [];
  }
}
