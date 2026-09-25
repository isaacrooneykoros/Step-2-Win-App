import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Shape,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Texture,
  TorusGeometry,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { rand } from './path';

const FONT = '"DM Sans Variable", "DM Sans", system-ui, sans-serif';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

// ---------------------------------------------------------------------------------------------
// Blob / contact shadow
// ---------------------------------------------------------------------------------------------

let blobTex: Texture | null = null;
export function blobTexture() {
  if (blobTex) return blobTex;
  const { c, ctx } = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTex = new CanvasTexture(c);
  return blobTex;
}

export function releaseSharedTextures() {
  blobTex?.dispose();
  blobTex = null;
}

export function makeBlob(opacity: number) {
  const m = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity, depthWrite: false, color: 0x000000, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  m.renderOrder = 1;
  m.scale.set(0.95, 1, 0.8);
  return m;
}

// ---------------------------------------------------------------------------------------------
// "You" marker: a soft ring on the ground in the brand colour.
// ---------------------------------------------------------------------------------------------

export function makeYouRing(color: Color) {
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, side: DoubleSide });
  const ring = new Mesh(new RingGeometry(0.46, 0.56, 48).rotateX(-Math.PI / 2), mat);
  ring.renderOrder = 2;
  return ring;
}

// ---------------------------------------------------------------------------------------------
// Glowing footfalls
// ---------------------------------------------------------------------------------------------

function footprintTexture() {
  const { c, ctx } = canvas(64, 128);
  ctx.fillStyle = '#fff';
  ctx.filter = 'blur(2px)';
  ctx.beginPath();
  ctx.ellipse(32, 44, 20, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(34, 100, 15, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  const t = new CanvasTexture(c);
  return t;
}

export class Footfalls {
  readonly mesh: InstancedMesh;
  private life: number[] = [];
  private slots: Array<{ pos: Vector3; yaw: number; mirror: number }> = [];
  private next = 0;
  private texture: Texture;
  private readonly count = 20;
  private dummy = new Object3D();

  constructor(color: Color) {
    this.texture = footprintTexture();
    const mat = new MeshBasicMaterial({
      map: this.texture,
      color,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(0.13, 0.27).rotateX(-Math.PI / 2), mat, this.count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    for (let i = 0; i < this.count; i++) {
      this.life.push(0);
      this.slots.push({ pos: new Vector3(), yaw: 0, mirror: 1 });
      this.mesh.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
      this.mesh.setColorAt(i, new Color(0, 0, 0));
    }
  }

  setColor(c: Color) {
    (this.mesh.material as MeshBasicMaterial).color.copy(c);
  }

  add(pos: Vector3, yaw: number, foot: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.slots[i].pos.copy(pos).setY(pos.y + 0.012);
    this.slots[i].yaw = yaw;
    this.slots[i].mirror = foot === 0 ? 1 : -1;
    this.life[i] = 1;
  }

  clear() {
    this.life.fill(0);
    this.update(0);
  }

  /** Fades marks out over ~2.6 s. Returns true while any mark is visible. */
  update(dt: number) {
    let any = false;
    const col = new Color();
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] > 0) this.life[i] = Math.max(0, this.life[i] - dt / 2.6);
      const l = this.life[i];
      const s = this.slots[i];
      if (l > 0) any = true;
      this.dummy.position.copy(s.pos);
      this.dummy.rotation.set(0, s.yaw, 0);
      const pop = l > 0.92 ? 1 + (l - 0.92) * 4 : 1;
      this.dummy.scale.set(l > 0 ? s.mirror * pop : 0, 1, l > 0 ? pop : 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      const k = Math.pow(l, 1.4) * 1.6;
      this.mesh.setColorAt(i, col.setScalar(k));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return any;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Step counter card: a small world-space card with Lucide's shield-check and a live count.
// ---------------------------------------------------------------------------------------------

/** Lucide "shield-check" (ISC licence) path data, drawn at 24×24. */
const SHIELD_PATH =
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';
const CHECK_PATH = 'm9 12 2 2 4-4';

export interface CardColors {
  card: string;
  text: string;
  muted: string;
  brand: string;
  border: string;
}

export class StepCounter {
  readonly sprite: Sprite;
  private texture: CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private value = -1;
  private colors: CardColors;

  constructor(colors: CardColors) {
    const { c, ctx } = canvas(560, 176);
    this.ctx = ctx;
    this.colors = colors;
    this.texture = new CanvasTexture(c);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new SpriteMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false, fog: false });
    this.sprite = new Sprite(mat);
    this.sprite.scale.set(1.9, 1.9 * (176 / 560), 1);
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 10;
  }

  setColors(colors: CardColors) {
    this.colors = colors;
    const v = this.value;
    this.value = -1;
    this.set(Math.max(0, v));
  }

  set(value: number) {
    if (value === this.value) return;
    this.value = value;
    const { ctx } = this;
    const { card, text, muted, brand, border } = this.colors;
    const W = 560;
    const H = 176;
    ctx.clearRect(0, 0, W, H);
    // Card
    const r = 44;
    ctx.beginPath();
    ctx.roundRect(8, 8, W - 16, H - 16, r);
    ctx.fillStyle = card;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = border;
    ctx.stroke();
    // Icon tile
    ctx.save();
    ctx.translate(40, 40);
    ctx.beginPath();
    ctx.roundRect(0, 0, 96, 96, 26);
    ctx.fillStyle = brand;
    ctx.fill();
    ctx.translate(18, 18);
    ctx.scale(2.5, 2.5);
    ctx.strokeStyle = card;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(SHIELD_PATH));
    ctx.stroke(new Path2D(CHECK_PATH));
    ctx.restore();
    // Text
    ctx.fillStyle = text;
    ctx.font = `700 64px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(value.toLocaleString('en-KE'), 162, 96);
    ctx.fillStyle = muted;
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText('verified steps', 164, 136);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    (this.sprite.material as SpriteMaterial).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Milestone flag with the Step2Win stair glyph; cloth waves in the vertex shader.
// ---------------------------------------------------------------------------------------------

function flagTexture(brand: string, fg: string, reward: string) {
  const { c, ctx } = canvas(256, 160);
  ctx.fillStyle = brand;
  ctx.fillRect(0, 0, 256, 160);
  // BrandMark glyph (40×40 viewBox) centred.
  ctx.save();
  ctx.translate(128 - 60, 80 - 60);
  ctx.scale(3, 3);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M11 29h6.5v-6.5H24V16h6.5V9.5'));
  ctx.beginPath();
  ctx.arc(30.5, 9.5, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = reward;
  ctx.fill();
  ctx.restore();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class Flag {
  readonly group = new Group();
  private cloth: Mesh;
  private time = { value: 0 };
  private texture: CanvasTexture;
  private raise = { value: 1 };

  constructor(colors: { brand: string; fg: string; reward: string }) {
    const pole = new Mesh(new CylinderGeometry(0.035, 0.045, 3.4, 10), new MeshStandardMaterial({ color: 0xd9dde0, metalness: 0.7, roughness: 0.3 }));
    pole.position.y = 1.7;
    pole.castShadow = true;
    const cap = new Mesh(new CylinderGeometry(0.07, 0.07, 0.05, 12), pole.material);
    cap.position.y = 3.42;
    this.texture = flagTexture(colors.brand, colors.fg, colors.reward);
    const geo = new PlaneGeometry(1.35, 0.85, 18, 8);
    geo.translate(0.675, 0, 0);
    const mat = new MeshStandardMaterial({ map: this.texture, side: DoubleSide, roughness: 0.8 });
    mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float k = position.x / 1.35;
          transformed.z += sin(position.x * 4.2 - uTime * 5.0) * 0.09 * k + sin(position.y * 3.0 + uTime * 2.3) * 0.03 * k;
          transformed.y -= k * k * 0.06;`,
        );
    };
    this.cloth = new Mesh(geo, mat);
    this.cloth.position.set(0.04, 2.95, 0);
    this.cloth.castShadow = true;
    this.group.add(pole, cap, this.cloth);
  }

  /** 0 = lowered at half-mast, 1 = at the top. */
  setRaise(v: number) {
    this.raise.value = v;
    this.cloth.position.y = 1.7 + v * 1.25;
  }

  update(dt: number) {
    this.time.value += dt;
  }

  dispose() {
    this.texture.dispose();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as MeshStandardMaterial).dispose();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The pool: a stone basin heaped with KSh coins, and coin streams to those who qualified.
// ---------------------------------------------------------------------------------------------

function coinFaceTexture(ink: string, face: string) {
  const { c, ctx } = canvas(128, 128);
  ctx.fillStyle = face;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = ink;
  ctx.font = `800 40px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('KSh', 64, 67);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class Pool {
  readonly group = new Group();
  readonly stream: InstancedMesh;
  private heap: InstancedMesh;
  private faceTexture: CanvasTexture;
  private coins: Array<{ target: number; t: number; speed: number; spin: number; offset: Vector3; active: boolean }> = [];
  private dummy = new Object3D();
  private coinMats: MeshStandardMaterial[];
  readonly surfaceY: number;
  private glow: Mesh;

  constructor(colors: { reward: string; ink: string }) {
    const stone = new MeshStandardMaterial({ color: 0xb9ae9a, roughness: 0.85 });
    const rim = new Mesh(new TorusGeometry(1.2, 0.16, 14, 48).rotateX(Math.PI / 2), stone);
    rim.position.y = 0.3;
    rim.castShadow = true;
    rim.receiveShadow = true;
    const wall = new Mesh(new CylinderGeometry(1.24, 1.32, 0.32, 48, 1, true), stone);
    wall.position.y = 0.17;
    wall.receiveShadow = true;
    const base = new Mesh(new CylinderGeometry(1.15, 1.15, 0.08, 40), stone);
    base.position.y = 0.2;
    this.surfaceY = 0.32;

    this.faceTexture = coinFaceTexture(colors.ink, colors.reward);
    const edge = new MeshStandardMaterial({ color: new Color(colors.reward), metalness: 0.4, roughness: 0.42, envMapIntensity: 0.5, emissive: new Color(colors.reward), emissiveIntensity: 0.1 });
    const face = new MeshStandardMaterial({ color: 0xffffff, map: this.faceTexture, metalness: 0.4, roughness: 0.46, envMapIntensity: 0.5, emissive: new Color(colors.reward), emissiveIntensity: 0.1 });
    this.coinMats = [edge, face];
    const coinGeo = new CylinderGeometry(0.1, 0.1, 0.02, 22);
    // Heap: coins scattered in a shallow mound.
    const r = rand(17);
    const heapCount = 110;
    this.heap = new InstancedMesh(coinGeo, [edge, face, face], heapCount);
    const q = new Quaternion();
    for (let i = 0; i < heapCount; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 1.02;
      const y = 0.26 + (1 - d / 1.02) * 0.2 + r() * 0.04;
      q.setFromAxisAngle(new Vector3(r() - 0.5, 0, r() - 0.5).normalize(), (r() - 0.5) * 0.9);
      this.heap.setMatrixAt(i, new Matrix4().compose(new Vector3(Math.cos(a) * d, y, Math.sin(a) * d), q, new Vector3(1, 1, 1)));
    }
    this.heap.castShadow = true;
    this.heap.receiveShadow = true;
    this.heap.computeBoundingSphere();

    // A warm light pooled on the coins (emissive disc under them, reads as reflected gold).
    this.glow = new Mesh(
      new CircleGeometry(1.12, 40).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: new Color(colors.reward).multiplyScalar(0.5), transparent: true, opacity: 0.5 }),
    );
    this.glow.position.y = 0.245;

    const streamCount = 42;
    this.stream = new InstancedMesh(coinGeo, [edge, face, face], streamCount);
    this.stream.instanceMatrix.setUsage(DynamicDrawUsage);
    this.stream.frustumCulled = false;
    this.stream.castShadow = true;
    for (let i = 0; i < streamCount; i++) {
      this.coins.push({ target: 0, t: 0, speed: 0.8, spin: 6, offset: new Vector3(), active: false });
      this.stream.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
    }
    this.group.add(wall, base, rim, this.glow, this.heap, this.stream);
  }

  setColors(reward: string) {
    this.coinMats[0].color.set(reward);
    this.coinMats.forEach((m) => m.emissive.set(reward));
    (this.glow.material as MeshBasicMaterial).color.set(reward).multiplyScalar(0.5);
  }

  private spawnTimer = 0;
  private nextTarget = 0;

  resetStream() {
    this.coins.forEach((c) => (c.active = false));
    this.spawnTimer = 0;
  }

  /**
   * Streams coins from the heap to each target (world positions, e.g. a raised hand).
   * `rate` coins per second; 0 lets the current coins land and stops.
   */
  update(dt: number, targets: Vector3[], rate: number): boolean {
    const origin = new Vector3(0, this.surfaceY + 0.2, 0);
    this.group.localToWorld(origin);
    if (rate > 0 && targets.length) {
      this.spawnTimer += dt * rate;
      while (this.spawnTimer >= 1) {
        this.spawnTimer -= 1;
        const c = this.coins.find((q) => !q.active);
        if (!c) break;
        c.active = true;
        c.t = 0;
        c.target = this.nextTarget++ % targets.length;
        c.speed = 0.62 + Math.random() * 0.06;
        c.spin = 6 + Math.random() * 3;
        c.offset.set((Math.random() - 0.5) * 0.35, 0, (Math.random() - 0.5) * 0.35);
      }
    }
    let any = false;
    const p = new Vector3();
    const c1 = new Vector3();
    const c2 = new Vector3();
    this.coins.forEach((c, i) => {
      if (!c.active) {
        this.stream.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
        return;
      }
      any = true;
      c.t += dt * c.speed;
      if (c.t >= 1 || !targets[c.target]) {
        c.active = false;
        this.stream.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
        return;
      }
      // A fountain arc: straight up out of the pool, over the heads, down onto raised hands
      // (targets sit above head height, so a coin never crosses a face).
      const start = origin.clone().add(c.offset);
      const end = targets[c.target];
      c1.copy(start).setY(Math.max(start.y, end.y) + 2.4);
      c2.copy(end).setY(end.y + 1.5);
      const t = c.t;
      const u = 1 - t;
      p.copy(start)
        .multiplyScalar(u * u * u)
        .addScaledVector(c1, 3 * u * u * t)
        .addScaledVector(c2, 3 * u * t * t)
        .addScaledVector(end, t * t * t);
      this.dummy.position.copy(p);
      this.group.worldToLocal(this.dummy.position);
      this.dummy.rotation.set(c.t * c.spin, c.t * c.spin * 0.6, 0.4);
      const s = Math.min(1, t * 6) * (t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1);
      this.dummy.scale.setScalar(s * 0.78);
      this.dummy.updateMatrix();
      this.stream.setMatrixAt(i, this.dummy.matrix);
    });
    this.stream.instanceMatrix.needsUpdate = true;
    return any;
  }

  dispose() {
    this.faceTexture.dispose();
    this.coinMats.forEach((m) => m.dispose());
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((x) => x.dispose());
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The week: seven steps, day letters on the risers, a light strip that switches on per day.
// ---------------------------------------------------------------------------------------------

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export class WeekSteps {
  readonly group = new Group();
  private strips: Mesh[] = [];
  private letters: Mesh[] = [];
  private stripMats: MeshStandardMaterial[] = [];
  private letterMats: MeshBasicMaterial[] = [];
  private textures: CanvasTexture[] = [];
  readonly lit: number[] = new Array(7).fill(0);
  private brand = new Color();
  private idle = new Color();

  /** `steps`: centre (top surface), yaw, width and tread of each of the seven steps. */
  constructor(steps: Array<{ position: Vector3; yaw: number; width: number; tread: number; riser: number }>, brand: Color, idle: Color) {
    this.brand.copy(brand);
    this.idle.copy(idle);
    steps.forEach((st, i) => {
      const holder = new Group();
      holder.position.copy(st.position);
      holder.rotation.y = st.yaw;
      // Light strip along the nosing.
      const mat = new MeshStandardMaterial({ color: 0x2a2f33, emissive: brand.clone(), emissiveIntensity: 0, roughness: 0.4, toneMapped: true });
      const strip = new Mesh(new PlaneGeometry(st.width - 0.3, 0.07).rotateX(-Math.PI / 2), mat);
      strip.position.set(0, 0.004, -st.tread / 2 + 0.12);
      holder.add(strip);
      // Day letter on the riser face (front, facing down the stairs).
      const { c, ctx } = canvas(64, 64);
      ctx.fillStyle = '#fff';
      ctx.font = `800 44px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(DAYS[i], 32, 35);
      const tex = new CanvasTexture(c);
      tex.colorSpace = SRGBColorSpace;
      const lm = new MeshBasicMaterial({ map: tex, transparent: true, color: idle.clone(), depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const letter = new Mesh(new PlaneGeometry(Math.min(0.34, st.riser * 1.4), Math.min(0.34, st.riser * 1.4)), lm);
      letter.rotation.y = Math.PI;
      letter.position.set(0, -st.riser / 2, -st.tread / 2 - 0.035);
      holder.add(letter);
      this.group.add(holder);
      this.strips.push(strip);
      this.letters.push(letter);
      this.stripMats.push(mat);
      this.letterMats.push(lm);
      this.textures.push(tex);
    });
  }

  setColors(brand: Color, idle: Color) {
    this.brand.copy(brand);
    this.idle.copy(idle);
    this.apply();
  }

  /** Brightness 0…1 per step. */
  setLit(i: number, v: number) {
    this.lit[i] = v;
    this.apply(i);
  }

  private apply(only?: number) {
    this.stripMats.forEach((m, i) => {
      if (only !== undefined && only !== i) return;
      const v = this.lit[i];
      m.emissive.copy(this.brand);
      m.emissiveIntensity = v * 2.1;
      m.color.set(0x2a2f33).lerp(this.brand, v * 0.6);
      this.letterMats[i].color.copy(this.idle).lerp(this.brand, v);
    });
  }

  dispose() {
    this.textures.forEach((t) => t.dispose());
    this.stripMats.forEach((m) => m.dispose());
    this.letterMats.forEach((m) => m.dispose());
    this.strips.forEach((m) => m.geometry.dispose());
    this.letters.forEach((m) => m.geometry.dispose());
  }
}

// ---------------------------------------------------------------------------------------------
// Summit monument: the brand stair glyph, extruded in stone with a reward-coloured dot.
// ---------------------------------------------------------------------------------------------

export function buildMonument(brand: Color, reward: Color) {
  const group = new Group();
  const shape = new Shape();
  // Stair glyph as a thick stepped band (units: metres, ~1.8 m tall).
  const s = 0.36;
  const t = 0.26;
  const pts: Array<[number, number]> = [
    [0, 0],
    [s * 5, 0],
    [s * 5, s * 4 + t],
    [s * 4 - t, s * 4 + t],
    [s * 4 - t, s * 3 + t],
    [s * 3 - t, s * 3 + t],
    [s * 3 - t, s * 2 + t],
    [s * 2 - t, s * 2 + t],
    [s * 2 - t, s * 1 + t],
    [s * 1 - t, s * 1 + t],
    [s * 1 - t, t],
    [0, t],
  ];
  pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
  geo.translate(-s * 2.5, 0, -0.17);
  const mat = new MeshStandardMaterial({ color: brand.clone(), roughness: 0.45, metalness: 0.05 });
  const glyph = new Mesh(geo, mat);
  glyph.castShadow = true;
  glyph.receiveShadow = true;
  const dotMat = new MeshStandardMaterial({ color: reward.clone(), emissive: reward.clone(), emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.3 });
  const dot = new Mesh(new CylinderGeometry(0.16, 0.16, 0.34, 24).rotateX(Math.PI / 2), dotMat);
  dot.position.set(s * 2.5 - 0.02, s * 4 + t + 0.3, 0);
  dot.castShadow = true;
  group.add(glyph, dot);
  return {
    group,
    setColors(b: Color, r: Color) {
      mat.color.copy(b);
      dotMat.color.copy(r);
      dotMat.emissive.copy(r);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      dot.geometry.dispose();
      dotMat.dispose();
    },
  };
}

/** Plaza paving: a stone disc with a subtle ring inlay. */
export function buildPlaza(radius: number) {
  const mat = new MeshStandardMaterial({ color: 0xc4b9a5, roughness: 0.9 });
  const disc = new Mesh(new CylinderGeometry(radius, radius + 0.15, 0.6, 64), mat);
  disc.position.y = -0.3;
  disc.receiveShadow = true;
  const inlayMat = new MeshStandardMaterial({ color: 0xbfb4a0, roughness: 0.9 });
  const inlay = new Mesh(new RingGeometry(radius - 0.9, radius - 0.6, 64).rotateX(-Math.PI / 2), inlayMat);
  inlay.position.y = 0.004;
  inlay.receiveShadow = true;
  const group = new Group();
  group.add(disc, inlay);
  return group;
}

export function disposeObject(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach((x) => {
      Object.values(x).forEach((v) => v instanceof Texture && v.dispose());
      x.dispose();
    });
  });
}

