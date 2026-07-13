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

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      50, container.clientWidth / container.clientHeight, 0.1, 500
    );
    this.camera.position.set(26, 42, 52);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 8, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 160;

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2e3a, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(40, 80, 30);
    this.scene.add(sun);

    // ground shadow disc for depth perception
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(64, 48),
      new THREE.MeshBasicMaterial({ color: 0x0b0e16, transparent: true, opacity: 0.35 })
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
        color: 0x39415a, transparent: true, opacity: 0.92,
      }));
      slab.position.y = -0.22;
      slab.userData.baseOpacity = 0.92;
      group.add(slab);

      // glass walls + roof edge lines
      const walls = this._flatExtrude(floor.outline, WALL_HEIGHT, new THREE.MeshBasicMaterial({
        color: 0x9db4ff, transparent: true, opacity: 0.05,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      walls.userData.baseOpacity = 0.05;
      group.add(walls);
      for (const h of [0.02, WALL_HEIGHT]) {
        const pts = floor.outline.map(
          ([x, y]) => new THREE.Vector3(x - this.W / 2, h, y - this.D / 2)
        );
        pts.push(pts[0].clone());
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x8fa3d9, transparent: true, opacity: 0.5 })
        );
        line.userData.baseOpacity = 0.5;
        group.add(line);
      }

      // zones
      for (const zone of floor.zones) {
        const isCirc = ["escalator", "elevator", "stairs", "restroom"].includes(zone.kind);
        const mat = new THREE.MeshLambertMaterial({
          color: new THREE.Color(zone.color),
          transparent: true,
          opacity: isCirc ? 0.55 : 0.88,
          emissive: new THREE.Color(zone.color),
          emissiveIntensity: 0.05,
        });
        const mesh = this._flatExtrude(zone.poly, 0.14, mat);
        mesh.position.y = 0.02;
        mesh.userData = { zoneId: zone.id, baseOpacity: mat.opacity, baseEmissive: 0.05 };
        this.zoneMeshes.set(zone.id, mesh);
        group.add(mesh);

        if (!isCirc) {
          const label = this._makeLabel(zone);
          const c = centroid(zone.poly);
          label.position.set(c[0] - this.W / 2, 1.5, c[1] - this.D / 2);
          label.userData.isLabel = true;
          group.add(label);
        }
      }
    }
    this._applyFloorLayout();
  }

  _makeLabel(zone) {
    const short = zone.id.split("-")[1];
    const cvs = document.createElement("canvas");
    cvs.width = 512; cvs.height = 192;
    const ctx = cvs.getContext("2d");
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(10,12,20,0.55)";
    roundRect(ctx, 96, 8, 320, 176, 28);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 84px Inter, system-ui, sans-serif";
    ctx.fillText(short, 256, 92);
    ctx.font = "400 34px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#c6d2f0";
    const name = zone.name.length > 26 ? zone.name.slice(0, 25) + "…" : zone.name;
    ctx.fillText(name, 256, 148);
    const tex = new THREE.CanvasTexture(cvs);
    tex.anisotropy = 4;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    sprite.scale.set(6.4, 2.4, 1);
    return sprite;
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
  }

  setFloorFocus(level) {
    this.focusLevel = level; // "all" or "2"/"4"/"5"
    for (const [lvl, group] of Object.entries(this.floorGroups)) {
      const focused = level === "all" || lvl === level;
      group.traverse((obj) => {
        if (obj.userData?.isLabel) obj.visible = focused;
        const mat = obj.material;
        if (mat && obj.userData?.baseOpacity !== undefined) {
          mat.opacity = obj.userData.baseOpacity * (focused ? 1 : 0.07);
        }
      });
    }
    for (const m of this.markers.values()) {
      if (m.pos) m.group.visible = level === "all" || String(m.pos.floor) === level;
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
      const color = self ? 0x38e1c6 : 0xf0a840;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 20, 20),
        new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.55 })
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
    if (!m.group.visible && (this.focusLevel === "all" || String(pos.floor) === this.focusLevel)) {
      m.group.visible = true;
    }
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
      new THREE.MeshBasicMaterial({ color: 0x38e1c6, transparent: true, opacity: 0.85 })
    );
    group.add(tube);

    for (let i = 0; i < 4; i++) {
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })
      );
      pulse.userData.phase = i / 4;
      this.pathPulses.push(pulse);
      group.add(pulse);
    }

    const end = v3[v3.length - 1];
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 8, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x38e1c6, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    beacon.position.copy(end).y += 4;
    const endRing = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.15, 40),
      new THREE.MeshBasicMaterial({
        color: 0x38e1c6, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
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
    if (!keepRef) this.activeRoutePoints = null;
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
  const cvs = document.createElement("canvas");
  cvs.width = 384; cvs.height = 96;
  const ctx = cvs.getContext("2d");
  ctx.fillStyle = "rgba(240,168,64,0.92)";
  roundRect(ctx, 60, 10, 264, 76, 34);
  ctx.fill();
  ctx.fillStyle = "#1a1408";
  ctx.font = "600 44px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(name.slice(0, 12), 192, 62);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cvs), transparent: true, depthWrite: false,
  }));
  sprite.scale.set(4.2, 1.05, 1);
  return sprite;
}
