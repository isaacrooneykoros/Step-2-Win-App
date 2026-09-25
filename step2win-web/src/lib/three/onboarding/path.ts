import {
  BoxGeometry,
  BufferAttribute,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';

/**
 * The journey: one stair-path that climbs from the edge of the plain (Nairobi on the horizon)
 * up a savanna hill to a summit. Every station of the onboarding sits on it, so the camera can
 * fly continuously and the last page can pull back to show the whole climb.
 *
 * Heights are analytic (sections of flat path, stairs and plazas), so the characters' feet can
 * query the exact step under them.
 */

import { groundDetail, stoneDetail } from './textures';

/** Height of the plain the city stands on. */
export const PLAIN_Y = -7;

export type SectionKind = 'flat' | 'stairs' | 'plaza';

export interface Section {
  kind: SectionKind;
  from: number;
  to: number;
  width: number;
  tread?: number;
  riser?: number;
  /** Plaza radius (centred on the middle of the section). */
  radius?: number;
  /** Stone tone multiplier for this section's treads. */
  tone?: number;
  tag?: string;
}

/** Control points (x, z) of the path, from the plain up to the summit. */
const CONTROL: Array<[number, number]> = [
  [0, 16],
  [1, 4],
  [-1, -10],
  [-6, -24],
  [-8, -38],
  [-4, -50],
  [4, -60],
  [10, -72],
  [12, -86],
  [13, -98],
  [10, -110],
  [4, -120],
  [0, -130],
  [-2, -140],
];

/** Sections by arc length (m). Kept in sync with the stations. */
export const SECTIONS: Section[] = [
  { kind: 'flat', from: 0, to: 6, width: 2.4 },
  { kind: 'stairs', from: 6, to: 48, width: 2.4, tread: 1.2, riser: 0.1, tag: 'move' },
  { kind: 'flat', from: 48, to: 56, width: 2.4, tag: 'move-top' },
  { kind: 'stairs', from: 56, to: 80, width: 5.2, tread: 1.2, riser: 0.13, tag: 'together' },
  { kind: 'flat', from: 80, to: 86, width: 5.2, tag: 'flag' },
  { kind: 'stairs', from: 86, to: 96, width: 3.2, tread: 1.25, riser: 0.12, tag: 'approach' },
  { kind: 'plaza', from: 96, to: 112, width: 3.2, radius: 8.2, tag: 'pool' },
  { kind: 'flat', from: 112, to: 118, width: 2.8 },
  { kind: 'stairs', from: 118, to: 125, width: 3.4, tread: 1.0, riser: 0.22, tag: 'week' },
  { kind: 'flat', from: 125, to: 138, width: 4.6, tag: 'summit' },
];

export interface PathFrame {
  point: Vector3;
  tangent: Vector3;
  right: Vector3;
}

export class StairPath {
  readonly curve: CatmullRomCurve3;
  readonly length: number;
  private samples: Vector3[] = [];
  private tangents: Vector3[] = [];
  private readonly step = 0.25;
  private baseHeights: number[] = [];

  constructor() {
    this.curve = new CatmullRomCurve3(
      CONTROL.map(([x, z]) => new Vector3(x, 0, z)),
      false,
      'centripetal',
    );
    this.curve.arcLengthDivisions = 1200;
    this.length = this.curve.getLength();
    const n = Math.ceil(this.length / this.step);
    for (let i = 0; i <= n; i++) {
      const u = Math.min(1, (i * this.step) / this.length);
      const p = this.curve.getPointAt(u);
      this.samples.push(p);
      this.tangents.push(this.curve.getTangentAt(u).setY(0).normalize());
    }
    this.buildLookup();
    // Start height of each section.
    let h = 0;
    for (const s of SECTIONS) {
      this.baseHeights.push(h);
      h = this.sectionEnd(s, h);
    }
  }

  private sectionEnd(s: Section, h0: number) {
    if (s.kind !== 'stairs') return h0;
    return h0 + Math.floor((s.to - s.from) / s.tread! + 1e-6) * s.riser!;
  }

  sectionAt(s: number): { section: Section; base: number } {
    for (let i = SECTIONS.length - 1; i >= 0; i--) {
      if (s >= SECTIONS[i].from) return { section: SECTIONS[i], base: this.baseHeights[i] };
    }
    return { section: SECTIONS[0], base: 0 };
  }

  section(tag: string): Section {
    const s = SECTIONS.find((q) => q.tag === tag);
    if (!s) throw new Error(tag);
    return s;
  }

  /** Walking-surface height at arc length s. */
  heightAt(s: number): number {
    const { section, base } = this.sectionAt(Math.max(0, s));
    if (section.kind !== 'stairs') return base;
    const k = Math.floor((s - section.from) / section.tread! + 1e-6);
    const n = Math.floor((section.to - section.from) / section.tread! + 1e-6);
    return base + Math.min(n, k + 1) * section.riser!;
  }

  /** Smooth height (for cameras and the terrain). */
  smoothHeightAt(s: number): number {
    const { section, base } = this.sectionAt(Math.max(0, s));
    if (section.kind !== 'stairs') return base;
    const t = Math.min(1, Math.max(0, (s - section.from) / (section.to - section.from)));
    return base + t * (this.sectionEnd(section, base) - base);
  }

  widthAt(s: number) {
    return this.sectionAt(s).section.width;
  }

  frame(s: number, out?: PathFrame): PathFrame {
    const u = Math.min(1, Math.max(0, s / this.length));
    const f = out ?? { point: new Vector3(), tangent: new Vector3(), right: new Vector3() };
    this.curve.getPointAt(u, f.point);
    this.curve.getTangentAt(u, f.tangent).setY(0).normalize();
    f.right.set(-f.tangent.z, 0, f.tangent.x);
    f.point.y = this.heightAt(s);
    return f;
  }

  /** World position at arc length s with a lateral offset (m, + = right). */
  pointAt(s: number, lateral = 0, out = new Vector3()): Vector3 {
    const f = this.frame(s);
    return out.copy(f.point).addScaledVector(f.right, lateral);
  }

  /** Nearest arc length and signed lateral distance for a world xz. */
  project(x: number, z: number): { s: number; d: number } {
    // Coarse lookup (precomputed nearest sample per 4 m cell), then a local refinement.
    const g = this.coarse;
    const cx = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
    const cz = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / g.cell)));
    const guess = g.index[cz * g.nx + cx];
    const xs = this.xs;
    const zs = this.zs;
    const lo = Math.max(0, guess - 48);
    const hi = Math.min(xs.length - 1, guess + 48);
    let best = Infinity;
    let bi = guess;
    for (let i = lo; i <= hi; i++) {
      const d = (xs[i] - x) * (xs[i] - x) + (zs[i] - z) * (zs[i] - z);
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const t = this.tangents[bi];
    const dx = x - xs[bi];
    const dz = z - zs[bi];
    const along = dx * t.x + dz * t.z;
    const lateral = -dx * t.z + dz * t.x;
    return { s: Math.min(this.length, Math.max(0, bi * this.step + along)), d: lateral };
  }

  private xs = new Float32Array(0);
  private zs = new Float32Array(0);
  private coarse = { x0: 0, z0: 0, cell: 4, nx: 1, nz: 1, index: new Int32Array(1) };

  private buildLookup() {
    const n = this.samples.length;
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    this.samples.forEach((p, i) => {
      this.xs[i] = p.x;
      this.zs[i] = p.z;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });
    const margin = 220;
    const cell = 4;
    const x0 = minX - margin;
    const z0 = minZ - margin;
    const nx = Math.ceil((maxX - minX + margin * 2) / cell);
    const nz = Math.ceil((maxZ - minZ + margin * 2) / cell);
    const index = new Int32Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) {
      const z = z0 + (iz + 0.5) * cell;
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + (ix + 0.5) * cell;
        let best = Infinity;
        let bi = 0;
        for (let i = 0; i < n; i += 4) {
          const d = (this.xs[i] - x) * (this.xs[i] - x) + (this.zs[i] - z) * (this.zs[i] - z);
          if (d < best) {
            best = d;
            bi = i;
          }
        }
        index[iz * nx + ix] = bi;
      }
    }
    this.coarse = { x0, z0, cell, nx, nz, index };
  }

  /** Plaza centre (xz) and height, for the pool station. */
  plaza(): { center: Vector3; radius: number } {
    const s = this.section('pool');
    const center = this.pointAt((s.from + s.to) / 2);
    return { center, radius: s.radius! };
  }

  /** Height of anything standing at world xz: stairs, plaza or terrain. */
  ground = (x: number, z: number): number => {
    const { s, d } = this.project(x, z);
    const w = this.widthAt(s) / 2;
    if (Math.abs(d) <= w + 0.02) return this.heightAt(s);
    const pz = this.plazaCache ?? (this.plazaCache = this.plaza());
    const px = x - pz.center.x;
    const pzz = z - pz.center.z;
    if (px * px + pzz * pzz <= pz.radius * pz.radius) return pz.center.y;
    return this.terrainAt(x, z, s, d);
  };

  private plazaCache: { center: Vector3; radius: number } | null = null;

  /** Natural ground: hugs the path near it, rolls away into hills, falls to the plain far off. */
  terrainAt(x: number, z: number, s?: number, d?: number): number {
    if (s === undefined || d === undefined) ({ s, d } = this.project(x, z));
    const w = this.widthAt(s) / 2;
    const edge = Math.max(0, Math.abs(d) - w);
    const pathH = this.smoothHeightAt(s);
    const near = this.heightAt(s) - 0.14;
    const relief = fbm(x * 0.045, z * 0.045) * 2.4 + fbm(x * 0.13 + 7, z * 0.13 - 3) * 0.5;
    const shoulder = smooth(0.6, 7, edge);
    // Relief only grows away from the path, so the verge hugs the steps.
    let h = near + (pathH - near) * shoulder + relief * smooth(2.5, 14, edge);
    if (edge < 3) h = Math.max(h, this.heightAt(s) - 0.12 - edge * 0.12);
    // Plaza: flat stone, then the slope.
    const pz = this.plazaCache ?? (this.plazaCache = this.plaza());
    const pd = Math.hypot(x - pz.center.x, z - pz.center.z);
    const plazaK = 1 - smooth(pz.radius - 0.2, pz.radius + 6, pd);
    h = h + (pz.center.y - 0.12 - h) * plazaK;
    // Far from the path the hill falls away towards the plain (the city side is -x).
    h += (PLAIN_Y - h) * smooth(22, 95, edge);
    return h;
  }
}

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------

function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise2(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

export function fbm(x: number, y: number) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    v += noise2(x * f, y * f) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return v;
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const rand = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Terrain mesh with vertex colours: dry savanna grass, greener hollows, red laterite by the path. */
export function buildTerrain(path: StairPath, segments: number) {
  const size = 300;
  const geo = new PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  // Centre the terrain on the middle of the climb.
  const mid = path.pointAt(path.length * 0.5);
  geo.translate(mid.x - 30, 0, mid.z);
  const pos = geo.getAttribute('position') as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const grass = new Color('#b39a5c');
  const dry = new Color('#c9b27a');
  const green = new Color('#76824a');
  const soil = new Color('#a45a3b');
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const { s, d } = path.project(x, z);
    const h = path.terrainAt(x, z, s, d);
    pos.setY(i, h);
    const edge = Math.max(0, Math.abs(d) - path.widthAt(s) / 2);
    const n = fbm(x * 0.08 + 11, z * 0.08 - 5);
    c.copy(grass).lerp(dry, Math.max(0, n) * 0.9).lerp(green, Math.max(0, -n - 0.1) * 1.2);
    // Laterite soil where feet have worn the verge.
    c.lerp(soil, (1 - smooth(0.3, 2.2, edge)) * 0.85);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const detail = groundDetail();
  detail.repeat.set(size / 5, size / 5);
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: detail });
  return { geometry: geo, material };
}

/**
 * All treads as one instanced mesh: each tread is a stone block reaching down into the ground,
 * with a lighter top (vertex colour) so the steps read clearly.
 */
export function buildStairs(path: StairPath) {
  const box = new BoxGeometry(1, 1, 1);
  box.translate(0, -0.5, 0); // origin at the top face
  const colors: number[] = [];
  const normal = box.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) {
    const top = normal.getY(i) > 0.5;
    const front = Math.abs(normal.getZ(i)) > 0.5;
    const v = top ? 1 : front ? 0.8 : 0.72;
    colors.push(v, v, v);
  }
  box.setAttribute('color', new Float32BufferAttribute(colors, 3));

  const transforms: Matrix4[] = [];
  const tones: number[] = [];
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const tmp = new Vector3();
  const frame = { point: new Vector3(), tangent: new Vector3(), right: new Vector3() };
  const week: Array<{ index: number; s: number }> = [];

  for (const sec of SECTIONS) {
    const len = sec.to - sec.from;
    if (sec.kind === 'stairs') {
      const n = Math.floor(len / sec.tread! + 1e-6);
      for (let k = 0; k < n; k++) {
        const sMid = sec.from + (k + 0.5) * sec.tread!;
        path.frame(sMid, frame);
        const top = path.heightAt(sMid);
        const depth = Math.max(0.6, top - path.terrainAt(frame.point.x, frame.point.z) + 0.9);
        const yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
        q.setFromAxisAngle(up, yaw);
        // Slightly deeper than the tread so curved flights never show gaps.
        const m = new Matrix4().compose(tmp.set(frame.point.x, top, frame.point.z), q, new Vector3(sec.width, depth, sec.tread! + 0.06));
        if (sec.tag === 'week') week.push({ index: transforms.length, s: sMid });
        transforms.push(m);
        tones.push(sec.tag === 'week' ? 0.94 : 1);
      }
    } else if (sec.kind === 'flat') {
      // Paving slabs every ~1.2 m.
      const n = Math.max(1, Math.round(len / 1.2));
      const d = len / n;
      for (let k = 0; k < n; k++) {
        const sMid = sec.from + (k + 0.5) * d;
        path.frame(sMid, frame);
        const top = path.heightAt(sMid);
        const depth = Math.max(0.5, top - path.terrainAt(frame.point.x, frame.point.z) + 0.6);
        const yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
        q.setFromAxisAngle(up, yaw);
        transforms.push(new Matrix4().compose(tmp.set(frame.point.x, top, frame.point.z), q, new Vector3(sec.width, depth, d + 0.04)));
        tones.push(0.97);
      }
    }
  }

  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, color: new Color('#bcb09a'), map: stoneDetail() });
  const mesh = new InstancedMesh(box, material, transforms.length);
  transforms.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new Color(tones[i], tones[i], tones[i]));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return { mesh, week };
}
