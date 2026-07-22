/*
 * Route planning over the walkable graph defined in map_model.json.
 * A* across floors: horizontal edges cost their length; vertical connectors
 * cost an effort-weighted equivalent distance.
 *
 * Vertical circulation is grouped into three "cores" (map_model connectors
 * carry a `core` tag): the central stairs/escalator, the stairs by the
 * elevator, and the elevator itself. A route uses exactly one core, so the
 * three profiles are:
 *   central  - all floor changes on the central stairs/escalator
 *   west     - all floor changes on the stairs beside the elevator
 *   elevator - step-free, elevator only (blind / wheelchair users)
 */

const CONNECTOR_COST = {
  escalator: (storeys) => 14 * storeys,
  stairs: (storeys) => 18 * storeys,
  elevator: (storeys) => 28 + 5 * storeys, // includes average wait
};

const PROFILE_CORES = {
  central: new Set(["central"]),
  west: new Set(["west"]),
  elevator: new Set(["elevator"]),
};

export class Navigator {
  constructor(model) {
    this.model = model;
    this.floorZ = Object.fromEntries(model.site.floors.map((f) => [String(f.level), f.z]));
    this.zones = {};
    for (const [level, floor] of Object.entries(model.floors)) {
      for (const z of floor.zones) this.zones[z.id] = { ...z, floor: level };
    }
    this.graphs = {
      central: this._buildGraph(PROFILE_CORES.central),
      west: this._buildGraph(PROFILE_CORES.west),
      elevator: this._buildGraph(PROFILE_CORES.elevator),
    };
    // legacy aliases so older callers keep working
    this.graphs.normal = this.graphs.central;
    this.graphs.accessible = this.graphs.elevator;
  }

  _buildGraph(allowedCores) {
    const nodes = new Map(); // key "level:id" -> {x,y,level,id,kind}
    const adj = new Map();   // key -> [{to, cost, via}]
    const addEdge = (a, b, cost, via = null) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ to: b, cost, via });
      adj.get(b).push({ to: a, cost, via });
    };

    for (const [level, floor] of Object.entries(this.model.floors)) {
      for (const n of floor.nodes) {
        nodes.set(`${level}:${n.id}`, { ...n, level });
      }
      for (const [a, b] of floor.edges) {
        const na = nodes.get(`${level}:${a}`);
        const nb = nodes.get(`${level}:${b}`);
        addEdge(`${level}:${a}`, `${level}:${b}`, Math.hypot(na.x - nb.x, na.y - nb.y));
      }
    }
    for (const conn of this.model.connectors) {
      // a connector's `core` (falling back to accessibility) selects the profile
      const core = conn.core || (conn.accessible ? "elevator" : "central");
      if (!allowedCores.has(core)) continue;
      for (const link of conn.links) {
        const a = `${link.from[0]}:${link.from[1]}`;
        const b = `${link.to[0]}:${link.to[1]}`;
        addEdge(a, b, CONNECTOR_COST[conn.kind](link.storeys), conn.kind);
      }
    }
    return { nodes, adj };
  }

  nearestNode(level, x, y) {
    const floor = this.model.floors[level];
    let best = null;
    let bestD = Infinity;
    for (const n of floor.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return { node: best, dist: bestD };
  }

  /**
   * Plan a route.
   * @param start  {floor, x, y}
   * @param target zone id string, or {floor, x, y} for free targets (friends)
   * @param profile "normal" | "accessible"
   * @returns {points, instructions, totalM, etaS, targetName} or null
   */
  route(start, target, profile = "normal") {
    const { nodes, adj } = this.graphs[profile];

    let goalKey, goalPoint, targetName;
    if (typeof target === "string") {
      const zone = this.zones[target];
      if (!zone) return null;
      goalKey = `${zone.floor}:${zone.node}`;
      const gn = nodes.get(goalKey);
      goalPoint = { floor: zone.floor, x: gn.x, y: gn.y };
      targetName = zone.name;
    } else {
      const near = this.nearestNode(String(target.floor), target.x, target.y);
      goalKey = `${target.floor}:${near.node.id}`;
      goalPoint = { floor: String(target.floor), x: target.x, y: target.y };
      targetName = target.name || "destination";
    }

    const startNear = this.nearestNode(String(start.floor), start.x, start.y);
    const startKey = `${start.floor}:${startNear.node.id}`;
    const goalNode = nodes.get(goalKey);

    // ---- A*
    const h = (key) => {
      const n = nodes.get(key);
      return Math.hypot(n.x - goalNode.x, n.y - goalNode.y) +
             Math.abs(this.floorZ[n.level] - this.floorZ[goalNode.level]) * 4;
    };
    const open = new Map([[startKey, h(startKey)]]);
    const g = new Map([[startKey, 0]]);
    const came = new Map();
    const cameVia = new Map();

    while (open.size) {
      let current = null, best = Infinity;
      for (const [k, f] of open) if (f < best) { best = f; current = k; }
      if (current === goalKey) break;
      open.delete(current);
      for (const edge of adj.get(current) || []) {
        const tentative = g.get(current) + edge.cost;
        if (tentative < (g.get(edge.to) ?? Infinity)) {
          g.set(edge.to, tentative);
          came.set(edge.to, current);
          cameVia.set(edge.to, edge.via);
          open.set(edge.to, tentative + h(edge.to));
        }
      }
    }
    if (!came.has(goalKey) && startKey !== goalKey) return null;

    // ---- reconstruct
    const keys = [goalKey];
    while (keys[0] !== startKey) keys.unshift(came.get(keys[0]));

    const points = [{ floor: String(start.floor), x: start.x, y: start.y, via: null }];
    for (const k of keys) {
      const n = nodes.get(k);
      points.push({ floor: n.level, x: n.x, y: n.y, via: cameVia.get(k) || null, kind: n.kind });
    }
    if (typeof target !== "string") points.push({ ...goalPoint, via: null });

    return {
      points,
      targetName,
      ...this._annotate(points, targetName),
    };
  }

  /** Turn the polyline into distances + spoken/visual instructions. */
  _annotate(points, targetName) {
    const instructions = [];
    let totalM = 0;
    let walkM = 0;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.floor !== b.floor) {
        const up = this.floorZ[b.floor] > this.floorZ[a.floor];
        const kind = b.via || "stairs";
        instructions.push({
          at: i - 1,
          type: "floor",
          text: `Take the ${kind} ${up ? "up" : "down"} to floor ${b.floor}`,
          point: a,
        });
        totalM += CONNECTOR_COST[kind] ? CONNECTOR_COST[kind](1) : 15;
        continue;
      }
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      totalM += d;
      walkM += d;

      if (i < points.length - 1 && points[i + 1].floor === b.floor) {
        const c = points[i + 1];
        const turn = this._turn(a, b, c);
        if (turn) {
          instructions.push({
            at: i,
            type: "turn",
            text: `Turn ${turn} in ${Math.round(d)} meters`,
            short: `Turn ${turn}`,
            point: b,
          });
        }
      }
    }
    instructions.push({
      at: points.length - 1,
      type: "arrive",
      text: `You have arrived at ${targetName}`,
      point: points[points.length - 1],
    });
    const etaS = Math.round(walkM / (this.model.site.walkSpeed || 1.2) + (totalM - walkM));
    return { instructions, totalM: Math.round(totalM), etaS };
  }

  _turn(a, b, c) {
    const v1 = [b.x - a.x, b.y - a.y];
    const v2 = [c.x - b.x, c.y - b.y];
    const ang = Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
    const deg = (ang * 180) / Math.PI;
    // y grows "south" in map space, so positive cross = clockwise = right turn
    if (deg > 35) return "right";
    if (deg < -35) return "left";
    return null;
  }

  /** Among candidate zone ids, pick the one with the cheapest route cost. */
  nearest(start, zoneIds, profile = "normal") {
    let best = null;
    for (const id of zoneIds) {
      const r = this.route(start, id, profile);
      if (r && (!best || r.totalM < best.route.totalM)) best = { id, route: r };
    }
    return best;
  }

  /** Distance from a live position to the route polyline (same floor only). */
  static offRouteDistance(route, pos) {
    let best = Infinity;
    const pts = route.points;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1].floor !== String(pos.floor) || pts[i].floor !== String(pos.floor)) continue;
      const d = distToSegment(pos.x, pos.y, pts[i - 1], pts[i]);
      if (d < best) best = d;
    }
    return best;
  }
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
