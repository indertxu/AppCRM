/* ---------------------------------------------------------------------------
   The sign-in page's 3D story (loaded lazily by LoginStory.tsx).

   Art direction: an architect's model. One round plinth, matte white clay,
   dark glass, brushed gold, and a single accent — lime light — for whatever
   flows (messages, deals, flights, money, the renewal loop). Soft shadows,
   bloom on the light, a quiet camera.

   Seven worlds rise out of the plinth and sink back into it, one after the
   other, in a wave from the centre outwards, while a ring of light sweeps
   the table:
     0 Contact   your office and the client's; messages travel between them
     1 Deal      the meeting room; the pipeline floats above the table
     2 Contract  the desk; the contract is signed and sealed
     3 Kick-off  the airport; the team boards, the plane takes off and loops
     4 Project   the construction site; the crane raises the floors
     5 Billing   the bank; money flows home and the coin towers grow
     6 Renewal   the park; the tree grows, the client's building gains a floor

   Every pose is a pure function of the scene's age, so a world replays
   exactly the same every time it comes back.
   --------------------------------------------------------------------------- */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export interface LoginWorld {
  setStep: (k: number) => void;
  setInset: (px: number) => void;
  dispose: () => void;
}

/* ---------------- palette: clay, glass, gold, one light ---------------- */
const C = {
  clay: "#f1efe9", clay2: "#e6e8e2", sage: "#dbe6de", path: "#e2e2db", ink: "#0d1c17",
  glass: "#18342c", lime: "#c3ef5c", emerald: "#12b57f", gold: "#e3b448", paper: "#fbfbf8", wood: "#e9dfcf",
  asphalt: "#2c3532",
};
const PLINTH_R = 4.35;

/* ---------------- tiny maths ---------------- */
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (age: number, a: number, b: number) => clamp01((age - a) / (b - a));
const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x: number) => x * x * x;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/* ---------------- materials ---------------- */
/** what is below the plinth's top is cut away: worlds rise out of it and sink back */
const CLIP = new THREE.Plane(V(0, 1, 0), 0);
const CLIPS = [CLIP];
type MatOpts = { r?: number; m?: number; e?: string; ei?: number; cc?: boolean; double?: boolean; map?: THREE.Texture; opacity?: number };
const cache = new Map<string, THREE.Material>();
function mat(color: string, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const key = o.map ? "" : JSON.stringify([color, o]);
  if (key && cache.has(key)) return cache.get(key) as THREE.MeshStandardMaterial;
  const p = { color, roughness: o.r ?? 0.86, metalness: o.m ?? 0, map: o.map ?? null, side: o.double ? THREE.DoubleSide : THREE.FrontSide, clippingPlanes: CLIPS };
  const m = o.cc ? new THREE.MeshPhysicalMaterial({ ...p, clearcoat: 1, clearcoatRoughness: 0.12 }) : new THREE.MeshStandardMaterial(p);
  if (o.e) { m.emissive.set(o.e); m.emissiveIntensity = o.ei ?? 1; }
  if (o.opacity != null) { m.transparent = true; m.opacity = o.opacity; m.depthWrite = false; }
  if (key) cache.set(key, m);
  return m;
}
const CLAY = () => mat(C.clay);
const GLASS = () => mat(C.glass, { r: 0.08, cc: true });
const GOLD = () => mat("#b8892c", { r: 0.34, m: 1 });
const LIGHT = (k = 4) => mat(C.lime, { e: C.lime, ei: k, r: 0.4 });
function holo(opacity = 0.16) {
  const k = "holo" + opacity;
  if (cache.has(k)) return cache.get(k) as THREE.MeshPhysicalMaterial;
  const m = new THREE.MeshPhysicalMaterial({ color: "#d9ffc0", emissive: new THREE.Color(C.lime), emissiveIntensity: 0.25, roughness: 0.15, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: CLIPS });
  cache.set(k, m); return m;
}

function mesh(geo: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], cast = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast; m.receiveShadow = true;
  return m;
}
function rbox(w: number, h: number, d: number, r: number, material: THREE.Material) {
  const rr = Math.max(0.001, Math.min(r, Math.min(w, h, d) / 2 - 0.001));
  return mesh(new RoundedBoxGeometry(w, h, d, 3, rr), material);
}
const box = (w: number, h: number, d: number, material: THREE.Material) => mesh(new THREE.BoxGeometry(w, h, d), material);
const cyl = (rt: number, rb: number, h: number, material: THREE.Material, segs = 40) => mesh(new THREE.CylinderGeometry(rt, rb, h, segs), material);
const sph = (r: number, material: THREE.Material, ws = 32, hs = 24) => mesh(new THREE.SphereGeometry(r, ws, hs), material);
function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T { o.position.set(x, y, z); o.rotation.y = ry; return o; }
function grp(...kids: THREE.Object3D[]) { const g = new THREE.Group(); kids.forEach((k) => g.add(k)); return g; }
function lathe(pts: [number, number][], material: THREE.Material, segs = 48) {
  return mesh(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), segs), material);
}
function extrude(points: [number, number][], depth: number, material: THREE.Material, bevel = 0.01) {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return mesh(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2 }), material);
}
const _d = V();
function span(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  _d.subVectors(b, a); const len = Math.max(0.0001, _d.length());
  m.position.copy(a).addScaledVector(_d, 0.5); m.quaternion.setFromUnitVectors(UP, _d.normalize()); m.scale.set(1, len, 1);
}
const rod = (r: number, material: THREE.Material) => mesh(new THREE.CylinderGeometry(r, r, 1, 10), material);

/* ---------------- canvas textures ---------------- */
const FONT = `"Inter", "Helvetica Neue", Arial, sans-serif`;
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function redraw(t: THREE.CanvasTexture, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = t.image as HTMLCanvasElement; const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height); draw(g, c.width, c.height); t.needsUpdate = true;
}
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/* ---------------- light trails (a comet running along a tube) ---------------- */
interface Trail { mesh: THREE.Mesh; u: { uHead: { value: number }; uLen: { value: number }; uBase: { value: number }; uFade: { value: number }; uClosed: { value: number } } }
function trail(curve: THREE.Curve<THREE.Vector3>, o: { r?: number; len?: number; base?: number; closed?: boolean; color?: string; segs?: number } = {}): Trail {
  const u = { uHead: { value: 0 }, uLen: { value: o.len ?? 0.3 }, uBase: { value: o.base ?? 0.18 }, uFade: { value: 1 }, uClosed: { value: o.closed ? 1 : 0 }, uColor: { value: new THREE.Color(o.color ?? C.lime).multiplyScalar(4) } };
  const m = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform float uHead, uLen, uBase, uFade, uClosed; uniform vec3 uColor; varying vec2 vUv;
      void main(){
        float x = vUv.x;
        float d = uClosed > 0.5 ? fract(uHead - x) : uHead - x;
        float head = (d >= 0.0 && d <= uLen) ? pow(1.0 - d / uLen, 2.2) : 0.0;
        float shown = uClosed > 0.5 ? 1.0 : step(x, uHead);
        float a = (uBase * shown + head * 1.4) * uFade;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
  const me = new THREE.Mesh(new THREE.TubeGeometry(curve, o.segs ?? 160, o.r ?? 0.022, 8, !!o.closed), m);
  me.renderOrder = 5;
  return { mesh: me, u };
}

/* ---------------- the cast ---------------- */
/** an architect's scale figure: one turned silhouette and a head */
const FIG = [[0, 0], [0.07, 0], [0.07, 0.035], [0.055, 0.14], [0.072, 0.32], [0.1, 0.47], [0.095, 0.56], [0.118, 0.7], [0.13, 0.78], [0.105, 0.835], [0.042, 0.86], [0.038, 0.895], [0, 0.9]] as [number, number][];
let figGeo: THREE.LatheGeometry | null = null;
function figure(material: THREE.Material = CLAY(), s = 1) {
  if (!figGeo) { figGeo = new THREE.LatheGeometry(FIG.map(([x, y]) => new THREE.Vector2(x, y)), 28); figGeo.scale(1, 1, 0.76); }
  const g = new THREE.Group(); const body = new THREE.Group(); g.add(body);
  body.add(mesh(figGeo, material), at(sph(0.072, material, 20, 16), 0, 0.975, 0));
  g.scale.setScalar(s); g.userData.body = body;
  return g;
}
function stroll(f: THREE.Object3D, t: number, ph = 0) {
  const b = f.userData.body as THREE.Group;
  b.position.y = Math.abs(Math.sin(t * 7 + ph)) * 0.018;
  b.rotation.z = Math.sin(t * 7 + ph) * 0.03;
}
function tree(s = 1, tall = false) {
  const g = new THREE.Group();
  g.add(at(cyl(0.018, 0.026, tall ? 0.7 : 0.45, CLAY(), 10), 0, tall ? 0.35 : 0.225, 0));
  const c = sph(tall ? 0.22 : 0.3, mat(C.sage), 28, 20); c.scale.set(1, tall ? 2.2 : 1.2, 1); c.position.y = tall ? 0.95 : 0.72; g.add(c);
  g.scale.setScalar(s); return g;
}
/** a modern building: floor slabs, a ribbon of glass on every floor, corner fins */
function building(w: number, d: number, floors: number, o: { fh?: number; crown?: boolean; top?: boolean } = {}) {
  const fh = o.fh ?? 0.34, g = new THREE.Group(), H = floors * fh;
  for (let k = 0; k < floors; k++) g.add(at(box(w - 0.1, fh - 0.06, d - 0.1, GLASS()), 0, k * fh + 0.05 + (fh - 0.06) / 2, 0));
  for (let k = 0; k <= floors; k++) g.add(at(rbox(w, 0.06, d, 0.012, CLAY()), 0, k * fh + 0.03, 0));
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.add(at(box(0.05, H, 0.05, CLAY()), x * (w / 2 - 0.035), H / 2 + 0.03, z * (d / 2 - 0.035)));
  if (o.top !== false) g.add(at(rbox(w * 0.34, 0.16, d * 0.34, 0.02, CLAY()), w * 0.12, H + 0.14, -d * 0.1));
  if (o.crown) {
    const L = LIGHT(2.2);
    g.add(at(box(w + 0.01, 0.025, 0.025, L), 0, H + 0.065, d / 2), at(box(w + 0.01, 0.025, 0.025, L), 0, H + 0.065, -d / 2));
    g.add(at(box(0.025, 0.025, d, L), w / 2, H + 0.065, 0), at(box(0.025, 0.025, d, L), -w / 2, H + 0.065, 0));
  }
  g.userData.H = H;
  return g;
}
function inlay(w: number, d: number, color = C.path) { const m = rbox(w, 0.02, d, 0.01, mat(color)); m.castShadow = false; m.position.y = 0.01; return m; }
function coinGeo() { return new THREE.LatheGeometry([[0, 0], [0.24, 0], [0.27, 0.012], [0.27, 0.058], [0.24, 0.07], [0, 0.07]].map(([x, y]) => new THREE.Vector2(x, y)), 40); }

/* ---------------- the scene type ---------------- */
interface Actor { o: THREE.Object3D; y0: number; h: number; delay: number; air: boolean; driven: boolean; s0: THREE.Vector3 }
interface Scene {
  group: THREE.Group; actors: Actor[]; trails: Trail[];
  /** age of the world, clock, and how far it has left (0 → 1) */
  tick: (age: number, t: number, out: number) => void;
  bg: [string, string]; cam: { az: number; el: number; dist: number; y: number };
}
function makeScene(bg: [string, string], cam: Scene["cam"]) {
  const s: Scene = { group: new THREE.Group(), actors: [], trails: [], tick: () => {}, bg, cam };
  /** an actor rises out of the plinth (`air`: scales in where it floats; `driven`: its tick sets its position, the rise is added on top) */
  const add = <T extends THREE.Object3D>(o: T, extra = 0, x: { air?: boolean; driven?: boolean; h?: number } | boolean = {}): T => {
    const opt = typeof x === "boolean" ? { air: x } : x;
    if (!o.parent) s.group.add(o);
    const b = new THREE.Box3().setFromObject(o);
    const dist = Math.hypot(o.position.x, o.position.z) / PLINTH_R;
    s.actors.push({ o, y0: o.position.y, h: opt.h ?? Math.max(0.2, b.max.y - Math.min(0, b.min.y) + 0.08), delay: 0.12 + dist * 0.55 + extra, air: !!opt.air, driven: !!opt.driven, s0: o.scale.clone() });
    return o;
  };
  const addTrail = (t: Trail) => { s.group.add(t.mesh); s.trails.push(t); return t; };
  return { s, add, addTrail };
}

/* ====================== 0 · Contact ====================== */
function sceneContact(): Scene {
  const { s, add, addTrail } = makeScene(["#1b6a4f", "#03140d"], { az: 0.7, el: 0.5, dist: 21, y: 1.0 });
  add(at(inlay(7.6, 0.6), 0, 0, 0.15)); add(at(inlay(0.6, 7.6), 0.2, 0, 0));
  const hq = add(at(building(1.6, 1.6, 8, { crown: true }), -1.55, 0, -1.4));
  const cl = add(at(building(2.0, 1.4, 4), 1.8, 0, 1.45));
  add(at(building(1.2, 1.1, 3), 1.9, 0, -1.8));
  add(at(building(2.2, 1.0, 2), -2.0, 0, 1.75));
  const antenna = at(grp(at(cyl(0.012, 0.012, 0.5, CLAY(), 8), 0, 0.25, 0), at(sph(0.04, LIGHT(4), 12, 10), 0, 0.52, 0)), -1.25, hq.userData.H + 0.1, -1.6);
  add(antenna, 0.5);
  ([[-0.55, 1.0], [0.95, -0.55], [-0.6, -0.65], [1.0, 0.75], [-3.1, -0.6], [3.2, 0.0], [-0.8, 2.9], [0.9, -3.1], [-3.0, 0.75]] as const).forEach(([x, z], i) => add(at(tree(i % 3 === 0 ? 0.9 : 1, i % 2 === 0), x, 0, z), 0.2));
  // people on the paths
  const walkers = [0, 1, 2, 3].map((i) => { const f = add(at(figure(i === 1 ? LIGHT(0.9) : CLAY(), 0.9), 0, 0, 0), 0.4); return { f, ph: i * 0.25, axis: i % 2 }; });
  [[0.6, 0.6, 2.4], [-0.15, -0.7, 0.8]].forEach(([x, z, ry]) => add(at(figure(CLAY(), 0.9), x, 0, z, ry), 0.45));
  // messages: from your office to the client's
  const A = V(-1.55, hq.userData.H + 0.35, -1.4), B = V(1.8, cl.userData.H + 0.35, 1.45);
  const curve = new THREE.QuadraticBezierCurve3(A, V(0.2, 4.6, 0.1), B);
  const tr = addTrail(trail(curve, { len: 0.22, base: 0.3 }));
  const env = () => { const g = new THREE.Group(); g.add(rbox(0.3, 0.2, 0.025, 0.02, mat(C.paper, { r: 0.5 }))); const fl = extrude([[-0.15, 0.1], [0.15, 0.1], [0, -0.01]], 0.004, mat("#e4e9e5", { r: 0.5 }), 0); fl.position.z = 0.013; g.add(fl); return g; };
  const msgs = [0, 1, 2].map(() => { const e = env(); s.group.add(e); return e; });
  const pulse = [0, 1].map(() => { const r = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.46, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(3.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r.rotation.x = -Math.PI / 2; r.position.set(B.x, cl.userData.H + 0.1, B.z); s.group.add(r); return r; });
  const _p = V(), _q = V();
  s.tick = (age, t, out) => {
    const reveal = easeInOut(seg(age, 0.9, 1.9));
    tr.u.uHead.value = reveal; tr.u.uLen.value = age < 1.9 ? 0.25 : 0.0001;
    tr.u.uBase.value = 0.3 * smooth(seg(age, 0.9, 1.6));
    msgs.forEach((m, i) => {
      const u = Math.max(0, ((age - 1.6) * 0.38 + i / 3) % 1);
      m.visible = age > 1.6 + i * 0.85;
      curve.getPoint(u, _p); curve.getPoint(Math.min(1, u + 0.01), _q);
      m.position.copy(_p); m.lookAt(_q); m.rotateY(Math.PI / 2);
      m.scale.setScalar(Math.max(0.001, Math.min(1, Math.sin(Math.PI * u) * 1.3) * (1 - out)));
    });
    pulse.forEach((r, i) => {
      const u = (t * 0.55 + i * 0.5) % 1;
      r.scale.setScalar(1 + u * 2.2); (r.material as THREE.MeshBasicMaterial).opacity = (1 - u) * 0.9 * smooth(seg(age, 1.8, 2.4)) * (1 - out);
      r.position.y = cl.position.y + cl.userData.H + 0.1;
    });
    walkers.forEach(({ f, ph, axis }) => {
      const u = (t * 0.045 + ph) % 1, x = lerp(-3.3, 3.3, u);
      if (axis === 0) { f.position.x = x; f.position.z = 0.15 + (ph > 0.4 ? 0.14 : -0.14); f.rotation.y = Math.PI / 2; }
      else { f.position.z = -x; f.position.x = 0.2 + (ph > 0.6 ? 0.14 : -0.14); f.rotation.y = Math.PI; }
      stroll(f, t, ph * 9);
    });
    (antenna.children[1] as THREE.Mesh).scale.setScalar(0.8 + Math.max(0, Math.sin(t * 4)) * 0.6);
  };
  return s;
}

/* ====================== 1 · Deal — the meeting room ====================== */
function sceneDeal(): Scene {
  const { s, add } = makeScene(["#3a2f86", "#07061a"], { az: 0.6, el: 0.4, dist: 18.5, y: 1.55 });
  add(at(rbox(6.0, 0.08, 4.4, 0.03, mat(C.wood, { r: 0.7 })), 0, 0.04, 0));
  // glass walls with mullions on two sides
  const wall = new THREE.Group();
  wall.add(at(box(6.0, 1.5, 0.02, mat("#cfe3dc", { r: 0.1, opacity: 0.22 })), 0, 0.83, -2.2));
  for (let k = 0; k <= 8; k++) wall.add(at(box(0.04, 1.5, 0.04, CLAY()), -3 + k * 0.75, 0.83, -2.2));
  wall.add(at(box(6.0, 0.05, 0.06, CLAY()), 0, 1.6, -2.2));
  add(wall, 0.1);
  // the table, chairs, people
  const table = new THREE.Group();
  table.add(at(rbox(3.2, 0.07, 1.3, 0.035, CLAY()), 0, 0.58, 0), at(box(0.08, 0.5, 0.9, CLAY()), -1.2, 0.3, 0), at(box(0.08, 0.5, 0.9, CLAY()), 1.2, 0.3, 0));
  add(table);
  const seats: [number, number, number][] = [[-1.0, 1.0, Math.PI], [0, 1.0, Math.PI], [1.0, 1.0, Math.PI], [-1.0, -1.0, 0], [0, -1.0, 0], [1.0, -1.0, 0]];
  seats.forEach(([x, z, ry], i) => {
    const ch = at(grp(at(rbox(0.42, 0.06, 0.42, 0.02, CLAY()), 0, 0.36, 0), at(rbox(0.42, 0.4, 0.05, 0.02, CLAY()), 0, 0.58, -0.2), at(cyl(0.025, 0.025, 0.33, CLAY(), 8), 0, 0.17, 0)), x, 0, z + (z > 0 ? 0.25 : -0.25), ry);
    add(ch, 0.15);
    if (i !== 1 && i !== 4) add(at(figure(CLAY(), 0.82), x, 0, z + (z > 0 ? 0.72 : -0.72), ry + Math.PI), 0.2);
  });
  const lead = add(at(figure(LIGHT(0.9), 0.9), -2.05, 0, 0, Math.PI / 2), 0.25);
  // the hologram: three columns of the pipeline above the table
  const holoG = at(new THREE.Group(), 0, 1.25, 0); add(holoG, 0.9, true);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 0.12, 0.62, 48, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(0.6), transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.y = -0.3; holoG.add(beam);
  const COLX = [-1.2, 0, 1.2];
  const won = new THREE.MeshPhysicalMaterial({ color: "#d9ffc0", emissive: new THREE.Color(C.lime), emissiveIntensity: 0.3, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: CLIPS });
  COLX.forEach((x, i) => {
    holoG.add(at(rbox(1.04, 1.4, 0.02, 0.03, i === 2 ? won : holo(0.24)), x, 0.7, 0));
    const fr = LIGHT(i === 2 ? 4 : 2.2);
    holoG.add(at(box(1.04, 0.025, 0.025, fr), x, 1.41, 0), at(box(1.04, 0.012, 0.012, fr), x, -0.01, 0), at(box(0.012, 1.4, 0.012, fr), x - 0.52, 0.7, 0), at(box(0.012, 1.4, 0.012, fr), x + 0.52, 0.7, 0));
  });
  const cardM = mat(C.paper, { r: 0.4 });
  const cards = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [2, 0]].map(([c, sl]) => {
    const g = new THREE.Group(); g.add(rbox(0.84, 0.26, 0.035, 0.03, cardM));
    const dot = at(sph(0.045, LIGHT(c === 2 ? 3 : 0.6), 12, 10), -0.3, 0, 0.025); g.add(dot);
    g.add(at(box(0.4, 0.03, 0.01, mat("#9fada7")), 0.05, 0.045, 0.02), at(box(0.26, 0.03, 0.01, mat("#d2d9d6")), -0.02, -0.035, 0.02), at(box(0.14, 0.05, 0.01, LIGHT(1.5)), 0.3, -0.035, 0.02));
    holoG.add(g); return { g, c, sl, dot };
  });
  const MOVES: [number, number, number, number][] = [[1.4, 3, 2, 1], [2.45, 0, 1, 0], [3.5, 4, 2, 2], [4.55, 1, 1, 1]];
  const DUR = 0.85;
  const slot = (c: number, sl: number, out: THREE.Vector3) => out.set(COLX[c], 1.2 - sl * 0.34, 0.03);
  const _a = V(), _b = V();
  s.tick = (age, t) => {
    let glow = 0;
    cards.forEach((cd, i) => {
      let c = cd.c, sl = cd.sl, mv = -1;
      for (const [st, ci, tc, ts] of MOVES) { if (ci !== i || age < st) continue; if (age < st + DUR) { mv = st; slot(c, sl, _a); slot(tc, ts, _b); } c = tc; sl = ts; }
      if (mv >= 0) {
        const e = easeInOut(seg(age, mv, mv + DUR));
        cd.g.position.lerpVectors(_a, _b, e); cd.g.position.z += Math.sin(Math.PI * e) * 0.35; cd.g.position.y += Math.sin(Math.PI * e) * 0.18;
        cd.g.rotation.y = Math.sin(Math.PI * e) * -0.35;
      } else { slot(c, sl, cd.g.position); cd.g.rotation.y = 0; }
      cd.dot.material = c === 2 ? LIGHT(3) : LIGHT(0.6);
    });
    for (const [st, , tc] of MOVES) if (tc === 2) { const k = age - st - DUR; if (k >= 0 && k < 1.4) glow = Math.max(glow, 1 - k / 1.4); }
    won.emissiveIntensity = 0.3 + glow * 1.6;
    holoG.position.y = 1.25 + Math.sin(t * 1.2) * 0.03;
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.06 + Math.sin(t * 3) * 0.015;
    stroll(lead, t * 0.25, 0);
  };
  return s;
}

/* ====================== 2 · Contract — the desk ====================== */
function sceneContract(): Scene {
  const { s, add } = makeScene(["#6a4a1d", "#0e0803"], { az: 0.4, el: 0.78, dist: 17.5, y: 0.3 });
  add(at(rbox(6.4, 0.12, 4.6, 0.05, mat(C.wood, { r: 0.65 })), 0, 0.06, 0));
  const Y = 0.12;
  const docTex = canvasTex(700, 900, (g, w, h) => {
    g.fillStyle = C.paper; g.fillRect(0, 0, w, h);
    g.fillStyle = "#0d1c17"; g.font = `700 46px ${FONT}`; g.fillText("Service agreement", 60, 110);
    g.fillStyle = "#7d8a84"; g.font = `500 24px ${FONT}`; g.fillText("Halden & Moss  ·  Next Finance  ·  12 months", 60, 156);
    g.fillStyle = "#e4e9e6"; for (let k = 0; k < 11; k++) g.fillRect(60, 220 + k * 40, k % 4 === 3 ? 360 : 580, 12);
    g.strokeStyle = "#aab6b0"; g.lineWidth = 2; g.beginPath(); g.moveTo(330, 790); g.lineTo(640, 790); g.stroke();
    g.fillStyle = "#9aa7a1"; g.font = `500 20px ${FONT}`; g.fillText("Signature", 330, 822);
    void h;
  });
  const doc = at(new THREE.Group(), -0.15, Y, -0.05, 0.28);
  const sheet = mesh(new THREE.BoxGeometry(2.4, 0.015, 3.1), [mat(C.paper), mat(C.paper), mat("#ffffff", { map: docTex, r: 0.6 }), mat(C.paper), mat(C.paper), mat(C.paper)]);
  sheet.position.y = 0.008; doc.add(sheet);
  add(doc);
  // the signature: ink, drawn as the pen moves
  const sig = new THREE.CatmullRomCurve3(Array.from({ length: 40 }, (_, i) => { const u = i / 39; return V(0.0 + 1.0 * u, 0.02, 1.08 - 0.14 * Math.sin(u * Math.PI * 5) * (1 - u * 0.5) - 0.05 * Math.sin(u * Math.PI * 12)); }));
  const ink = mesh(new THREE.TubeGeometry(sig, 240, 0.011, 6), mat(C.ink, { r: 0.3 }), false); doc.add(ink);
  const inkCount = ink.geometry.index!.count;
  // the pen: ink lacquer and gold
  const pen = new THREE.Group(), tilt = new THREE.Group(); pen.add(tilt);
  const nib = at(mesh(new THREE.ConeGeometry(0.04, 0.17, 24), GOLD()), 0, 0.085, 0); nib.rotation.x = Math.PI; tilt.add(nib);
  tilt.add(at(cyl(0.058, 0.048, 1.1, mat(C.ink, { r: 0.12, cc: true })), 0, 0.72, 0), at(cyl(0.062, 0.062, 0.05, GOLD()), 0, 0.2, 0), at(cyl(0.062, 0.062, 0.04, GOLD()), 0, 1.24, 0), at(sph(0.058, mat(C.ink, { r: 0.12, cc: true })), 0, 1.28, 0), at(box(0.018, 0.45, 0.03, GOLD()), 0, 1.05, 0.065));
  tilt.rotation.set(0.35, 0, -0.5); doc.add(pen); add(pen, 0.3, true);
  // the seal: a ring of light and a check
  const sealG = at(new THREE.Group(), -0.62, 0.03, 1.02); doc.add(sealG);
  const sealRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(2.6), side: THREE.DoubleSide, transparent: true })); sealRing.rotation.x = -Math.PI / 2; sealG.add(sealRing);
  const chk = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(-0.09, 0, 0.0), V(-0.03, 0, 0.06), V(0.1, 0, -0.08)], false, "catmullrom", 0), 24, 0.018, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(2.6) }));
  sealG.add(chk);
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.28, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(2.7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); wave.rotation.x = -Math.PI / 2; sealG.add(wave);
  // the desk around it: laptop, cup, plant, phone, a second paper
  const lap = at(new THREE.Group(), 1.9, Y, -1.15, -0.5);
  lap.add(at(rbox(1.3, 0.04, 0.9, 0.02, mat("#cfd3d0", { r: 0.35, m: 0.6 })), 0, 0.02, 0));
  const lid = at(new THREE.Group(), 0, 0.04, -0.45); lid.add(at(rbox(1.3, 0.85, 0.03, 0.02, mat("#cfd3d0", { r: 0.35, m: 0.6 })), 0, 0.425, 0), at(box(1.18, 0.74, 0.005, GLASS()), 0, 0.425, 0.017)); lid.rotation.x = -0.25; lap.add(lid);
  add(lap, 0.2);
  const cup = at(grp(at(cyl(0.16, 0.13, 0.3, CLAY()), 0, 0.15, 0), at(cyl(0.135, 0.135, 0.01, mat("#3b2416", { r: 0.2 })), 0, 0.28, 0), at(mesh(new THREE.TorusGeometry(0.08, 0.022, 10, 24), CLAY()), 0.18, 0.16, 0)), -2.35, Y, -1.25);
  add(cup, 0.2);
  const steam = [0, 1, 2].map((k) => { const b = sph(0.045, mat("#ffffff", { opacity: 0.5 }), 12, 10); b.castShadow = false; cup.add(b); return { b, k }; });
  add(at(grp(at(cyl(0.2, 0.15, 0.32, CLAY()), 0, 0.16, 0), at(tree(0.85, true), 0, 0.3, 0)), 2.35, Y, 1.3), 0.25);
  add(at(rbox(0.45, 0.03, 0.9, 0.06, mat(C.ink, { r: 0.2, cc: true })), -2.2, Y + 0.015, 1.25, 0.35), 0.2);
  add(at(rbox(1.6, 0.01, 2.1, 0.005, mat("#f4f3ee")), 1.5, Y + 0.005, 0.75, -0.18), 0.15);
  // two little figures closing the deal at the edge of the page
  const fa = add(at(figure(CLAY(), 0.62), -1.35, Y, 1.85, 1.3), 0.35), fb = add(at(figure(LIGHT(0.9), 0.62), -0.98, Y, 1.95, -1.9), 0.38);
  const SA = 0.9, SB = 2.35, STAMP = 2.55;
  const _p = V();
  s.tick = (age, t) => {
    const p = easeInOut(seg(age, SA, SB));
    ink.geometry.setDrawRange(0, Math.floor((inkCount * p) / 6) * 6);
    const down = easeOutCubic(seg(age, 0.45, SA)) * (1 - easeInOut(seg(age, SB, SB + 0.5)));
    sig.getPoint(p, _p);
    pen.position.set(_p.x + (1 - down) * 0.4 + (age > SB ? easeInOut(seg(age, SB, SB + 0.8)) * 0.5 : 0), _p.y + (1 - down) * 0.7, _p.z - (1 - down) * 0.25);
    const k = easeOutExpo(seg(age, STAMP, STAMP + 0.6));
    sealG.scale.setScalar(Math.max(0.001, 0.6 + k * 0.4)); sealG.visible = age > STAMP;
    (sealRing.material as THREE.MeshBasicMaterial).opacity = k;
    const w = seg(age, STAMP, STAMP + 1.2); wave.scale.setScalar(1 + w * 3); (wave.material as THREE.MeshBasicMaterial).opacity = (1 - w) * 0.9;
    steam.forEach(({ b, k: kk }) => { const u = (t * 0.45 + kk / 3) % 1; b.position.set(Math.sin(u * 5 + kk) * 0.05, 0.36 + u * 0.75, 0); b.scale.setScalar(0.6 + u * 1.4); (b.material as THREE.MeshStandardMaterial).opacity = 0.45 * (1 - u); });
    const shake = age > STAMP ? Math.sin((age - STAMP) * 14) * 0.02 * (1 - seg(age, STAMP, STAMP + 1)) : 0;
    (fa.userData.body as THREE.Group).position.y = Math.max(0, shake); (fb.userData.body as THREE.Group).position.y = Math.max(0, -shake);
  };
  return s;
}

/* ====================== 3 · Kick-off — the airport ====================== */
function airliner() {
  const g = new THREE.Group();
  const white = mat("#f7f7f4", { r: 0.25, cc: true });
  const fus = mesh(new THREE.CapsuleGeometry(0.24, 2.0, 12, 28), white); fus.rotation.x = Math.PI / 2; g.add(fus);
  for (const x of [-0.235, 0.235]) g.add(at(box(0.01, 0.06, 1.7, GLASS()), x, 0.07, 0.05));
  const ck = at(box(0.28, 0.08, 0.16, GLASS()), 0, 0.12, 1.12); ck.rotation.x = 0.35; g.add(ck);
  const wing = extrude([[0, 0.42], [1.55, -0.3], [1.55, -0.48], [0, -0.32], [-1.55, -0.48], [-1.55, -0.3]], 0.04, white, 0.012);
  wing.geometry.rotateX(Math.PI / 2); wing.position.set(0, -0.08, 0.05); g.add(wing);
  const tail = extrude([[0, -0.18], [0.7, -0.38], [0.7, -0.52], [0, -0.46]], 0.03, white, 0.008);
  tail.geometry.rotateX(Math.PI / 2); tail.position.set(0, 0.06, -0.85); g.add(tail);
  const tail2 = tail.clone(); tail2.scale.set(-1, 1, 1); g.add(tail2);
  const fin = extrude([[0.82, 0.14], [1.3, 0.14], [1.42, 0.8], [1.2, 0.8]], 0.04, mat(C.lime, { e: C.lime, ei: 0.35, r: 0.3, cc: true }), 0.01);
  fin.geometry.rotateY(Math.PI / 2); fin.position.set(-0.02, 0, 0); g.add(fin);
  for (const x of [-0.68, 0.68]) {
    const e = at(cyl(0.11, 0.095, 0.46, white, 28), x, -0.2, 0.3); e.rotation.x = Math.PI / 2; g.add(e);
    const r = at(cyl(0.112, 0.112, 0.03, LIGHT(1.4), 28), x, -0.2, 0.53); r.rotation.x = Math.PI / 2; g.add(r);
  }
  g.scale.setScalar(0.72);
  return g;
}
function sceneKickoff(): Scene {
  const { s, add, addTrail } = makeScene(["#2a62b4", "#040e22"], { az: 0.85, el: 0.42, dist: 22, y: 1.5 });
  const RW = at(new THREE.Group(), 0.55, 0, 0.45, -0.55);
  RW.add(at(rbox(1.25, 0.025, 7.0, 0.01, mat(C.asphalt, { r: 0.9 })), 0, 0.012, 0));
  for (let k = 0; k < 11; k++) RW.add(at(box(0.05, 0.006, 0.3, mat("#f3f3ef")), 0, 0.027, -3.0 + k * 0.6));
  for (const z of [-3.05, 3.05]) for (let k = 0; k < 6; k++) RW.add(at(box(0.06, 0.006, 0.36, mat("#f3f3ef")), -0.42 + k * 0.168, 0.027, z));
  const lights: THREE.Mesh[] = [];
  for (let k = 0; k < 14; k++) for (const x of [-0.68, 0.68]) { const l = at(mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(0.6) }), false), x, 0.04, -3.3 + k * 0.5); l.userData.k = k; lights.push(l); RW.add(l); }
  add(RW, 0);
  // terminal with canopy, control tower, a hangar
  const term = at(new THREE.Group(), -2.15, 0, -1.25, 0.95);
  term.add(building(3.0, 1.15, 2, { fh: 0.42, top: false }));
  term.add(at(rbox(3.3, 0.05, 0.6, 0.02, CLAY()), 0, 0.5, 0.85));
  for (const x of [-1.4, -0.7, 0, 0.7, 1.4]) term.add(at(cyl(0.02, 0.02, 0.48, CLAY(), 8), x, 0.24, 1.1));
  add(term, 0.1);
  const tower = at(new THREE.Group(), -0.75, 0, -2.75);
  tower.add(at(cyl(0.13, 0.19, 1.9, CLAY()), 0, 0.95, 0), at(cyl(0.38, 0.3, 0.3, GLASS()), 0, 2.05, 0), at(cyl(0.44, 0.44, 0.05, CLAY()), 0, 2.23, 0), at(cyl(0.3, 0.3, 0.05, CLAY()), 0, 1.88, 0), at(cyl(0.01, 0.01, 0.4, CLAY(), 6), 0, 2.45, 0));
  const bcn = at(sph(0.035, LIGHT(4), 10, 8), 0, 2.66, 0); tower.add(bcn);
  add(tower, 0.15);
  add(at(building(1.3, 1.0, 2, { fh: 0.4 }), 2.8, 0, -1.4), 0.2);
  ([[-3.2, 1.2], [-2.6, 2.3], [3.1, 1.2], [2.4, 2.6], [-1.4, 3.0], [3.4, -0.2]] as const).forEach(([x, z], i) => add(at(tree(0.95, i % 2 === 1), x, 0, z), 0.25));
  // travellers with their suitcases
  const pax = [0, 1, 2, 3].map((i) => {
    const f = figure(i === 0 ? LIGHT(0.9) : CLAY(), 0.82);
    (f.userData.body as THREE.Group).add(at(rbox(0.16, 0.22, 0.09, 0.02, mat(i % 2 ? C.ink : C.clay2, { r: 0.4 })), 0.17, 0.13, 0));
    const h = new THREE.Group(); h.add(f); add(h, 0.4);
    return { f, h, ph: i * 0.23 };
  });
  // the plane: roll, lift-off, climb, then loops around the island leaving a trail of light
  const pl = airliner(); const plHold = new THREE.Group(); plHold.add(pl); add(plHold, 0.3, true);
  RW.updateMatrix();
  const L = (x: number, y: number, z: number) => V(x, y, z).applyMatrix4(RW.matrix);
  const S0 = L(0, 0.24, -2.75), S1 = L(0, 0.26, 0.6), S2 = L(0, 0.9, 3.0), S3 = L(0, 1.9, 4.6);
  const R = 3.85, LH = 2.7;
  const hdg = L(0, 0, 1).sub(L(0, 0, 0)).normalize();
  const aE = Math.atan2(S3.z, S3.x);
  const dir = Math.sign(hdg.x * -Math.sin(aE) + hdg.z * Math.cos(aE)) || 1;
  const loopPts = Array.from({ length: 10 }, (_, k) => { const a = aE + dir * (0.55 + (k / 10) * Math.PI * 2); return V(Math.cos(a) * R, LH + Math.sin(k * 1.7) * 0.2, Math.sin(a) * R); });
  const loop = new THREE.CatmullRomCurve3(loopPts, true, "centripetal");
  const take = new THREE.CatmullRomCurve3([S0, S1, S2, S3, loopPts[0]], false, "centripetal");
  const takeL = take.getLength(), loopL = loop.getLength();
  const T0 = 0.8, T1 = 3.6, SPEED = takeL / (T1 - T0);
  const trTake = addTrail(trail(take, { len: 0.18, base: 0.22, segs: 220 }));
  const trLoop = addTrail(trail(loop, { len: 0.22, base: 0.0, closed: true, segs: 260 }));
  const pose = (age: number, out: THREE.Vector3) => {
    if (age < T0) return out.copy(S0);
    if (age < T1) { const x = seg(age, T0, T1); return take.getPointAt(2 * x * x - x * x * x, out); }
    return loop.getPointAt((((age - T1) * SPEED) / loopL) % 1, out);
  };
  const _a = V(), _b = V(), _c = V();
  s.tick = (age, t) => {
    pose(age, _a); pose(age + 0.04, _b); pose(age + 0.08, _c);
    pl.position.copy(_a);
    if (_b.distanceToSquared(_a) > 1e-9) pl.lookAt(_b); else pl.lookAt(S1);
    let turn = Math.atan2(_c.z - _b.z, _c.x - _b.x) - Math.atan2(_b.z - _a.z, _b.x - _a.x);
    if (turn > Math.PI) turn -= Math.PI * 2; if (turn < -Math.PI) turn += Math.PI * 2;
    pl.rotateZ(THREE.MathUtils.clamp(-turn * 14, -0.55, 0.55));
    const x = seg(age, T0, T1), p = 2 * x * x - x * x * x;
    trTake.u.uHead.value = age < T1 ? p : 1 + (age - T1) * 0.35;
    trTake.u.uBase.value = 0.22 * (1 - seg(age, T1 + 0.4, T1 + 2.4));
    trLoop.u.uHead.value = age < T1 ? -1 : (((age - T1) * SPEED) / loopL) % 1;
    trLoop.u.uLen.value = 0.28 * seg(age, T1, T1 + 1.2) + 0.0001;
    lights.forEach((l) => { const k = l.userData.k as number; const v = ((t * 9 - k) % 14 + 14) % 14; (l.material as THREE.MeshBasicMaterial).color.set(C.lime).multiplyScalar(v < 1.6 ? 3 : 0.5); });
    bcn.scale.setScalar(0.7 + Math.max(0, Math.sin(t * 4)) * 0.7);
    pax.forEach(({ f, h, ph }) => {
      const u = (t * 0.05 + ph) % 1, A = V(1.9, 0, -2.2), B = V(-1.2, 0, -0.35);
      h.position.x = lerp(A.x, B.x, u); h.position.z = lerp(A.z, B.z, u); h.rotation.y = Math.atan2(B.x - A.x, B.z - A.z);
      stroll(f, t, ph * 7);
    });
  };
  return s;
}

/* ====================== 4 · Project — the site ====================== */
function sceneProject(): Scene {
  const { s, add, addTrail } = makeScene(["#4d6a18", "#070b02"], { az: 0.6, el: 0.4, dist: 22, y: 1.75 });
  const FH = 0.4, B = V(1.15, 0, 0.55), PILE = V(-1.75, 0, 1.3), M = V(-0.45, 0, -1.55), HIGH = 3.05;
  add(at(inlay(2.6, 2.2, "#d9d8cf"), B.x, 0, B.z));
  add(at(inlay(1.4, 1.3, "#d9d8cf"), PILE.x, 0, PILE.z));
  const slab = (glazed: boolean) => {
    const g = new THREE.Group();
    g.add(at(rbox(1.9, 0.06, 1.5, 0.012, CLAY()), 0, -FH / 2 + 0.03, 0));
    if (glazed) g.add(at(box(1.78, FH - 0.06, 1.38, GLASS()), 0, 0.03, 0));
    for (const x of [-1, 1]) for (const z of [-1, 1]) g.add(at(box(0.06, FH - 0.06, 0.06, CLAY()), x * 0.88, 0.03, z * 0.68));
    return g;
  };
  [0, 1].forEach((i) => add(at(slab(true), B.x, 0.03 + FH * (i + 0.5), B.z), 0.1 + i * 0.08));
  const moving = [0, 1, 2].map((b) => add(at(slab(b === 0), PILE.x, FH * (2 - b + 0.5), PILE.z), 0.25, { driven: true, h: 3.8 }));
  const roof = add(at(rbox(1.95, 0.07, 1.55, 0.015, CLAY()), B.x, 0.03 + FH * 5 + 0.04, B.z), 0.3, { driven: true, h: 2.4 });
  // a lattice crane in white with a light on its hook
  const crane = at(new THREE.Group(), M.x, 0, M.z), cM = CLAY();
  crane.add(at(rbox(0.8, 0.22, 0.8, 0.03, cM), 0, 0.11, 0));
  const post = new THREE.CylinderGeometry(0.03, 0.03, 3.4, 8), rung = new THREE.CylinderGeometry(0.016, 0.016, 0.34, 6), diag = new THREE.CylinderGeometry(0.012, 0.012, 0.48, 6);
  for (const x of [-0.16, 0.16]) for (const z of [-0.16, 0.16]) crane.add(at(mesh(post, cM), x, 1.9, z));
  for (let k = 0; k < 9; k++) {
    const y = 0.4 + k * 0.36;
    for (const z of [-0.16, 0.16]) { const r = at(mesh(rung, cM), 0, y, z); r.rotation.z = Math.PI / 2; crane.add(r); const d2 = at(mesh(diag, cM), 0, y + 0.18, z); d2.rotation.z = Math.PI / 2 - 0.82; crane.add(d2); }
    for (const x of [-0.16, 0.16]) { const r = at(mesh(rung, cM), x, y, 0); r.rotation.x = Math.PI / 2; crane.add(r); }
  }
  const head = at(new THREE.Group(), 0, 3.6, 0);
  head.add(at(rbox(0.46, 0.38, 0.46, 0.04, cM), 0, 0.19, 0), at(box(0.02, 0.18, 0.3, GLASS()), 0.235, 0.24, 0));
  head.add(at(rbox(4.2, 0.12, 0.14, 0.02, cM), 0.95, 0.46, 0), at(rbox(0.5, 0.36, 0.4, 0.03, mat(C.clay2)), -0.98, 0.32, 0));
  const apex = V(0, 1.15, 0); head.add(at(cyl(0.03, 0.045, 0.65, cM, 10), 0, 0.82, 0));
  const t1 = rod(0.01, cM), t2 = rod(0.01, cM); span(t1, apex, V(3.0, 0.52, 0)); span(t2, apex, V(-1.1, 0.52, 0)); head.add(t1, t2);
  const trolley = at(rbox(0.22, 0.08, 0.2, 0.02, cM), 2, 0.36, 0); head.add(trolley);
  const cable = rod(0.008, mat(C.ink)); head.add(cable);
  const hook = new THREE.Group(); hook.add(rbox(0.14, 0.12, 0.1, 0.02, LIGHT(2.2))); head.add(hook);
  crane.add(head); add(crane, 0.05);
  // workers in light helmets
  const hard = (x: number, z: number, ry: number) => { const f = figure(CLAY(), 0.85); (f.userData.body as THREE.Group).add(at(mesh(new THREE.SphereGeometry(0.085, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), LIGHT(1)), 0, 1.0, 0)); return add(at(f, x, 0, z, ry), 0.35); };
  hard(-2.45, 2.05, 0.6); hard(2.75, 1.9, -0.7); hard(-1.0, 2.3, 0.2);
  ([[-3.2, -0.2], [3.2, -0.9], [2.9, -2.2], [-2.6, -2.1], [0.6, 3.2]] as const).forEach(([x, z], i) => add(at(tree(1, i % 2 === 0), x, 0, z), 0.3));
  for (let k = 0; k < 7; k++) add(at(box(0.5, 0.16, 0.03, mat(C.clay2)), -0.4 + k * 0.55, 0.08, 2.0), 0.3);
  // the plan, as light: four bars filling up beside the building
  const gantt = at(new THREE.Group(), 2.85, 1.55, -0.35, 0.6); add(gantt, 1.0, true);
  const fills = [0, 1, 2, 3].map((k) => {
    const y = 0.45 - k * 0.3, x0 = -0.45 + k * 0.18, w = [0.7, 0.8, 0.65, 0.75][k];
    gantt.add(at(rbox(w, 0.14, 0.02, 0.02, holo(0.12)), x0 + w / 2, y, 0));
    const f = at(box(w, 0.1, 0.03, LIGHT(2.2)), x0 + w / 2, y, 0); gantt.add(f); f.userData.w = w; f.userData.x0 = x0;
    return f;
  });
  const path = new THREE.CatmullRomCurve3([V(PILE.x, 0.05, PILE.z), V(-0.3, 0.05, 1.2), V(B.x - 0.95, 0.05, B.z + 0.5)]);
  const tr = addTrail(trail(path, { len: 0.3, base: 0.0, r: 0.016 }));
  const aim = (p: THREE.Vector3) => ({ th: Math.atan2(-(p.z - M.z), p.x - M.x), r: Math.hypot(p.x - M.x, p.z - M.z) });
  const P0 = aim(PILE), B0 = aim(B);
  const CYC = 1.6, START = 0.9, PH = [0.35, 0.58, 0.88, 1.3, 1.5, 1.6];
  s.tick = (age, t) => {
    let th = B0.th, r = B0.r, hy = HIGH, done = 0;
    for (let b = 0; b < 3; b++) {
      const a = age - (START + b * CYC), blk = moving[b];
      const pileTop = FH * (3 - b), top = 0.03 + FH * (3 + b);
      if (a < 0) { blk.position.set(PILE.x, FH * (2 - b + 0.5), PILE.z); blk.rotation.y = 0; continue; }
      if (a >= PH[5]) { done++; blk.position.set(B.x, 0.03 + FH * (2 + b + 0.5), B.z); blk.rotation.y = 0; continue; }
      if (a < PH[0]) { const e = easeInOut(a / PH[0]); th = lerp(B0.th, P0.th, e); r = lerp(B0.r, P0.r, e); }
      else if (a < PH[1]) { th = P0.th; r = P0.r; hy = lerp(HIGH, pileTop + 0.1, easeInOut((a - PH[0]) / (PH[1] - PH[0]))); }
      else if (a < PH[2]) { th = P0.th; r = P0.r; hy = lerp(pileTop + 0.1, HIGH, easeInOut((a - PH[1]) / (PH[2] - PH[1]))); }
      else if (a < PH[3]) { const e = easeInOut((a - PH[2]) / (PH[3] - PH[2])); th = lerp(P0.th, B0.th, e); r = lerp(P0.r, B0.r, e); }
      else { th = B0.th; r = B0.r; hy = lerp(HIGH, top + 0.1, easeOutCubic((a - PH[3]) / (PH[4] - PH[3]))); }
      const carrying = a >= PH[1] && a < PH[4] + 0.02;
      if (carrying) { blk.position.set(M.x + Math.cos(th) * r, hy - 0.1 - FH / 2, M.z - Math.sin(th) * r); blk.rotation.y = th - B0.th + Math.sin(t * 2.5) * 0.03; }
      else blk.position.set(PILE.x, FH * (2 - b + 0.5), PILE.z);
      break;
    }
    if (done === 3) hy = lerp(0.03 + FH * 5 + 0.2, HIGH, easeOutCubic(seg(age, START + 2 * CYC + PH[5], START + 2 * CYC + PH[5] + 0.8)));
    head.rotation.y = th; trolley.position.x = r;
    const ly = hy - 3.6; hook.position.set(r, ly + 0.06, 0);
    span(cable, V(r, 0.32, 0), V(r, ly + 0.12, 0));
    roof.visible = done === 3; roof.position.y = 0.03 + FH * 5 + 0.04;
    const prog = (done + seg(age - START - Math.min(done, 2) * CYC, 0, CYC)) / 3;
    fills.forEach((f, k) => { const p = Math.max(0.001, clamp01(prog * 1.4 - k * 0.25)); const w = f.userData.w as number; f.scale.x = p; f.position.x = (f.userData.x0 as number) + (w * p) / 2; });
    gantt.position.y = 1.5 + Math.sin(t * 1.1) * 0.03;
    tr.u.uHead.value = (t * 0.4) % 1.4;
  };
  return s;
}

/* ====================== 5 · Billing — the bank ====================== */
function sceneBilling(): Scene {
  const { s, add, addTrail } = makeScene(["#7a5815", "#0d0902"], { az: 0.68, el: 0.48, dist: 21, y: 1.3 });
  // a classical bank, in clay
  const bank = at(new THREE.Group(), -1.35, 0, -1.2, 0.7);
  [[3.0, 2.2], [2.8, 2.0], [2.6, 1.8]].forEach(([w, d], k) => bank.add(at(rbox(w, 0.08, d, 0.01, CLAY()), 0, 0.04 + k * 0.08, 0)));
  for (let k = 0; k < 6; k++) bank.add(at(cyl(0.08, 0.09, 1.2, CLAY(), 24), -1.05 + k * 0.42, 0.84, 0.72));
  bank.add(at(box(2.3, 1.2, 1.3, CLAY()), 0, 0.84, -0.15), at(box(1.9, 0.9, 0.02, GLASS()), 0, 0.75, 0.51));
  bank.add(at(rbox(2.75, 0.12, 1.95, 0.01, CLAY()), 0, 1.5, 0));
  const ped = extrude([[-1.38, 0], [1.38, 0], [0, 0.48]], 1.9, CLAY(), 0.01); ped.position.set(0, 1.56, -0.95); bank.add(ped);
  add(bank, 0.05);
  // the client's office, money flows home along the light
  const cl = add(at(building(1.4, 1.2, 4), 2.45, 0, -1.3), 0.15);
  add(at(building(1.1, 1.0, 2), 2.75, 0, 0.95), 0.2);
  const flow = new THREE.QuadraticBezierCurve3(V(2.45, cl.userData.H + 0.2, -1.3), V(0.6, 4.0, -1.6), V(-1.3, 2.35, -1.1));
  const tr = addTrail(trail(flow, { len: 0.25, base: 0.14, color: "#ffd27a" }));
  const cg = coinGeo();
  const flying = [0, 1, 2, 3].map(() => { const c = mesh(cg, GOLD(), false); c.rotation.x = Math.PI / 2; const h = new THREE.Group(); h.add(c); s.group.add(h); return h; });
  // coin towers: a growing chart in gold
  const TOW = [V(-0.2, 0, 1.25), V(0.5, 0, 1.4), V(1.2, 0, 1.55), V(1.9, 0, 1.7)], BASE = [3, 5, 7, 9], ADD = [3, 4, 5, 7];
  TOW.forEach((p, i) => { for (let k = 0; k < BASE[i]; k++) add(at(mesh(cg, GOLD()), p.x, k * 0.072, p.z, k * 0.5), 0.2 + k * 0.01); });
  const drops: { m: THREE.Mesh; i: number; lvl: number; t0: number }[] = [];
  let n = 0;
  for (let r = 0; r < 7; r++) for (let i = 0; i < 4; i++) if (r < ADD[i]) { const m = mesh(cg, GOLD()); add(m, 0, { driven: true, h: 3.4 }); drops.push({ m, i, lvl: BASE[i] + r, t0: 1.7 + n * 0.11 }); n++; }
  // the invoice: a floating panel, stamped paid
  const invTex = canvasTex(600, 760, () => {});
  const drawInv = (paid: number) => (g: CanvasRenderingContext2D, w: number, h: number) => {
    const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "rgba(24,52,44,0.96)"); gr.addColorStop(1, "rgba(8,22,17,0.96)");
    g.fillStyle = gr; rr(g, 0, 0, w, h, 36); g.fill();
    g.strokeStyle = "rgba(195,239,92,0.55)"; g.lineWidth = 3; rr(g, 2, 2, w - 4, h - 4, 34); g.stroke();
    g.fillStyle = "#ffffff"; g.font = `800 44px ${FONT}`; g.fillText("Invoice", 50, 92);
    g.fillStyle = "rgba(255,255,255,0.55)"; g.font = `500 24px ${FONT}`; g.fillText("INV-0142  ·  Halden & Moss", 50, 134);
    g.fillStyle = "rgba(255,255,255,0.14)"; for (let k = 0; k < 6; k++) { g.fillRect(50, 200 + k * 54, 300, 14); g.fillRect(w - 170, 200 + k * 54, 120, 14); }
    g.fillStyle = "rgba(255,255,255,0.55)"; g.font = `600 24px ${FONT}`; g.fillText("Total", 50, 570);
    g.fillStyle = "#ffffff"; g.font = `800 58px ${FONT}`; g.fillText("12,000 €", 50, 640);
    if (paid > 0) {
      g.save(); g.globalAlpha = paid; g.translate(w - 150, 600); g.rotate(-0.22);
      g.fillStyle = C.lime; rr(g, -110, -44, 220, 88, 44); g.fill();
      g.fillStyle = C.ink; g.font = `800 42px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("PAID", 0, 2); g.restore();
    }
  };
  redraw(invTex, drawInv(0));
  const inv = at(new THREE.Group(), 2.05, 2.55, 0.35, 0.68);
  const panel = mesh(new THREE.PlaneGeometry(1.2, 1.52), new THREE.MeshBasicMaterial({ map: invTex, transparent: true, side: THREE.DoubleSide, clippingPlanes: CLIPS }), false);
  inv.add(panel); add(inv, 0.9, true);
  ([[-3.2, 0.8], [-2.8, 1.9], [3.3, -0.1], [-0.3, -3.1], [0.8, -2.8]] as const).forEach(([x, z], i) => add(at(tree(0.95, i % 2 === 1), x, 0, z), 0.3));
  const fa = add(at(figure(LIGHT(0.9), 0.85), -0.7, 0, 0.35, 0.8), 0.35);
  add(at(figure(CLAY(), 0.85), -0.35, 0, 0.6, -2.3), 0.35);
  const PAID = 2.6;
  let paidK = -1;
  const _p = V();
  s.tick = (age, t, out) => {
    tr.u.uHead.value = (t * 0.42) % 1.25; tr.u.uBase.value = 0.14 * smooth(seg(age, 0.6, 1.2));
    flying.forEach((h, i) => { const u = (t * 0.42 + i * 0.25) % 1; h.visible = age > 0.8; flow.getPoint(u, _p); h.position.copy(_p); h.rotation.y = t * 3 + i; h.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * u) * (1 - out))); });
    drops.forEach(({ m, i, lvl, t0 }) => {
      const p = TOW[i], y1 = lvl * 0.072;
      if (age < t0) { m.position.y = -9; return; }
      const u = easeOutCubic(seg(age, t0, t0 + 0.55));
      m.position.set(p.x, lerp(y1 + 1.6, y1, u), p.z); m.rotation.set((1 - u) * 1.2, lvl * 0.5 + (1 - u) * 2, 0);
    });
    const k = Math.round(easeOutCubic(seg(age, PAID, PAID + 0.4)) * 10) / 10;
    if (k !== paidK) { paidK = k; redraw(invTex, drawInv(k)); }
    inv.rotation.y = 0.68 + Math.sin(t * 0.7) * 0.1; inv.position.y = 2.55 + Math.sin(t * 1.1) * 0.05;
    stroll(fa, t * 0.2);
  };
  return s;
}

/* ====================== 6 · Renewal — the park ====================== */
function sceneRenewal(): Scene {
  const { s, add, addTrail } = makeScene(["#12875a", "#02140b"], { az: 0.62, el: 0.42, dist: 21.5, y: 1.6 });
  const ringPath = lathe([[1.75, 0.012], [2.35, 0.012], [2.35, 0.0], [1.75, 0.0]], mat(C.path), 96); ringPath.castShadow = false; add(ringPath);
  add(at(cyl(1.05, 1.1, 0.12, CLAY(), 64), 0, 0.06, 0));
  // the tree grows: trunk, then the crown, sphere by sphere
  const T = at(new THREE.Group(), 0, 0.12, 0); add(T);
  const trunkG = new THREE.CylinderGeometry(0.07, 0.12, 1.6, 16); trunkG.translate(0, 0.8, 0);
  const trunk = mesh(trunkG, CLAY()); T.add(trunk);
  const brs = ([[0.7, 0.95, 0.3], [-0.75, 1.15, 2.4], [0.6, 1.3, 4.3]] as const).map(([rz, y, ry]) => { const g = at(new THREE.Group(), 0, y, 0, ry); const bg = new THREE.CylinderGeometry(0.03, 0.05, 0.7, 10); bg.translate(0, 0.35, 0); const b = mesh(bg, CLAY()); b.rotation.z = rz; g.add(b); T.add(g); return g; });
  const crown = ([[0, 2.15, 0, 0.75], [0.62, 1.85, 0.25, 0.55], [-0.62, 1.9, -0.15, 0.58], [0.15, 1.75, -0.65, 0.52], [-0.25, 1.7, 0.6, 0.5], [0.35, 2.55, -0.2, 0.45], [-0.4, 2.5, 0.25, 0.42]] as const).map(([x, y, z, r]) => { const c = at(sph(r, mat(C.sage), 32, 24), x, y, z); T.add(c); return c; });
  const buds = ([[0.55, 1.65, 0.62], [-0.72, 1.98, 0.42], [0.25, 2.75, 0.4], [0.9, 2.1, 0.0], [-0.3, 1.55, 0.86]] as const).map(([x, y, z]) => { const b = at(sph(0.06, LIGHT(2.5), 14, 12), x, y, z); T.add(b); return b; });
  // the renewal loop around the tree
  const loopC = new THREE.CatmullRomCurve3(Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * Math.PI * 2; return V(Math.cos(a) * 2.05, 0.35 + Math.sin(a * 2) * 0.12, Math.sin(a) * 2.05); }), true);
  const tr = addTrail(trail(loopC, { closed: true, len: 0.4, base: 0.28, r: 0.03, segs: 240 }));
  // the client's building gains a floor
  const cb = add(at(building(1.6, 1.3, 4, { top: false }), -2.3, 0, -1.9, 0.3), 0.1);
  const extra = at(new THREE.Group(), -2.3, 0, -1.9, 0.3);
  const ex = building(1.6, 1.3, 1, { crown: true, top: false }); ex.position.y = cb.userData.H; extra.add(ex); add(extra, 0.1, { driven: true, h: cb.userData.H + 0.9 });
  add(at(building(1.2, 1.0, 2), 2.6, 0, -2.0), 0.15);
  // benches, trees, people strolling the loop
  ([[2.75, 0.55, -1.3], [-0.1, 2.8, 0.0], [-2.85, 0.6, 1.4]] as const).forEach(([x, z, ry]) => add(at(grp(at(rbox(0.7, 0.05, 0.22, 0.015, CLAY()), 0, 0.22, 0), at(rbox(0.7, 0.2, 0.04, 0.015, CLAY()), 0, 0.36, -0.1), at(box(0.04, 0.2, 0.2, CLAY()), -0.3, 0.1, 0), at(box(0.04, 0.2, 0.2, CLAY()), 0.3, 0.1, 0)), x, 0, z, ry), 0.25));
  ([[3.3, 1.6], [2.4, 2.9], [-3.4, -0.3], [-1.0, 3.3], [3.4, -0.6], [0.6, -3.3]] as const).forEach(([x, z], i) => add(at(tree(1, i % 2 === 0), x, 0, z), 0.3));
  const walkers = [0, 1, 2].map((i) => ({ f: add(at(figure(i === 0 ? LIGHT(0.9) : CLAY(), 0.85), 0, 0, 0), 0.4), ph: i / 3 }));
  const _p = V(), _q = V();
  s.tick = (age, t) => {
    trunk.scale.set(1, Math.max(0.001, easeOutCubic(seg(age, 0.4, 1.4))), 1);
    brs.forEach((b, i) => b.scale.setScalar(Math.max(0.001, easeOutCubic(seg(age, 1.0 + i * 0.12, 1.6 + i * 0.12)))));
    crown.forEach((c, i) => c.scale.setScalar(Math.max(0.001, easeOutExpo(seg(age, 1.25 + i * 0.13, 2.1 + i * 0.13)))));
    buds.forEach((b, i) => b.scale.setScalar(Math.max(0.001, easeOutExpo(seg(age, 2.5 + i * 0.12, 3.0 + i * 0.12)) * (0.85 + Math.sin(t * 3 + i) * 0.15))));
    T.rotation.z = Math.sin(t * 0.9) * 0.012;
    tr.u.uHead.value = (t * 0.16) % 1; tr.u.uFade.value = smooth(seg(age, 0.8, 1.6));
    const g = easeOutExpo(seg(age, 2.2, 3.4));
    extra.position.y = (g - 1) * (cb.userData.H + 0.6);
    walkers.forEach(({ f, ph }) => {
      const a = t * 0.09 + ph * Math.PI * 2;
      _p.set(Math.cos(a) * 2.05, 0, Math.sin(a) * 2.05); _q.set(Math.cos(a + 0.05) * 2.05, 0, Math.sin(a + 0.05) * 2.05);
      f.position.x = _p.x; f.position.z = _p.z; f.rotation.y = Math.atan2(_q.x - _p.x, _q.z - _p.z); stroll(f, t, ph * 9);
    });
  };
  return s;
}

/* ====================== the world ====================== */
export function createWorld(canvas: HTMLCanvasElement, opts: { step: number; reduced: boolean }): LoginWorld | null {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" }); }
  catch { return null; }
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex; scene.environmentIntensity = 0.32;
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 200);

  // the backdrop: a dithered radial gradient that follows the world
  const bgU = { uA: { value: new THREE.Color("#1b6a4f") }, uB: { value: new THREE.Color("#03140d") }, uAsp: { value: 1 } };
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: bgU, depthWrite: false, depthTest: false,
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }",
    fragmentShader: `uniform vec3 uA, uB; uniform float uAsp; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){ vec2 p = vUv - vec2(0.5, 0.6); p.x *= uAsp; float d = length(p);
        vec3 c = mix(uA, uB, smoothstep(0.0, 0.95, d)); c += (h(gl_FragCoord.xy) - 0.5) / 160.0; gl_FragColor = vec4(c, 1.0); }`,
  }));
  bg.frustumCulled = false; bg.renderOrder = -10; scene.add(bg);

  scene.add(new THREE.HemisphereLight("#ffffff", "#c9d6cf", 0.5));
  const key = new THREE.DirectionalLight("#fff6ea", 1.35);
  key.position.set(6, 11, 5); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 35 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02; key.shadow.radius = 6;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#d8ffb0", 0.4); rim.position.set(-7, 6, -8); scene.add(rim);

  /* the plinth */
  const world = new THREE.Group(); scene.add(world);
  const plinth = new THREE.Group(); world.add(plinth);
  const topM = new THREE.MeshStandardMaterial({ color: C.clay, roughness: 0.9 });
  const top = mesh(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R, 0.08, 160), topM, false); top.position.y = -0.04; plinth.add(top);
  const sideM = new THREE.MeshStandardMaterial({ color: "#0f2a21", roughness: 0.45, metalness: 0.2 });
  const side = mesh(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R * 0.96, 0.42, 160), sideM, false); side.position.y = -0.29; plinth.add(side);
  const hairM = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(2.7) });
  const hair = new THREE.Mesh(new THREE.TorusGeometry(PLINTH_R + 0.004, 0.012, 8, 220), hairM);
  hair.rotation.x = Math.PI / 2; hair.position.y = -0.085; plinth.add(hair);
  // the sweep: a ring of light that runs over the table when the world changes
  const sweepM = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(2.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const sweep = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 160), sweepM); sweep.rotation.x = -Math.PI / 2; sweep.position.y = 0.006; world.add(sweep);
  // dust in the light
  const dustGeo = new THREE.BufferGeometry();
  const dp = new Float32Array(220 * 3); for (let i = 0; i < 220; i++) { dp[i * 3] = (Math.random() - 0.5) * 22; dp[i * 3 + 1] = Math.random() * 10 - 2; dp[i * 3 + 2] = (Math.random() - 0.5) * 22; }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: "#ffffff", size: 0.035, transparent: true, opacity: 0.4, depthWrite: false }));
  scene.add(dust);

  const scenes = [sceneContact(), sceneDeal(), sceneContract(), sceneKickoff(), sceneProject(), sceneBilling(), sceneRenewal()];
  scenes.forEach((sc) => { sc.group.visible = false; world.add(sc.group); });

  /* post: MSAA, bloom on the light, tone mapping */
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.65, 0.5, 2.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let cur = Math.max(0, Math.min(6, opts.step)), prev = -1;
  const t0 = performance.now();
  const now0 = () => (performance.now() - t0) / 1000;
  let enterAt = 0.2, prevEnter = 0, leaveAt = -99, changedAt = -99;
  let spinTarget = 0, spin = 0;
  const cam = { ...scenes[cur].cam };
  const tA = new THREE.Color(), tB = new THREE.Color();
  bgU.uA.value.set(scenes[cur].bg[0]); bgU.uB.value.set(scenes[cur].bg[1]);
  let inset = 0, W = 1, H = 1;
  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
    composer.setPixelRatio(dpr); composer.setSize(W, H);
    camera.aspect = W / H;
    camera.setViewOffset(W, H, 0, Math.round(inset * 0.5), W, H);
    camera.updateProjectionMatrix();
    bgU.uAsp.value = W / H;
  };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ptr.tx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    ptr.ty = ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1;
  };
  window.addEventListener("pointermove", onMove);

  /** rise / sink: actors come out of the plinth in a wave from the centre */
  const place = (sc: Scene, age: number, leaving: number) => {
    sc.actors.forEach((a) => {
      let k: number;
      if (leaving >= 0) { const d = (a.delay - 0.12) * 0.45; k = 1 - easeInCubic(seg(leaving, d, d + 0.6)); }
      else k = easeOutExpo(seg(age, a.delay, a.delay + 1.25));
      if (a.air) { const q = Math.max(0.0001, k); a.o.scale.set(a.s0.x * q, a.s0.y * q, a.s0.z * q); }
      else if (a.driven) a.o.position.y -= (1 - k) * a.h;
      else a.o.position.y = a.y0 - (1 - k) * a.h;
      a.o.visible = k > 0.002;
    });
  };

  let raf = 0, alive = true, last = 0, slow = 0, frames = 0;
  const frame = (now: number, dt: number) => {
    const target = scenes[cur];
    const kk = 1 - Math.exp(-dt * 2.2);
    tA.set(target.bg[0]); tB.set(target.bg[1]);
    bgU.uA.value.lerp(tA, kk); bgU.uB.value.lerp(tB, kk);
    for (const k of ["az", "el", "dist", "y"] as const) cam[k] = lerp(cam[k], target.cam[k], kk * 0.7);
    spin = lerp(spin, spinTarget, 1 - Math.exp(-dt * 1.8));
    ptr.x = lerp(ptr.x, ptr.tx, 1 - Math.exp(-dt * 2.5)); ptr.y = lerp(ptr.y, ptr.ty, 1 - Math.exp(-dt * 2.5));
    world.rotation.y = spin + Math.sin(now * 0.12) * 0.06;
    world.position.y = Math.sin(now * 0.6) * 0.04;
    CLIP.constant = -world.position.y + 0.001;
    const sw = seg(now, changedAt + 0.05, changedAt + 1.5);
    sweep.visible = sw > 0 && sw < 1;
    sweep.scale.setScalar(0.05 + easeOutCubic(sw) * (PLINTH_R - 0.05)); sweepM.opacity = Math.sin(sw * Math.PI) * 0.55;
    hairM.color.set(C.lime).multiplyScalar(2.2 + Math.sin(sw * Math.PI) * 1.2);
    const asp = W / H, fit = (asp < 1.25 ? 1.25 / asp : 1) * 1.08;
    const az = cam.az + ptr.x * 0.05, el = cam.el - ptr.y * 0.03, dist = cam.dist * fit;
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, cam.y + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(0, cam.y, 0);
    scenes.forEach((sc, i) => {
      if (i === cur) {
        sc.group.visible = true;
        const age = now - enterAt;
        sc.tick(Math.max(0, age), now, 0); place(sc, age, -1);
      } else if (i === prev) {
        const l = now - leaveAt;
        if (l > 1.4) { sc.group.visible = false; return; }
        sc.tick(now - prevEnter, now, smooth(seg(l, 0, 0.5))); place(sc, 99, l);
        sc.trails.forEach((tr) => { tr.u.uFade.value = 1 - smooth(seg(l, 0, 0.5)); });
      } else sc.group.visible = false;
    });
    dust.rotation.y = now * 0.015;
    composer.render(dt);
  };
  const loop = () => {
    if (!alive) return;
    const now = now0(), dt = Math.min(0.05, now - last); last = now;
    // keep it smooth on slower machines: drop to a lower pixel ratio once
    frames++; if (dt > 1 / 38) slow++;
    if (frames === 120) { if (slow > 60 && dpr > 1.25) { dpr = 1.25; resize(); } frames = 0; slow = 0; }
    frame(now, dt);
    raf = requestAnimationFrame(loop);
  };
  if (opts.reduced) { enterAt = -99; frame(0, 1); } else raf = requestAnimationFrame(loop);

  return {
    setStep: (k: number) => {
      if (k === cur || k < 0 || k > 6) return;
      const now = now0();
      if (prev >= 0 && prev !== k) scenes[prev].group.visible = false;
      prev = cur; prevEnter = enterAt; cur = k; leaveAt = now; enterAt = now + 0.45; changedAt = now;
      spinTarget += 0.75;
      scenes[cur].group.rotation.y = -spinTarget;
      scenes[cur].trails.forEach((tr) => { tr.u.uFade.value = 1; });
      if (opts.reduced) { enterAt = -99; spin = spinTarget; prev = -1; frame(now, 1); }
    },
    setInset: (px: number) => { inset = px; resize(); if (opts.reduced) frame(0, 1); },
    dispose: () => {
      alive = false; cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("pointermove", onMove);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mm = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mm) ? mm : mm ? [mm] : []).forEach((x) => { (x as THREE.MeshStandardMaterial).map?.dispose(); x.dispose(); });
      });
      cache.clear(); figGeo = null;
      composer.dispose(); rt.dispose(); envTex.dispose(); pmrem.dispose(); renderer.dispose();
    },
  };
}
