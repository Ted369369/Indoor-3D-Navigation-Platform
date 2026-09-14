/*
 * Three.js scene: renders the hand-drawn floor plans as stacked 3D storeys,
 * live user/friend markers, and the animated navigation path.
 *
 * Map space:   x = 0..50 m (west->east), y = 0..35 m (drawing top->bottom),
 *              z = height in metres (floor 2 = 0).
 * World space: X = x - width/2, Y = height, Z = y - depth/2.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const WALL_HEIGHT = 2.6;
const EXPLODE_FACTOR = 1.9; // vertical spacing multiplier in exploded view

export class MapScene {
  constructor(container, model, { onZoneClick } = {}) {
    this.model = model;
    this.onZoneClick = onZoneClick;
    this.W = model.site.width;
    this.D = model.site.depth;
    this.floorZ = Object.fromEntries(model.site.floors.map((f) => [String(f.level), f.z]));
    this.exploded = false;
    this.focusLevel = "all";
    this.followSelf = true;

    this.markers = new Map(); // uid -> {group, target, ring, self}
    this.zoneMeshes = new Map();
    this.pathGroup = null;
    this.pathCurve = null;
    this.pathPulses = [];
    this.highlightId = null;

    this._initRenderer(container);
    this._buildFloors();
    this._animate();
  }

  /* ------------------------------------------------ setup ---------------- */
  _initRenderer(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.pixelRatio = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    container.appendChild(this.renderer.domElement);

    this.labelSprites = [];
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      50, container.clientWidth / container.clientHeight, 0.1, 800
    );
    // framing was tuned on a 50 x 35 m building; scale it for other footprints
    const k = Math.max(1, Math.max(this.W / 50, this.D / 35)) ** 0.75;
    const topZ = Math.max(...Object.values(this.floorZ));
    this.camera.position.set(26 * k, 42 * k, 52 * k);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, Math.max(3, topZ / 2), 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 160 * k;

    this.scene.add(new THREE.HemisphereLight(0xfffaf0, 0x8a8272, 1.05));
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.25);
    sun.position.set(40, 80, 30);
    this.scene.add(sun);

    // ground shadow disc for depth perception
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(64 * Math.max(1, this.W / 50), 48),
      new THREE.MeshBasicMaterial({ color: 0x1d1b17, transparent: true, opacity: 0.06 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.2;
    this.scene.add(ground);

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
      const hits = ray.intersectObjects([...this.zoneMeshes.values()]);
      const visible = hits.find((h) => h.object.material.opacity > 0.3);
      if (visible) this.onZoneClick?.(visible.object.userData.zoneId);
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
    for (const sprite of this.labelSprites) this._sizeLabel(sprite);
  }

  _shapeFrom(poly) {
    const s = new THREE.Shape();
    s.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) s.lineTo(poly[i][0], poly[i][1]);
    s.closePath();
    return s;
  }

  /** Horizontal extrusion helper: shape in map XY -> mesh lying flat. */
  _flatExtrude(poly, depth, material) {
    const geo = new THREE.ExtrudeGeometry(this._shapeFrom(poly), {
      depth, bevelEnabled: false,
    });
    geo.rotateX(Math.PI / 2); // shape now in XZ plane, extrusion downward
    geo.translate(-this.W / 2, depth, -this.D / 2);
    return new THREE.Mesh(geo, material);
  }

  _buildFloors() {
    this.floorGroups = {};
    for (const [level, floor] of Object.entries(this.model.floors)) {
      const group = new THREE.Group();
      group.userData.level = level;
      this.floorGroups[level] = group;
      this.scene.add(group);

      // slab
      const slab = this._flatExtrude(floor.outline, 0.22, new THREE.MeshLambertMaterial({
        color: 0xe2dac8, transparent: true, opacity: 0.92,
      }));
      slab.position.y = -0.22;
      slab.userData.baseOpacity = 0.92;
      group.add(slab);

      // glass walls + roof edge lines
      const walls = this._flatExtrude(floor.outline, WALL_HEIGHT, new THREE.MeshBasicMaterial({
        color: 0x1d1b17, transparent: true, opacity: 0.035,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      walls.userData.baseOpacity = 0.035;
      group.add(walls);
      for (const h of [0.02, WALL_HEIGHT]) {
        const pts = floor.outline.map(
          ([x, y]) => new THREE.Vector3(x - this.W / 2, h, y - this.D / 2)
        );
        pts.push(pts[0].clone());
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x1d1b17, transparent: true, opacity: 0.55 })
        );
        line.userData.baseOpacity = 0.55;
        group.add(line);
      }

      // zones
      for (const zone of floor.zones) {
        const isCirc = ["escalator", "elevator", "stairs", "restroom"].includes(zone.kind);
        // keep the hues from the paper floor plans but knock them back
        // so they read like printed map tints
        const tint = new THREE.Color(zone.color);
        const hsl = tint.getHSL({});
        tint.setHSL(hsl.h, hsl.s * 0.5, Math.min(0.8, hsl.l * 0.95 + 0.06));
        const mat = new THREE.MeshLambertMaterial({
          color: tint,
          transparent: true,
          opacity: isCirc ? 0.55 : 0.88,
          emissive: tint,
          emissiveIntensity: 0.05,
        });
        const mesh = this._flatExtrude(zone.poly, 0.14, mat);
        // stairs and lifts often sit inside a room's outline; lift them a
        // little so the two surfaces don't flicker against each other
        mesh.position.y = isCirc ? 0.05 : 0.02;
        mesh.userData = { zoneId: zone.id, baseOpacity: mat.opacity, baseEmissive: 0.05 };
        this.zoneMeshes.set(zone.id, mesh);
        group.add(mesh);

        if (!isCirc && !zone.noLabel) {
          const c = centroid(zone.poly);
          for (const full of [false, true]) {
            const label = this._makeLabel(zone, full);
            label.position.set(c[0] - this.W / 2, 1.5, c[1] - this.D / 2);
            label.userData.labelKind = full ? "full" : "code";
            label.visible = !full;
            group.add(label);
          }
        }
      }
    }
    this._applyFloorLayout();
  }

  _makeLabel(zone, full) {
    // Plates keep a fixed on-screen size (sizeAttenuation off), so the canvas
    // is drawn in CSS pixels times the device ratio and maps ~1:1 to the screen.
    const code = zone.code || zone.id.split("-").slice(1).join("-");
    const S = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const codeFont = '700 16px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    const nameFont = '500 13px "Barlow", system-ui, sans-serif';
    const measure = document.createElement("canvas").getContext("2d");

    measure.font = codeFont;
    const codeW = Math.max(22, Math.ceil(measure.measureText(code).width) + 12);
    let W = codeW, H = 24, lines = [];
    if (full) {
      measure.font = nameFont;
      lines = wrapText(measure, zone.name, 124, 2);
      const textW = Math.max(...lines.map((l) => measure.measureText(l).width));
      W = codeW + 8 + Math.ceil(textW) + 8;
      H = lines.length > 1 ? 38 : 24;
    }

    const cvs = document.createElement("canvas");
    cvs.width = Math.ceil(W * S); cvs.height = Math.ceil(H * S);
    const ctx = cvs.getContext("2d");
    ctx.scale(S, S);
    ctx.fillStyle = "rgba(34,32,27,0.94)";
    roundRect(ctx, 0, 0, W, H, 2);
    ctx.fill();
    ctx.fillStyle = "#e0561b";
    ctx.fillRect(0, 0, full ? codeW : W, 2);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#f3eee3";
    ctx.font = codeFont;
    ctx.fillText(code, codeW / 2, H / 2 + 1);
    if (full) {
      ctx.fillStyle = "rgba(243,238,227,0.18)";
      ctx.fillRect(codeW, 5, 1, H - 10);
      ctx.textAlign = "left";
      ctx.fillStyle = "#e6dfd0";
      ctx.font = nameFont;
      const top = H / 2 - ((lines.length - 1) * 15) / 2 + 1;
      lines.forEach((l, i) => ctx.fillText(l, codeW + 8, top + i * 15));
    }

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._crispTexture(cvs), transparent: true, depthWrite: false,
      sizeAttenuation: false,
    }));
    sprite.renderOrder = 5;
    sprite.userData.px = [W, H];
    this.labelSprites.push(sprite);
    this._sizeLabel(sprite);
    return sprite;
  }

  /** Scale a fixed-size sprite so it covers its CSS pixel size on screen. */
  _sizeLabel(sprite) {
    if (!this._viewH) return;
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this._viewH;
    const [w, h] = sprite.userData.px;
    sprite.scale.set(w * k, h * k, 1);
  }

  /** Canvas texture tuned for legible text: max anisotropy, no mip blur. */
  _crispTexture(cvs) {
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace; // otherwise the dark plate comes out grey
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearFilter; // skip mipmaps -> no softening
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /* ------------------------------------------- layout & focus ------------ */
  displayY(level, offset = 0) {
    const z = this.floorZ[String(level)];
    return (this.exploded ? z * EXPLODE_FACTOR : z) + offset;
  }

  _applyFloorLayout() {
    for (const [level, group] of Object.entries(this.floorGroups)) {
      group.position.y = this.displayY(level);
    }
    for (const marker of this.markers.values()) {
      if (marker.pos) marker.target.copy(this._markerWorld(marker.pos));
    }
    if (this.activeRoutePoints) this._buildPathMesh(this.activeRoutePoints);
  }

  setExploded(on) {
    this.exploded = on;
    this._applyFloorLayout();
    this._applyVisibility();
  }

  setFloorFocus(level) {
    this.focusLevel = level; // "all" or a level like "3"
    this._applyVisibility();
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

  /** Hide floors outside the visible set; raise transparency while navigating. */
  _applyVisibility() {
    const set = this._visibleSet();
    const opacityScale = this.routeFloors ? 0.45 : 1.0; // see the path through the slabs
    for (const [lvl, group] of Object.entries(this.floorGroups)) {
      const show = !set || set.has(lvl);
      group.visible = show;
      if (show) {
        const named = this.focusLevel !== "all";
        group.traverse((obj) => {
          if (obj.userData?.labelKind) obj.visible = (obj.userData.labelKind === "full") === named;
          const mat = obj.material;
          if (mat && obj.userData?.baseOpacity !== undefined) {
            mat.opacity = obj.userData.baseOpacity * opacityScale;
          }
        });
      }
    }
    for (const m of this.markers.values()) {
      if (m.pos) m.group.visible = !set || set.has(String(m.pos.floor));
    }
  }

  /* ------------------------------------------------ markers -------------- */
  _markerWorld(pos) {
    return new THREE.Vector3(
      pos.x - this.W / 2,
      this.displayY(pos.floor, 0.4),
      pos.y - this.D / 2
    );
  }

  updateMarker(uid, pos, { self = false, name = "" } = {}) {
    let m = this.markers.get(uid);
    if (!m) {
      const color = self ? 0x1e6a47 : 0x2a5b9a;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 20, 20),
        new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 })
      );
      body.position.y = 0.42;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.7, 0.95, 40),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      group.add(body, ring);
      if (!self && name) {
        const tag = makeNameTag(name);
        tag.position.y = 1.6;
        group.add(tag);
      }
      m = { group, ring, target: new THREE.Vector3(), self };
      this.markers.set(uid, m);
      this.scene.add(group);
    }
    m.pos = pos;
    m.target.copy(this._markerWorld(pos));
    m.group.visible = this._floorVisible(pos.floor);
  }

  removeMarker(uid) {
    const m = this.markers.get(uid);
    if (m) {
      this.scene.remove(m.group);
      this.markers.delete(uid);
    }
  }

  /* ------------------------------------------------ path ----------------- */
  showPath(points) {
    this.activeRoutePoints = points;
    this._buildPathMesh(points);
    this.setRouteFloors(new Set(points.map((p) => String(p.floor))));
  }

  _buildPathMesh(points) {
    this.clearPath(true);
    const v3 = points.map(
      (p) => new THREE.Vector3(
        p.x - this.W / 2,
        this.displayY(p.floor, 0.45),
        p.y - this.D / 2
      )
    );
    if (v3.length < 2) return;
    this.pathCurve = new THREE.CatmullRomCurve3(v3, false, "catmullrom", 0.08);
    const group = new THREE.Group();

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(this.pathCurve, Math.min(300, v3.length * 24), 0.17, 8, false),
      new THREE.MeshBasicMaterial({ color: 0xe0561b, transparent: true, opacity: 0.9 })
    );
    group.add(tube);

    for (let i = 0; i < 4; i++) {
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff6ea, transparent: true, opacity: 0.95 })
      );
      pulse.userData.phase = i / 4;
      this.pathPulses.push(pulse);
      group.add(pulse);
    }

    const end = v3[v3.length - 1];
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 8, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xe0561b, transparent: true, opacity: 0.14,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    beacon.position.copy(end).y += 4;
    const endRing = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.15, 40),
      new THREE.MeshBasicMaterial({
        color: 0xe0561b, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      })
    );
    endRing.rotation.x = -Math.PI / 2;
    endRing.position.copy(end).y += 0.05;
    endRing.userData.isEndRing = true;
    this.endRing = endRing;
    group.add(beacon, endRing);

    this.pathGroup = group;
    this.scene.add(group);
  }

  clearPath(keepRef = false) {
    if (this.pathGroup) {
      this.scene.remove(this.pathGroup);
      this.pathGroup = null;
    }
    this.pathPulses = [];
    this.pathCurve = null;
    this.endRing = null;
    if (!keepRef) {
      this.activeRoutePoints = null;
      this.setRouteFloors(null); // reveal all floors again (respecting focus)
    }
  }

  /* ------------------------------------------------ highlight ------------ */
  highlightZone(zoneId) {
    if (this.highlightId) {
      const prev = this.zoneMeshes.get(this.highlightId);
      if (prev) prev.material.emissiveIntensity = prev.userData.baseEmissive;
    }
    this.highlightId = zoneId;
  }

  /* ------------------------------------------------ camera --------------- */
  focusOn(pos) {
    const p = this._markerWorld(pos);
    this._camTween = { target: p, start: performance.now() };
  }

  /* ------------------------------------------------ loop ----------------- */
  _animate() {
    const clock = new THREE.Clock();
    let frames = 0;
    let fpsWindowStart = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden) return; // save battery / GPU when backgrounded
      this._resize();

      // adaptive quality: if the device cannot hold ~25 fps, render fewer pixels
      frames++;
      const now = performance.now();
      if (now - fpsWindowStart > 3000) {
        const fps = (frames * 1000) / (now - fpsWindowStart);
        frames = 0;
        fpsWindowStart = now;
        if (fps < 25 && this.pixelRatio > 1) {
          this.pixelRatio = 1;
          this.renderer.setPixelRatio(1);
          this.renderer.setSize(this._viewW, this._viewH);
        }
      }

      const t = clock.getElapsedTime();

      for (const m of this.markers.values()) {
        m.group.position.lerp(m.target, 0.09);
        const s = 1 + 0.25 * Math.sin(t * 3.5);
        m.ring.scale.set(s, s, 1);
        m.ring.material.opacity = 0.55 + 0.3 * Math.sin(t * 3.5 + 1);
      }

      if (this.pathCurve) {
        for (const pulse of this.pathPulses) {
          const u = (t * 0.09 + pulse.userData.phase) % 1;
          this.pathCurve.getPointAt(u, pulse.position);
        }
      }
      if (this.endRing) {
        const s = 1 + 0.35 * Math.sin(t * 4);
        this.endRing.scale.set(s, s, 1);
      }
      if (this.highlightId) {
        const mesh = this.zoneMeshes.get(this.highlightId);
        if (mesh) mesh.material.emissiveIntensity = 0.25 + 0.2 * Math.sin(t * 5);
      }

      // gentle camera follow of the self marker
      const self = [...this.markers.values()].find((m) => m.self);
      if (this.followSelf && self?.pos) {
        this.controls.target.lerp(self.group.position, 0.02);
      }
      if (this._camTween) {
        this.controls.target.lerp(this._camTween.target, 0.06);
        if (performance.now() - this._camTween.start > 1800) this._camTween = null;
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}

/* ------------------------------------------------ helpers ---------------- */
function centroid(poly) {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x += px; y += py; }
  return [x / poly.length, y / poly.length];
}

/** Greedy word wrap; the last line gets "..." if the text does not fit. */
function wrapText(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const test = line ? line + " " + words[i] : words[i];
    if (!line || ctx.measureText(test).width <= maxW) {
      line = test;
      continue;
    }
    if (lines.length === maxLines - 1) break;
    lines.push(line);
    line = words[i];
  }
  if (i < words.length || ctx.measureText(line).width > maxW) {
    while (line.length > 1 && ctx.measureText(line + "...").width > maxW) line = line.slice(0, -1);
    line = line.trimEnd() + "...";
  }
  lines.push(line);
  return lines;
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

function makeNameTag(name) {
  const S = 2;
  const cvs = document.createElement("canvas");
  cvs.width = 384 * S; cvs.height = 96 * S;
  const ctx = cvs.getContext("2d");
  ctx.scale(S, S);
  ctx.fillStyle = "#2a5b9a";
  roundRect(ctx, 60, 10, 264, 76, 4);
  ctx.fill();
  ctx.fillStyle = "#f3eee3";
  ctx.font = '600 44px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(name.slice(0, 12), 192, 62);
  const tex = new THREE.CanvasTexture(cvs);
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sprite.scale.set(4.2, 1.05, 1);
  return sprite;
}
