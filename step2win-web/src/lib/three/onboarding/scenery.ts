import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rand, smooth, type StairPath } from './path';

// ---------------------------------------------------------------------------------------------
// Sky dome: horizon → zenith gradient, sun (or moon) disc with a soft halo, city glow at night.
// ---------------------------------------------------------------------------------------------

export function buildSky() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uGround: { value: new Color() },
      uSun: { value: new Color() },
      uSunDir: { value: new Vector3(0, 0.1, 1) },
      uSunSize: { value: 0.9994 },
      uHalo: { value: 0.35 },
      uGlowDir: { value: new Vector3(-1, 0, 0) },
      uGlow: { value: new Color(0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uGround, uSun, uSunDir, uGlowDir, uGlow;
      uniform float uSunSize, uHalo;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.62, h), 0.75));
        col = mix(col, uGround, smoothstep(0.0, -0.12, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSun * (pow(s, 10.0) * uHalo + pow(s, 90.0) * uHalo * 1.4);
        col += uSun * 6.0 * smoothstep(uSunSize, uSunSize + 0.0004, s);
        float g = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(uGlowDir)), 0.0);
        col += uGlow * pow(g, 3.0) * smoothstep(0.35, 0.0, abs(h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(new SphereGeometry(900, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, material };
}

export function buildStars() {
  const r = rand(7);
  const n = 420;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = r() * Math.PI * 2;
    const v = 0.06 + r() * 0.9;
    const y = v * v;
    const rr = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(u) * rr * 850;
    pos[i * 3 + 1] = y * 850;
    pos[i * 3 + 2] = Math.sin(u) * rr * 850;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const material = new PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8, depthWrite: false });
  const points = new Points(geo, material);
  points.frustumCulled = false;
  return points;
}

// ---------------------------------------------------------------------------------------------
// Nairobi skyline — stylised: KICC's cylinder and crown, Britam's slanted blade, Times Tower,
// UAP's spire and a spread of CBD blocks. One merged mesh with world-scaled window UVs.
// ---------------------------------------------------------------------------------------------

function windowTexture() {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const r = rand(21);
  for (let y = 4; y < h; y += 8) {
    for (let x = 3; x < w; x += 6) {
      const lit = r();
      if (lit < 0.42) continue;
      const v = Math.floor(120 + r() * 135);
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.82)},${Math.floor(v * 0.55)})`;
      ctx.fillRect(x, y, 3, 4);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

/** Scales a geometry's UVs so windows keep a real-world size (~ 3 m per floor). */
function worldUv(geo: BufferGeometry, sx: number, sy: number) {
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  return geo;
}

function block(w: number, h: number, d: number, x: number, z: number, y0: number) {
  const g = new BoxGeometry(w, h, d);
  worldUv(g, Math.max(w, d) / 18, h / 24);
  g.translate(x, y0 + h / 2, z);
  return g;
}

export function buildSkyline(center: Vector3, facing: Vector3) {
  // Local frame: `across` runs along the skyline, `depth` away from the viewer.
  const across = new Vector3(-facing.z, 0, facing.x).normalize();
  const depth = facing.clone().setY(0).normalize();
  const parts: BufferGeometry[] = [];
  const place = (g: BufferGeometry, a: number, dd: number) => {
    const p = center.clone().addScaledVector(across, a).addScaledVector(depth, dd);
    g.translate(p.x, 0, p.z);
    parts.push(g);
  };
  const y0 = center.y;
  const r = rand(5);

  // CBD blocks.
  for (let i = 0; i < 46; i++) {
    const a = (r() - 0.5) * 230;
    const dd = r() * 70;
    const hh = 12 + Math.pow(r(), 2) * 50 * (1 - Math.abs(a) / 160);
    const w = 8 + r() * 12;
    place(block(w, hh, 8 + r() * 10, 0, 0, y0), a, dd);
  }
  // KICC: cylinder, crown saucer, conference cone.
  {
    const tower = new CylinderGeometry(6, 6, 78, 20, 1, true);
    worldUv(tower, 2.2, 3.2);
    tower.translate(0, y0 + 39, 0);
    const crown = new CylinderGeometry(9, 6.5, 4, 24);
    worldUv(crown, 0.01, 0.01);
    crown.translate(0, y0 + 80, 0);
    const mast = new CylinderGeometry(0.4, 0.6, 10, 6);
    worldUv(mast, 0.01, 0.01);
    mast.translate(0, y0 + 87, 0);
    const hall = new ConeGeometry(14, 16, 24);
    worldUv(hall, 0.01, 0.01);
    hall.translate(-16, y0 + 8, 6);
    const merged = mergeGeometries([tower.toNonIndexed(), crown.toNonIndexed(), mast.toNonIndexed(), hall.toNonIndexed()]);
    place(merged!, -12, 18);
  }
  // Britam: tall blade with a slanted top.
  {
    const g = new BoxGeometry(13, 110, 11, 1, 1, 1);
    const pos = g.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) + (pos.getX(i) > 0 ? 8 : -10));
    }
    worldUv(g, 0.7, 4.6);
    g.translate(0, y0 + 55, 0);
    place(g, 30, 26);
  }
  // Times Tower.
  place(block(16, 92, 13, 0, 0, y0), 8, 34);
  // UAP Old Mutual with spire.
  {
    const body = block(14, 76, 14, 0, 0, y0);
    const spire = new ConeGeometry(4, 18, 4);
    worldUv(spire, 0.01, 0.01);
    spire.rotateY(Math.PI / 4);
    spire.translate(0, y0 + 85, 0);
    place(mergeGeometries([body.toNonIndexed(), spire.toNonIndexed()])!, 56, 44);
  }
  // Two GTC-like towers.
  place(block(12, 70, 12, 0, 0, y0), -48, 40);
  place(block(11, 62, 11, 0, 0, y0), -64, 48);

  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  geos.forEach((g) => {
    ['normal', 'uv', 'position'].forEach((k) => {
      if (!g.getAttribute(k)) throw new Error(`skyline part missing ${k}`);
    });
  });
  const merged = mergeGeometries(geos.map((g) => stripTo(g, ['position', 'normal', 'uv'])))!;
  // Stylised: a low, wide silhouette on the horizon rather than towering blocks.
  merged.translate(-center.x, -y0, -center.z).scale(0.8, 0.42, 0.8).translate(center.x, y0, center.z);
  merged.computeVertexNormals();
  parts.forEach((g) => g.dispose());
  const windows = windowTexture();
  const material = new MeshStandardMaterial({
    color: new Color('#8a93a0'),
    roughness: 0.85,
    metalness: 0,
    fog: false,
    emissiveMap: windows,
    emissive: new Color('#ffcf8a'),
    emissiveIntensity: 0,
  });
  const mesh = new Mesh(merged, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return { mesh, material, windows };
}

function stripTo(g: BufferGeometry, keep: string[]) {
  Object.keys(g.attributes).forEach((k) => {
    if (!keep.includes(k)) g.deleteAttribute(k);
  });
  return g;
}

// ---------------------------------------------------------------------------------------------
// Umbrella acacias (Vachellia tortilis) and shrubs, instanced.
// ---------------------------------------------------------------------------------------------

function acaciaParts() {
  const r = rand(3);
  // Trunk: a leaning main stem that forks into three limbs.
  const trunkParts: BufferGeometry[] = [];
  const addLimb = (from: Vector3, to: Vector3, r0: number, r1: number) => {
    const len = from.distanceTo(to);
    const g = new CylinderGeometry(r1, r0, len, 6, 1, true);
    g.translate(0, len / 2, 0);
    const dir = to.clone().sub(from).normalize();
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
    g.applyQuaternion(q);
    g.translate(from.x, from.y, from.z);
    trunkParts.push(stripTo(g.toNonIndexed(), ['position', 'normal']));
  };
  const fork = new Vector3(0.3, 2.2, 0.1);
  addLimb(new Vector3(0, -0.3, 0), fork, 0.24, 0.17);
  const tips = [new Vector3(2.4, 4.3, 0.6), new Vector3(-1.9, 4.5, -0.8), new Vector3(0.5, 4.8, -2.1), new Vector3(-0.6, 4.4, 2.0)];
  tips.forEach((t) => addLimb(fork, t, 0.15, 0.06));
  const trunk = mergeGeometries(trunkParts)!;

  // Canopy: a wide, flat, layered umbrella of lumpy blobs.
  const blobs: BufferGeometry[] = [];
  const add = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const ico = new IcosahedronGeometry(1, 2);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    const g = mergeVertices(ico);
    ico.dispose();
    const pos = g.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + (r() - 0.5) * 0.28;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    blobs.push(stripTo(g, ['position']));
  };
  add(0, 4.95, 0, 4.2, 0.62, 3.7);
  add(1.8, 4.75, 0.7, 2.4, 0.5, 2.1);
  add(-2.0, 4.8, -0.6, 2.5, 0.52, 2.2);
  add(0.4, 5.2, -1.4, 2.2, 0.45, 1.9);
  add(-0.5, 4.7, 1.9, 2.1, 0.45, 1.8);
  const canopy = mergeVertices(mergeGeometries(blobs)!);
  canopy.computeVertexNormals();
  // Flatten normals upward a bit so the canopy reads as a soft umbrella, not faceted rock.
  const n = canopy.getAttribute('normal') as BufferAttribute;
  for (let i = 0; i < n.count; i++) {
    const v = new Vector3(n.getX(i), n.getY(i) * 1.6 + 0.5, n.getZ(i)).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  trunkParts.forEach((g) => g.dispose());
  blobs.forEach((g) => g.dispose());
  return { trunk, canopy };
}

export function buildTrees(path: StairPath, density: number, avoid: Array<{ center: Vector3; radius: number }>) {
  const { trunk, canopy } = acaciaParts();
  const r = rand(11);
  const placements: Matrix4[] = [];
  const up = new Vector3(0, 1, 0);
  const q = new Quaternion();
  const target = Math.round(64 * density);
  let guard = 0;
  while (placements.length < target && guard++ < 2000) {
    const s = r() * path.length;
    const side = r() < 0.5 ? -1 : 1;
    const lateral = side * (5 + Math.pow(r(), 1.4) * 55);
    const p = path.pointAt(s, lateral);
    if (avoid.some((a) => a.center.distanceTo(new Vector3(p.x, a.center.y, p.z)) < a.radius)) continue;
    const y = path.terrainAt(p.x, p.z);
    const scale = 0.75 + r() * 0.65;
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    placements.push(new Matrix4().compose(new Vector3(p.x, y, p.z), q, new Vector3(scale, scale * (0.85 + r() * 0.3), scale)));
  }
  const trunkMat = new MeshStandardMaterial({ color: new Color('#4a3a2e'), roughness: 0.95 });
  const canopyMat = new MeshStandardMaterial({ color: new Color('#5b6a33'), roughness: 0.92 });
  const trunks = new InstancedMesh(trunk, trunkMat, placements.length);
  const canopies = new InstancedMesh(canopy, canopyMat, placements.length);
  const tint = new Color();
  placements.forEach((m, i) => {
    trunks.setMatrixAt(i, m);
    canopies.setMatrixAt(i, m);
    tint.setHSL(0.2 + (r() - 0.5) * 0.04, 0.35 + r() * 0.1, 0.5 + (r() - 0.5) * 0.12);
    canopies.setColorAt(i, tint.clone().multiplyScalar(1.6));
  });
  [trunks, canopies].forEach((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  });
  return { trunks, canopies };
}

/** Low scrub and grass clumps near the path, for texture at walking height. */
export function buildShrubs(path: StairPath, density: number) {
  const r = rand(29);
  const ico = new IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico);
  ico.dispose();
  const pos = geo.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = 1 + (r() - 0.5) * 0.4;
    pos.setXYZ(i, pos.getX(i) * k, Math.max(-0.2, pos.getY(i)) * k, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const count = Math.round(260 * density);
  const mesh = new InstancedMesh(geo, new MeshStandardMaterial({ color: new Color('#6d7440'), roughness: 0.95 }), count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const s = r() * path.length;
    const w = path.widthAt(s) / 2;
    const side = r() < 0.5 ? -1 : 1;
    const lateral = side * (w + 0.9 + Math.pow(r(), 2) * 14);
    const p = path.pointAt(s, lateral);
    const plaza = path.plaza();
    if (Math.hypot(p.x - plaza.center.x, p.z - plaza.center.z) < plaza.radius + 0.6) {
      mesh.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
      continue;
    }
    const y = path.terrainAt(p.x, p.z);
    const sc = 0.25 + r() * 0.5;
    q.setFromAxisAngle(up, r() * 6.28);
    mesh.setMatrixAt(i, new Matrix4().compose(new Vector3(p.x, y, p.z), q, new Vector3(sc * (1 + r() * 0.6), sc * (0.6 + r() * 0.5), sc)));
    c.setHSL(0.16 + r() * 0.07, 0.3 + r() * 0.15, 0.3 + r() * 0.12);
    mesh.setColorAt(i, c.clone().multiplyScalar(1.8));
  }
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

export { smooth };
