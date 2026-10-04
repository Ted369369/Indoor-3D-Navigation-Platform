/*
 * Three.js scene: the library's floors as cut-away 3D plans, live markers for
 * you and your friends, and the route line.
 *
 * Map space:   x metres west->east, y metres from the top of the drawing down,
 *              floor heights from the model's site.floors[].z.
 * World space: X = x - width/2, Y = height, Z = y - depth/2.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { categoryOf, iconOf, AMENITY_KINDS } from "./categories.js?v=ft1";
import { iconPath } from "./icons.js?v=ft1";

const EXPLODE_FACTOR = 2.4;   // default vertical spacing multiplier in the all-floors view
const SLAB = 0.3;             // floor plate thickness
const OUTER_WALL = 1.5;       // cut-away height of the building's outside wall
const ROOM_WALL = 0.75;       // cut-away height of the walls around each room
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans TC", "Microsoft JhengHei", sans-serif';

// colours that change with the light and dark themes
const PALETTE = {
  light: {
    slab: 0xfbfbfc, outer: 0xc3cad2, wall: 0xdde2e8, zoneBase: null,
    pill: "#ffffff", pillText: "#1f2328", shadow: "rgba(20, 30, 45, 0.22)",
    sky: 0xffffff, ground: 0xd5dbe1, hemi: 1.55, sun: 0.85,
  },
  dark: {
    slab: 0x2b3139, outer: 0x4a535e, wall: 0x3a424c, zoneBase: "#2e343c",
    pill: "#262c33", pillText: "#e7eaee", shadow: "rgba(0, 0, 0, 0.55)",
    sky: 0xffffff, ground: 0x3a4048, hemi: 1.25, sun: 0.6,
  },
};

export class MapScene {
  /**
   * opts: onZoneClick, dark, accent, uiScale, labelMode ("names" | "icons" | "off"),
   * reduceMotion, viewMode ("3d" | "2d"), showAccuracy, showFriends,
   * floorSpacing (multiplier), quality ("saver" | "balanced" | "sharp"), followSelf
   */
  constructor(container, model, opts = {}) {
    this.model = model;
    this.onZoneClick = opts.onZoneClick;
    this.W = model.site.width;
    this.D = model.site.depth;
    this.floorZ = Object.fromEntries(model.site.floors.map((f) => [String(f.level), f.z]));
    this.exploded = false;
    this.focusLevel = "all";
    this.followSelf = opts.followSelf !== false;
    this.dark = !!opts.dark;
    this.accent = opts.accent || "#1a66d2";
    this.uiScale = opts.uiScale || 1;
    this.labelMode = opts.labelMode || "names";
    this.reduceMotion = !!opts.reduceMotion;
    this.viewMode = opts.viewMode || "3d";
    this.showAccuracy = opts.showAccuracy !== false;
    this.showFriends = opts.showFriends !== false;
    this.explodeFactor = opts.floorSpacing || EXPLODE_FACTOR;
    this.quality = opts.quality || "balanced";
    this.slabMats = [];
    this.outerMats = [];
    this.wallMats = [];

    this.markers = new Map();   // uid -> {group, target, self, pos, ...}
    this.zoneMeshes = new Map();
    this.labelSprites = [];
    this.pathGroup = null;
    this.pathRuns = [];
    this.pathSigns = [];
    this.lineMaterials = [];
    this.highlightId = null;

    this._initRenderer(container);
    this._buildFloors();
    this._animate();
  }

  /* ------------------------------------------------ setup ---------------- */
  _initRenderer(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.pixelRatio = this._pixelCap();
    this.frameInterval = this.quality === "saver" ? 1000 / 30 : 0;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      42, container.clientWidth / container.clientHeight, 0.5, 1200
    );
    // framing was tuned on a 50 x 35 m building; scale it for other footprints
    this.span = Math.max(1, Math.max(this.W / 50, this.D / 35)) ** 0.85;
    this.camera.position.set(0, 58 * this.span, 50 * this.span);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.44;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 190 * this.span;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("start", () => { this._camTween = null; });
    this._applyControls();

    const pal = this._pal();
    this.hemi = new THREE.HemisphereLight(pal.sky, pal.ground, pal.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, pal.sun);
    this.sun.position.set(-30, 80, 45);
    this.scene.add(this.sun);

    // Resize handling: ResizeObserver where it works, window events as backup,
    // and a per-frame check in the render loop (some embedded browsers never
    // fire ResizeObserver callbacks).
    this._viewW = 0;
    this._viewH = 0;
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this._resize()).observe(container);
    }
    addEventListener("resize", () => this._resize());
    this._resize();

    // zone picking (click without drag)
    const ray = new THREE.Raycaster();
    let downAt = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      downAt = [e.clientX, e.clientY];
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      ray.setFromCamera(ndc, this.camera);
      if (this._pickFn) {
        // marking a spot: any point on the floor that's showing, not a room
        if (this.focusLevel === "all") return;
        const level = this.focusLevel;
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.displayY(level, 0.06));
        const at = new THREE.Vector3();
        if (!ray.ray.intersectPlane(plane, at)) return;
        const fn = this._pickFn;
        this.cancelPick();
        fn({ x: at.x + this.W / 2, y: at.z + this.D / 2, floor: Number(level) });
        return;
      }
      const meshes = [...this.zoneMeshes.values()].filter((m) => this._floorVisible(m.userData.level));
      const hit = ray.intersectObjects(meshes)[0];
      if (hit) this.onZoneClick?.(hit.object.userData.zoneId);
    });
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h || (w === this._viewW && h === this._viewH)) return;
    this._viewW = w;
    this._viewH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this._applyViewOffset();
    for (const sprite of this.labelSprites) this._sizeSprite(sprite);
    for (const m of this.markers.values()) m.sprites?.forEach((s) => this._sizeSprite(s));
    for (const s of this.pathSigns || []) this._sizeSprite(s);
    for (const m of this.lineMaterials || []) m.resolution.set(w, h);
    if (this.pin) this._sizeSprite(this.pin);
    if (this.mark) this._sizeSprite(this.mark);
  }

  /** The next tap on the map calls fn({x, y, floor}) instead of opening a room. */
  pickPoint(fn) {
    this._pickFn = fn;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  cancelPick() {
    this._pickFn = null;
    this.renderer.domElement.style.cursor = "";
  }

  _shapeFrom(poly) {
    const s = new THREE.Shape();
    s.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) s.lineTo(poly[i][0], poly[i][1]);
    s.closePath();
    return s;
  }

  /** Horizontal extrusion helper: shape in map XY -> geometry lying flat. */
  _flatGeometry(poly, depth) {
    const geo = new THREE.ExtrudeGeometry(this._shapeFrom(poly), { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); // shape now in XZ plane, extrusion downward
    geo.translate(-this.W / 2, depth, -this.D / 2);
    return geo;
  }

  /** Thin wall boxes along every edge of a polygon, merged into one geometry. */
  _wallGeometry(poly, height, thickness, base) {
    const parts = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const box = new THREE.BoxGeometry(len + thickness, height, thickness);
      box.rotateY(-Math.atan2(by - ay, bx - ax));
      box.translate((ax + bx) / 2 - this.W / 2, base + height / 2, (ay + by) / 2 - this.D / 2);
      parts.push(box);
    }
    return parts.length ? mergeGeometries(parts) : null;
  }

  _buildFloors() {
    this.floorGroups = {};
    const pal = this._pal();
    const slabMat = () => {
      const m = new THREE.MeshLambertMaterial({ color: pal.slab, transparent: true, opacity: 1 });
      this.slabMats.push(m);
      return m;
    };
    for (const [level, floor] of Object.entries(this.model.floors)) {
      const group = new THREE.Group();
      group.userData.level = level;
      this.floorGroups[level] = group;
      this.scene.add(group);

      // floor plate
      const slab = new THREE.Mesh(this._flatGeometry(floor.outline, SLAB), slabMat());
      slab.position.y = -SLAB;
      slab.userData.baseOpacity = 1;
      slab.userData.part = "slab";
      group.add(slab);

      // outside wall, cut away low so you can see in
      const outer = this._wallGeometry(floor.outline, OUTER_WALL, 0.35, 0);
      if (outer) {
        const mat = new THREE.MeshLambertMaterial({ color: pal.outer, transparent: true, opacity: 1 });
        this.outerMats.push(mat);
        const mesh = new THREE.Mesh(outer, mat);
        mesh.userData.baseOpacity = 1;
        group.add(mesh);
      }

      const roomWalls = [];
      for (const zone of floor.zones) {
        const cat = categoryOf(zone);
        const outdoor = zone.kind === "outdoor";
        const mat = new THREE.MeshLambertMaterial({
          color: this._zoneFill(cat),
          emissive: new THREE.Color(cat.color),
          emissiveIntensity: 0,
          transparent: true,
          opacity: 1,
        });
        const mesh = new THREE.Mesh(this._flatGeometry(zone.poly, 0.04), mat);
        // amenities often sit inside a bigger room; lift them a touch so the
        // two surfaces don't flicker against each other
        mesh.position.y = AMENITY_KINDS.has(zone.kind) ? 0.03 : 0.01;
        mesh.userData = { zoneId: zone.id, level, baseOpacity: 1, cat };
        this.zoneMeshes.set(zone.id, mesh);
        group.add(mesh);

        if (!outdoor) {
          const w = this._wallGeometry(zone.poly, ROOM_WALL, 0.12, 0);
          if (w) roomWalls.push(w);
        }
        if (!zone.noLabel) this._addLabels(group, zone);
      }
      if (roomWalls.length) {
        const wallMat = new THREE.MeshLambertMaterial({ color: pal.wall, transparent: true, opacity: 1 });
        this.wallMats.push(wallMat);
        const walls = new THREE.Mesh(mergeGeometries(roomWalls), wallMat);
        walls.userData.baseOpacity = 1;
        group.add(walls);
      }
    }
    this._applyFloorLayout();
    this._frame(false);
  }

  /* ------------------------------------------------ settings ------------- */
  _pal() {
    return this.dark ? PALETTE.dark : PALETTE.light;
  }

  /** The accent, a little lighter on the dark map so it stands out. */
  _accentColor() {
    const c = new THREE.Color(this.accent);
    return this.dark ? c.lerp(new THREE.Color(0xffffff), 0.2) : c;
  }

  _zoneFill(cat) {
    const base = this._pal().zoneBase;
    return base ? new THREE.Color(base).lerp(new THREE.Color(cat.color), 0.3) : new THREE.Color(cat.fill);
  }

  _pixelCap() {
    const dpr = window.devicePixelRatio || 1;
    return this.quality === "saver" ? 1 : this.quality === "sharp" ? Math.min(dpr, 2) : Math.min(dpr, 1.5);
  }

  _labelShown(when, single) {
    if (this.labelMode === "off") return false;
    if (this.labelMode === "icons") return when !== "floor";
    return when === "both" || (when === "floor") === single;
  }

  /** 3D: drag to turn the map. 2D: straight down, drag to move it like a paper map. */
  _applyControls() {
    const flat = this.viewMode === "2d";
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = flat ? 0.03 : Math.PI * 0.44;
    this.controls.touches = {
      ONE: flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE,
      TWO: flat ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.mouseButtons = {
      LEFT: flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: flat ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
    };
  }

  setTheme(dark) {
    if (this.dark === !!dark) return;
    this.dark = !!dark;
    const pal = this._pal();
    for (const m of this.slabMats) m.color.set(pal.slab);
    for (const m of this.outerMats) m.color.set(pal.outer);
    for (const m of this.wallMats) m.color.set(pal.wall);
    for (const mesh of this.zoneMeshes.values()) mesh.material.color.copy(this._zoneFill(mesh.userData.cat));
    this.hemi.groundColor.set(pal.ground);
    this.hemi.intensity = pal.hemi;
    this.sun.intensity = pal.sun;
    this._rebuildLabels();
    this._rebuildMarkers();
    if (this.activeRoutePoints) this._buildPathMesh(this.activeRoutePoints);
  }

  setAccent(hex) {
    if (this.accent === hex) return;
    this.accent = hex;
    this._rebuildMarkers();
    if (this.activeRoutePoints) this._buildPathMesh(this.activeRoutePoints);
  }

  /** Size of labels, markers and signs, following the app's text size. */
  setUiScale(k) {
    this.uiScale = k;
    for (const s of this.labelSprites) this._sizeSprite(s);
    for (const m of this.markers.values()) m.sprites?.forEach((s) => this._sizeSprite(s));
    for (const s of this.pathSigns || []) this._sizeSprite(s);
    if (this.pin) this._sizeSprite(this.pin);
    this._labelsDirty = true;
  }

  setLabelMode(mode) {
    this.labelMode = mode;
    this._applyVisibility();
  }

  setReduceMotion(on) {
    this.reduceMotion = !!on;
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this._applyControls();
    if (this.padding) this.fitView();
  }

  setShowAccuracy(on) {
    this.showAccuracy = !!on;
  }

  setShowFriends(on) {
    this.showFriends = !!on;
    this._applyVisibility();
  }

  setFloorSpacing(k) {
    this.explodeFactor = k;
    if (!this.exploded) return;
    this._applyFloorLayout();
    this._applyVisibility();
    if (this.padding) this.fitView();
  }

  setQuality(q) {
    this.quality = q;
    this.pixelRatio = this._pixelCap();
    this.frameInterval = q === "saver" ? 1000 / 30 : 0;
    this.renderer.setPixelRatio(this.pixelRatio);
    if (this._viewW) this.renderer.setSize(this._viewW, this._viewH);
  }

  _rebuildLabels() {
    for (const s of this.labelSprites) {
      s.parent?.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.labelSprites = [];
    for (const [level, floor] of Object.entries(this.model.floors)) {
      for (const zone of floor.zones) {
        if (!zone.noLabel) this._addLabels(this.floorGroups[level], zone);
      }
    }
    this._applyVisibility();
    // start new labels at their settled state instead of flashing in and out
    this._resolveLabelCollisions();
    for (const s of this.labelSprites) {
      s.material.opacity = s.userData.fade;
      s.material.visible = s.userData.fade > 0;
    }
  }

  _rebuildMarkers() {
    for (const [uid, m] of [...this.markers]) {
      const at = m.group.position.clone();
      this.removeMarker(uid);
      if (!m.pos) continue;
      this.updateMarker(uid, m.pos, { self: m.self, name: m.name });
      this.markers.get(uid).group.position.copy(at);
    }
  }

  /* ------------------------------------------------ labels --------------- */
  _addLabels(group, zone) {
    const c = centroid(zone.poly);
    const amenity = AMENITY_KINDS.has(zone.kind);
    const area = polyArea(zone.poly);
    // overview: icon badge only; single floor: badge + name (amenities stay icons)
    const kinds = amenity ? [["badge", "both"]] : [["badge", "overview"], ["pill", "floor"]];
    for (const [look, when] of kinds) {
      const sprite = look === "pill" ? this._pillSprite(zone) : this._badgeSprite(zone);
      sprite.position.set(c[0] - this.W / 2, ROOM_WALL + 0.9, c[1] - this.D / 2);
      sprite.userData.when = when;
      sprite.userData.zoneId = zone.id;
      // bigger rooms win when labels overlap; amenities give way to names
      sprite.userData.priority = (amenity ? 0 : 1000) + area;
      sprite.userData.fade = 1;
      group.add(sprite);
      this.labelSprites.push(sprite);
    }
  }

  _canvas(w, h) {
    const S = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const cvs = document.createElement("canvas");
    cvs.width = Math.ceil(w * S);
    cvs.height = Math.ceil(h * S);
    const ctx = cvs.getContext("2d");
    ctx.scale(S, S);
    return { cvs, ctx };
  }

  _drawIcon(ctx, name, cx, cy, size, color) {
    const p = iconPath(name, true);
    if (!p) return;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 960, size / 960);
    ctx.translate(0, 960);
    ctx.fillStyle = color;
    ctx.fill(p);
    ctx.restore();
  }

  /** Round coloured badge with the place's symbol. */
  _badgeSprite(zone) {
    const cat = categoryOf(zone);
    const size = 30;
    const pal = this._pal();
    const { cvs, ctx } = this._canvas(size, size);
    ctx.shadowColor = pal.shadow;
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = pal.pill;
    ctx.beginPath(); ctx.arc(15, 15, 12, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = cat.color;
    ctx.beginPath(); ctx.arc(15, 15, 10, 0, Math.PI * 2); ctx.fill();
    this._drawIcon(ctx, iconOf(zone), 15, 15, 13, "#ffffff");
    return this._sprite(cvs, size, size);
  }

  /** White rounded label: badge + name, like a map POI. */
  _pillSprite(zone) {
    const cat = categoryOf(zone);
    const font = `600 12.5px ${FONT}`;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font;
    let name = zone.short || zone.name;
    const maxText = 132;
    if (measure.measureText(name).width > maxText) {
      while (name.length > 3 && measure.measureText(name + "…").width > maxText) name = name.slice(0, -1);
      name = name.trimEnd() + "…";
    }
    const textW = Math.ceil(measure.measureText(name).width);
    const W = 6 + 20 + 6 + textW + 10, H = 32, pad = 3;
    const pal = this._pal();
    const { cvs, ctx } = this._canvas(W + pad * 2, H + pad * 2);
    ctx.translate(pad, pad);
    ctx.shadowColor = pal.shadow;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = pal.pill;
    roundRect(ctx, 0, 3, W, H - 6, (H - 6) / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = cat.color;
    ctx.beginPath(); ctx.arc(6 + 10, H / 2, 10, 0, Math.PI * 2); ctx.fill();
    this._drawIcon(ctx, iconOf(zone), 16, H / 2, 13, "#ffffff");
    ctx.font = font;
    ctx.fillStyle = pal.pillText;
    ctx.textBaseline = "middle";
    ctx.fillText(name, 6 + 20 + 6, H / 2 + 0.5);
    return this._sprite(cvs, W + pad * 2, H + pad * 2);
  }

  /** Sprite that keeps a fixed on-screen size (CSS px) at any zoom. */
  _sprite(cvs, w, h, { onTop = false } = {}) {
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: !onTop, sizeAttenuation: false,
    }));
    sprite.renderOrder = onTop ? 20 : 10;
    sprite.userData.px = [w, h];
    this._sizeSprite(sprite);
    return sprite;
  }

  _sizeSprite(sprite) {
    if (!this._viewH) return;
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this._viewH * this.uiScale;
    const [w, h] = sprite.userData.px;
    sprite.scale.set(w * k, h * k, 1);
  }

  /** Hide labels that would overlap a more important one (runs a few times a second). */
  _resolveLabelCollisions() {
    const W = this._viewW, H = this._viewH;
    if (!W) return;
    const v = new THREE.Vector3();
    const placed = [];
    const candidates = [];
    for (const s of this.labelSprites) {
      if (!s.visible || !s.parent?.visible) { s.userData.fade = 0; continue; }
      s.getWorldPosition(v).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { s.userData.fade = 0; continue; }
      const w = s.userData.px[0] * this.uiScale, h = s.userData.px[1] * this.uiScale;
      const cx = (v.x + 1) / 2 * W, cy = (1 - v.y) / 2 * H;
      candidates.push({ s, x0: cx - w / 2 + 3, x1: cx + w / 2 - 3, y0: cy - h / 2 + 5, y1: cy + h / 2 - 5 });
    }
    const blockers = [...(this.pathSigns || []).filter((s) => !s.userData.px || s.userData.px[0] > 10)];
    if (this.pin?.visible) blockers.push(this.pin);
    for (const b of blockers) {
      if (!b.visible || !b.parent?.visible) continue;
      b.getWorldPosition(v).project(this.camera);
      const w = b.userData.px[0] * this.uiScale, h = b.userData.px[1] * this.uiScale;
      const cx = (v.x + 1) / 2 * W, cy = (1 - v.y) / 2 * H;
      // signs and the pin hang above their anchor point
      placed.push({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h, y1: cy });
    }
    candidates.sort((a, b) => b.s.userData.priority - a.s.userData.priority);
    const dim = this.activeRoutePoints ? 0.55 : 1;
    for (const c of candidates) {
      const hit = placed.some((p) => c.x0 < p.x1 && c.x1 > p.x0 && c.y0 < p.y1 && c.y1 > p.y0);
      const target = c.s.userData.zoneId === this.highlightId ? 1 : dim;
      c.s.userData.fade = hit ? 0 : target;
      if (!hit) placed.push(c);
    }
  }

  /* ------------------------------------------- layout & focus ------------ */
  displayY(level, offset = 0) {
    const z = this.floorZ[String(level)];
    return (this.exploded ? z * this.explodeFactor : z) + offset;
  }

  _applyFloorLayout() {
    for (const [level, group] of Object.entries(this.floorGroups)) {
      group.position.y = this.displayY(level);
    }
    for (const marker of this.markers.values()) {
      if (marker.pos) marker.target.copy(this._markerWorld(marker.pos));
    }
    if (this.activeRoutePoints) this._buildPathMesh(this.activeRoutePoints);
    if (this.pinPoint) this._placePin(this.pinPoint);
    if (this.markPoint) this.setMark(this.markPoint);
  }

  /** A ringed dot where the tester says they are standing; null removes it. */
  setMark(point) {
    this.markPoint = point;
    if (!point) {
      if (this.mark) this.mark.visible = false;
      return;
    }
    if (!this.mark) {
      const S = 26;
      const { cvs, ctx } = this._canvas(S, S);
      ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
      ctx.shadowBlur = 3;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(13, 13, 10, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "#1f242b";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(13, 13, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#1f242b";
      ctx.beginPath(); ctx.arc(13, 13, 3, 0, Math.PI * 2); ctx.fill();
      this.mark = this._sprite(cvs, S, S, { onTop: true });
      this.scene.add(this.mark);
    }
    this.mark.position.set(point.x - this.W / 2, this.displayY(point.floor, 0.3), point.y - this.D / 2);
    this.mark.visible = this._floorVisible(point.floor);
  }

  setExploded(on) {
    this.exploded = on;
    this._applyFloorLayout();
    this._applyVisibility();
    if (this.padding) this.fitView(); else this._frame();
  }

  setFloorFocus(level) {
    const was = this.focusLevel;
    this.focusLevel = level; // "all" or a level like "3"
    this._applyVisibility();
    // going to or from the whole stack needs a different distance; between
    // single floors just slide up or down and keep the user's zoom
    if (level === "all" || was === "all") {
      if (this.padding) this.fitView();
    } else {
      this._frame();
    }
  }

  /** Screen space (px) covered by the app's panels; the map centres itself in the rest. */
  setViewPadding({ top = 0, bottom = 0, left = 0 } = {}) {
    const first = !this.padding;
    this.padding = { top, bottom, left };
    this._applyViewOffset();
    if (first) this.fitView(false);
  }

  _applyViewOffset() {
    const { top = 0, bottom = 0, left = 0 } = this.padding || {};
    if (!this._viewW) return;
    // shift the projection centre into the middle of the uncovered area
    this.camera.setViewOffset(this._viewW, this._viewH, -left / 2, (bottom - top) / 2, this._viewW, this._viewH);
    this.camera.updateProjectionMatrix();
  }

  /** Move the camera back far enough that the whole footprint fits the free area. */
  fitView(animate = true) {
    const { top = 0, bottom = 0, left = 0 } = this.padding || {};
    const freeW = Math.max(120, this._viewW - left);
    const freeH = Math.max(120, this._viewH - top - bottom);
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanV = (t * freeH) / this._viewH;
    const tanH = (t * freeW) / this._viewH;
    // a lower angle for the whole stack, so the floors separate on screen
    // straight down in the flat view (a hair off, so the controls keep their heading)
    const elevation = this.viewMode === "2d" ? THREE.MathUtils.degToRad(89)
      : this.focusLevel === "all" ? THREE.MathUtils.degToRad(30) : Math.atan2(58, 50);
    // on a tall screen, look along the building's long side so it fills the height
    const turn = freeH / freeW > 1.15 && this.W / this.D > 1.25;
    const across = turn ? this.D : this.W;
    const along = turn ? this.W : this.D;
    const dir = turn
      ? new THREE.Vector3(Math.cos(elevation), Math.sin(elevation), 0)
      : new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    const halfW = (across / 2) * 1.06 + 1;
    // with every floor showing, the stack's height takes up screen space too
    let stack = 0;
    let midY = this.controls.target.y;
    if (this.focusLevel === "all") {
      const ys = Object.keys(this.floorZ).map((l) => this.displayY(l));
      stack = Math.max(...ys) - Math.min(...ys);
      midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    }
    const halfD = (along / 2) * Math.sin(elevation) * 1.06 + OUTER_WALL + (stack / 2) * Math.cos(elevation);
    const dist = Math.min(this.controls.maxDistance, Math.max(halfW / tanH, halfD / tanV) + (along / 2) * Math.cos(elevation));
    const target = new THREE.Vector3(0, midY, 0);
    const pos = target.clone().add(dir.multiplyScalar(dist));
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
      return;
    }
    this._camTween = { target, position: pos, start: performance.now() };
  }

  /** Aim the camera at the focused floor (or the middle of the stack). */
  _frame(animate = true) {
    const levels = Object.keys(this.floorZ);
    let y;
    if (this.focusLevel === "all") {
      const ys = levels.map((l) => this.displayY(l));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    } else {
      y = this.displayY(this.focusLevel);
    }
    const t = this.controls.target;
    const target = new THREE.Vector3(t.x, y, t.z);
    if (!animate) {
      this.camera.position.y += y - t.y;
      t.copy(target);
      return;
    }
    this._camTween = { target, start: performance.now() };
  }

  /** Restrict the view to the floors an active route crosses (Set), or null. */
  setRouteFloors(floors) {
    this.routeFloors = floors && floors.size ? floors : null;
    this._applyVisibility();
  }

  /** Which floors are currently shown: a Set of levels, or null = every floor. */
  _visibleSet() {
    if (this.routeFloors) {
      // during navigation, show only the floors the route passes through;
      // a manual floor pick narrows further if it is on the route
      if (this.focusLevel !== "all" && this.routeFloors.has(this.focusLevel)) {
        return new Set([this.focusLevel]);
      }
      return this.routeFloors;
    }
    return this.focusLevel === "all" ? null : new Set([this.focusLevel]);
  }

  _floorVisible(level) {
    const set = this._visibleSet();
    return !set || set.has(String(level));
  }

  /** Hide floors outside the visible set; see through stacked floors on a route. */
  _applyVisibility() {
    const set = this._visibleSet();
    const shown = set ? set.size : Object.keys(this.floorGroups).length;
    const stacked = shown > 1;
    const opacityScale = this.routeFloors && stacked ? 0.5 : 1.0;
    const single = shown === 1;
    for (const [lvl, group] of Object.entries(this.floorGroups)) {
      const show = !set || set.has(lvl);
      group.visible = show;
      if (!show) continue;
      group.traverse((obj) => {
        const when = obj.userData?.when;
        if (when) obj.visible = this._labelShown(when, single);
        const mat = obj.material;
        if (mat && obj.userData?.baseOpacity !== undefined) {
          mat.opacity = obj.userData.baseOpacity * opacityScale;
          mat.depthWrite = opacityScale === 1;
        }
      });
    }
    for (const m of this.markers.values()) {
      if (m.pos) m.group.visible = (m.self || this.showFriends) && (!set || set.has(String(m.pos.floor)));
    }
    if (this.pin) this.pin.visible = !!this.pinPoint && this._floorVisible(this.pinPoint.floor);
    if (this.mark) this.mark.visible = !!this.markPoint && this._floorVisible(this.markPoint.floor);
    this._applyPathVisibility();
    this._labelsDirty = true;
  }

  /* ------------------------------------------------ markers -------------- */
  _markerWorld(pos) {
    return new THREE.Vector3(
      pos.x - this.W / 2,
      this.displayY(pos.floor, 0.06),
      pos.y - this.D / 2
    );
  }

  updateMarker(uid, pos, { self = false, name = "" } = {}) {
    let m = this.markers.get(uid);
    if (!m) {
      m = self ? this._makeSelfMarker() : this._makeFriendMarker(name);
      this.markers.set(uid, m);
      this.scene.add(m.group);
    }
    m.pos = pos;
    m.name = name || m.name;
    m.target.copy(this._markerWorld(pos));
    m.group.visible = (self || this.showFriends) && this._floorVisible(pos.floor);
    if (m.halo) {
      const acc = Math.min(18, Math.max(2, pos.q?.gpsAcc ?? 6));
      m.haloTarget = acc;
    }
  }

  _makeSelfMarker() {
    const group = new THREE.Group();
    const accent = this._accentColor();
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.13, depthWrite: false })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = 5;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 64),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 5;
    const { cvs, ctx } = this._canvas(30, 30);
    ctx.shadowColor = "rgba(20, 40, 80, 0.35)";
    ctx.shadowBlur = 5;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(15, 15, 10, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#" + accent.getHexString(THREE.SRGBColorSpace);
    ctx.beginPath(); ctx.arc(15, 15, 7, 0, Math.PI * 2); ctx.fill();
    const dot = this._sprite(cvs, 30, 30, { onTop: true });
    dot.position.y = 0.6;
    group.add(halo, ring, dot);
    return { group, halo, ring, sprites: [dot], target: new THREE.Vector3(), self: true, haloSize: 5, haloTarget: 5 };
  }

  _makeFriendMarker(name) {
    const group = new THREE.Group();
    const palette = ["#7650b8", "#c35a2a", "#2c8752", "#b8456d", "#1b827c", "#3a6cc2"];
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const color = palette[hash % palette.length];
    const font = `600 12px ${FONT}`;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font;
    const label = name.slice(0, 16);
    const W = 4 + 24 + 6 + Math.ceil(measure.measureText(label).width) + 10, H = 32;
    const pal = this._pal();
    const { cvs, ctx } = this._canvas(W + 6, H + 6);
    ctx.translate(3, 3);
    ctx.shadowColor = pal.shadow;
    ctx.shadowBlur = 5;
    ctx.fillStyle = pal.pill;
    roundRect(ctx, 0, 2, W, H - 4, (H - 4) / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(4 + 12, H / 2, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((name.trim()[0] || "?").toUpperCase(), 16, H / 2 + 0.5);
    ctx.textAlign = "left";
    ctx.font = font;
    ctx.fillStyle = pal.pillText;
    ctx.fillText(label, 4 + 24 + 6, H / 2 + 0.5);
    const tag = this._sprite(cvs, W + 6, H + 6, { onTop: true });
    tag.center.set(16 / (W + 6), 0.5); // anchor on the avatar, name trails right
    tag.position.y = 0.8;
    group.add(tag);
    return { group, sprites: [tag], target: new THREE.Vector3(), self: false, name };
  }

  removeMarker(uid) {
    const m = this.markers.get(uid);
    if (m) {
      this.scene.remove(m.group);
      disposeTree(m.group);
      this.markers.delete(uid);
    }
  }

  /* ------------------------------------------------ path ----------------- */
  showPath(points) {
    this.activeRoutePoints = points;
    this._buildPathMesh(points);
    const end = points[points.length - 1];
    this._placePin({ floor: end.floor, x: end.x, y: end.y });
    this.setRouteFloors(new Set(points.map((p) => String(p.floor))));
  }

  _buildPathMesh(points) {
    this.clearPath(true);
    const group = new THREE.Group();

    // one line per floor; where the route changes floor, a small sign says so
    const runs = [];
    for (const p of points) {
      const last = runs[runs.length - 1];
      if (last && String(last.floor) === String(p.floor)) last.points.push(p);
      else runs.push({ floor: String(p.floor), points: [p] });
    }
    // floors the route only passes through on the stairs or lift get no sign;
    // the sign on the way in names the floor you're actually going to
    const pass = (i) => i > 0 && i < runs.length - 1 && runs[i].points.length === 1;
    runs.forEach((run, i) => {
      const part = new THREE.Group();
      part.userData.level = run.floor;
      group.add(part);
      if (pass(i)) return;
      if (run.points.length > 1) this._addRunLine(part, run.points);
      let j = i + 1;
      while (j < runs.length && pass(j)) j++;
      let k = i - 1;
      while (k >= 0 && pass(k)) k--;
      if (j < runs.length) {
        const at = run.points[run.points.length - 1];
        const up = this.floorZ[runs[j].floor] > this.floorZ[run.floor];
        part.add(this._floorSign(at, `${up ? "Up" : "Down"} to floor ${runs[j].floor}`, runs[i + 1].points[0].via, up));
      }
      if (k >= 0) {
        part.add(this._floorSign(run.points[0], `From floor ${runs[k].floor}`, run.points[0].via, null));
      }
    });

    this.pathGroup = group;
    this.scene.add(group);
    this._applyPathVisibility();
  }

  _addRunLine(part, pts) {
    const v3 = pts.map(
      (p) => new THREE.Vector3(p.x - this.W / 2, this.displayY(p.floor, 0.3), p.y - this.D / 2)
    );
    const curve = new THREE.CatmullRomCurve3(v3, false, "catmullrom", 0.05);
    const samples = curve.getSpacedPoints(Math.min(400, Math.max(8, Math.round(curve.getLength() * 2))));
    const positions = samples.flatMap((v) => [v.x, v.y, v.z]);

    // lines with a fixed width in screen pixels: white edge, blue on top
    const make = (color, width, order) => {
      const geo = new LineGeometry();
      geo.setPositions(positions);
      const mat = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
      mat.resolution.set(this._viewW, this._viewH);
      const line = new Line2(geo, mat);
      line.computeLineDistances();
      line.renderOrder = order;
      this.lineMaterials.push(mat);
      return line;
    };
    part.add(make(this.dark ? 0x1f242b : 0xffffff, 10, 6), make(this._accentColor(), 6, 7));

    const run = { curve, pulses: [], part };
    const count = Math.max(2, Math.round(curve.getLength() / 5));
    for (let i = 0; i < count; i++) {
      const pulse = this._dotSprite();
      pulse.userData.phase = i / count;
      run.pulses.push(pulse);
      part.add(pulse);
    }
    this.pathRuns.push(run);
  }

  _dotSprite() {
    if (!this._dotCanvas) {
      const { cvs, ctx } = this._canvas(8, 8);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(4, 4, 2.4, 0, Math.PI * 2); ctx.fill();
      this._dotCanvas = cvs;
    }
    const dot = this._sprite(this._dotCanvas, 8, 8, { onTop: true });
    dot.renderOrder = 8;
    this.pathSigns.push(dot); // resized with the other screen-sized sprites
    return dot;
  }

  /** Sign at a stair or lift: "Up to floor 2". */
  _floorSign(point, text, via, up) {
    const iconName = via === "elevator" ? "elevator" : via === "escalator" ? "escalator" : "stairs";
    const font = `600 12.5px ${FONT}`;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font;
    const W = 6 + 22 + 7 + Math.ceil(measure.measureText(text).width) + 12, H = 34, pad = 3;
    const pal = this._pal();
    const accent = "#" + this._accentColor().getHexString(THREE.SRGBColorSpace);
    const { cvs, ctx } = this._canvas(W + pad * 2, H + pad * 2);
    ctx.translate(pad, pad);
    ctx.shadowColor = pal.shadow;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = up === null ? pal.pill : accent;
    roundRect(ctx, 0, 2, W, H - 4, (H - 4) / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = up === null ? accent : "#ffffff";
    ctx.beginPath(); ctx.arc(6 + 11, H / 2, 11, 0, Math.PI * 2); ctx.fill();
    this._drawIcon(ctx, iconName, 17, H / 2, 14, up === null ? "#ffffff" : accent);
    ctx.font = font;
    ctx.fillStyle = up === null ? pal.pillText : "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 6 + 22 + 7, H / 2 + 0.5);
    const sign = this._sprite(cvs, W + pad * 2, H + pad * 2, { onTop: true });
    sign.center.set(0.5, 0);
    sign.position.set(point.x - this.W / 2, this.displayY(point.floor, 1.2), point.y - this.D / 2);
    sign.userData.sign = true;
    this.pathSigns = this.pathSigns || [];
    this.pathSigns.push(sign);
    return sign;
  }

  _applyPathVisibility() {
    if (!this.pathGroup) return;
    for (const part of this.pathGroup.children) {
      part.visible = this._floorVisible(part.userData.level);
    }
  }

  /** Red map pin on the destination. */
  _placePin(point) {
    this.pinPoint = point;
    if (!this.pin) {
      const W = 30, H = 40;
      const { cvs, ctx } = this._canvas(W, H);
      ctx.shadowColor = "rgba(60, 10, 10, 0.35)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = "#d93a2b";
      ctx.beginPath();
      ctx.moveTo(15, 38);
      ctx.bezierCurveTo(12, 31, 3, 24, 3, 14.5);
      ctx.arc(15, 14.5, 12, Math.PI, 0);
      ctx.bezierCurveTo(27, 24, 18, 31, 15, 38);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = "#8f1d12";
      ctx.beginPath(); ctx.arc(15, 14.5, 4.6, 0, Math.PI * 2); ctx.fill();
      this.pin = this._sprite(cvs, W, H, { onTop: true });
      this.pin.center.set(0.5, 0.05);
      this.scene.add(this.pin);
    }
    this.pin.position.set(point.x - this.W / 2, this.displayY(point.floor, 0.3), point.y - this.D / 2);
    this.pin.visible = this._floorVisible(point.floor);
  }

  clearPath(keepRef = false) {
    if (this.pathGroup) {
      this.scene.remove(this.pathGroup);
      disposeTree(this.pathGroup);
      this.pathGroup = null;
    }
    this.pathRuns = [];
    this.pathSigns = [];
    this.lineMaterials = [];
    if (!keepRef) {
      this.activeRoutePoints = null;
      this.pinPoint = null;
      if (this.pin) this.pin.visible = false;
      this.setRouteFloors(null); // reveal all floors again (respecting focus)
    }
  }

  /* ------------------------------------------------ highlight ------------ */
  highlightZone(zoneId) {
    if (this.highlightId) {
      const prev = this.zoneMeshes.get(this.highlightId);
      if (prev) prev.material.emissiveIntensity = 0;
    }
    this.highlightId = zoneId;
  }

  /* ------------------------------------------------ camera --------------- */
  focusOn(pos) {
    this._camTween = { target: this._markerWorld(pos), start: performance.now() };
  }

  /* ------------------------------------------------ loop ----------------- */
  _animate() {
    const clock = new THREE.Clock();
    let frames = 0;
    let fpsWindowStart = performance.now();
    let lastCollision = 0;
    const lastCam = new THREE.Vector3();
    let lastRender = 0;
    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden) return; // save battery / GPU when backgrounded
      const now = performance.now();
      // battery saver: at most 30 frames a second
      if (this.frameInterval && now - lastRender < this.frameInterval - 2) return;
      lastRender = now;
      this._resize();

      // adaptive quality: if the device cannot hold ~25 fps, render fewer pixels
      frames++;
      if (now - fpsWindowStart > 3000) {
        const fps = (frames * 1000) / (now - fpsWindowStart);
        frames = 0;
        fpsWindowStart = now;
        if (this.quality === "balanced" && fps < 25 && this.pixelRatio > 1) {
          this.pixelRatio = 1;
          this.renderer.setPixelRatio(1);
          this.renderer.setSize(this._viewW, this._viewH);
        }
      }

      const still = this.reduceMotion;
      const t = still ? 0 : clock.getElapsedTime();

      for (const m of this.markers.values()) {
        m.group.position.lerp(m.target, still ? 1 : 0.12);
        if (m.halo) {
          m.halo.visible = this.showAccuracy;
          m.ring.visible = this.showAccuracy && !still;
          m.haloSize += (m.haloTarget - m.haloSize) * (still ? 1 : 0.08);
          m.halo.scale.setScalar(m.haloSize);
          const s = m.haloSize * (1 + ((t * 0.8) % 1) * 0.35);
          m.ring.scale.setScalar(s);
          m.ring.material.opacity = 0.35 * (1 - ((t * 0.8) % 1));
        }
      }

      for (const run of this.pathRuns || []) {
        if (!run.part.visible) continue;
        const speed = 1.4 / Math.max(6, run.curve.getLength()); // about 1.4 m/s
        for (const pulse of run.pulses) {
          run.curve.getPointAt((t * speed + pulse.userData.phase) % 1, pulse.position);
        }
      }
      if (this.highlightId) {
        const mesh = this.zoneMeshes.get(this.highlightId);
        if (mesh) mesh.material.emissiveIntensity = still ? 0.38 : 0.32 + 0.14 * Math.sin(t * 3.5);
      }

      // gentle camera follow of the self marker
      const self = [...this.markers.values()].find((m) => m.self);
      if (this.followSelf && self?.pos && !this._camTween && this._floorVisible(self.pos.floor)) {
        const goal = self.group.position;
        this.controls.target.x += (goal.x - this.controls.target.x) * 0.01;
        this.controls.target.z += (goal.z - this.controls.target.z) * 0.01;
      }
      if (this._camTween) {
        const k = still ? 1 : 0.08;
        const before = this.controls.target.clone();
        this.controls.target.lerp(this._camTween.target, k);
        if (this._camTween.position) {
          this.camera.position.lerp(this._camTween.position, k);
        } else {
          // move the camera with its target so the view angle stays the same
          this.camera.position.add(this.controls.target.clone().sub(before));
        }
        if (still || performance.now() - this._camTween.start > 1500) this._camTween = null;
      }

      this.controls.update();

      // labels: re-check overlaps when the camera moved, fade in and out
      if (!this.camera.position.equals(lastCam) || this._labelsDirty || now - lastCollision > 600) {
        if (now - lastCollision > 90) {
          this._resolveLabelCollisions();
          lastCollision = now;
          lastCam.copy(this.camera.position);
          this._labelsDirty = false;
        }
      }
      for (const s of this.labelSprites) {
        const o = s.material.opacity;
        const goal = s.userData.fade;
        if (o !== goal) s.material.opacity = still || Math.abs(o - goal) < 0.04 ? goal : o + (goal - o) * 0.25;
        s.material.visible = s.material.opacity > 0;
      }

      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}

/* ------------------------------------------------ helpers ---------------- */
function centroid(poly) {
  // area-weighted centroid, so L-shaped rooms get their label inside the room
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    let x = 0, y = 0;
    for (const [px, py] of poly) { x += px; y += py; }
    return [x / poly.length, y / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** Free the GPU memory behind a group that is being thrown away. */
function disposeTree(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose();
    const mat = obj.material;
    if (mat) {
      mat.map?.dispose();
      mat.dispose();
    }
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
