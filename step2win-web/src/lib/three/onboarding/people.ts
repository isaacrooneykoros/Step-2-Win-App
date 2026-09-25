import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LoopOnce,
  LoopRepeat,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Sphere,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
  VectorKeyframeTrack,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { PeopleAssets } from './assets';

/**
 * Rigged, skeletally animated people built from Quaternius' Universal Base Characters.
 *
 * The base meshes wear underwear only, so athletic wear is painted procedurally in the shader:
 * every vertex gets body-space coordinates (torso height, distance along the arm and leg chains,
 * which limb group it belongs to) derived from its skin weights and the bind pose. Each person's
 * material then decides per fragment what is skin, top, bottoms, trim or shoe, with anti-aliased
 * seams — one shared shader program, per-person uniforms. Skin tone is re-tinted from the texture
 * so facial detail survives.
 */

export type BodyKind = 'F' | 'M';
export type HairStyle = 'Hair_Buzzed' | 'Hair_BuzzedFemale' | 'Hair_Buns' | 'Hair_Long' | 'Hair_SimpleParted';

export interface Look {
  body: BodyKind;
  /** sRGB hex. */
  skin: string;
  hair: HairStyle | null;
  beard?: boolean;
  hairColor: string;
  beardColor?: string;
  top: string;
  bottom: string;
  shoe: string;
  trim: string;
  /** Distance along the arm chain the sleeve reaches: 0 tank, ~0.5 tee, 1.9 long sleeve. */
  sleeve: number;
  /** Distance along the leg chain the bottoms reach: ~0.55 shorts, ~1.9 full leggings. */
  bottomLen: number;
  /** Torso height of the hem (0 = hip joint, 1 = neck). */
  hem?: number;
  /** Height multiplier. */
  scale?: number;
}

/** Average linear colour of the skin in the source textures, used to re-tint. */
const TEX_SKIN_AVG = new Color(0.393, 0.184, 0.085);
const TEX_HAIR_LUM = 0.27;
/** Mannequin pelvis height the clips were authored on. */
const MANNEQUIN_PELVIS = 0.9167;

export const LOCOMOTION = ['Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop'] as const;

// ---------------------------------------------------------------------------------------------
// Library: parsed assets → reusable templates (bodies, hair, per-body retargeted clips)
// ---------------------------------------------------------------------------------------------

interface BodyTemplate {
  kind: BodyKind;
  root: Object3D;
  /** Rest pelvis height (m) of this body, for rescaling clip translations. */
  pelvisHeight: number;
  /** Torso height (bind space y) of the sole, below which the shoe gets its sole colour. */
  soleH: number;
  /** Torso height of the waist (bottoms waistband). */
  waistH: number;
  clips: Map<string, AnimationClip>;
  /** No-slide ground speed (m/s at timeScale 1) for locomotion clips. */
  speeds: Map<string, number>;
}

export class PeopleLibrary {
  private bodies = new Map<BodyKind, BodyTemplate>();
  private rawClips = new Map<string, AnimationClip>();
  private hairs = new Map<string, { geometry: BufferGeometry; map: Texture | null; normalMap: Texture | null; matrix: Matrix4 }>();
  private disposables = new Set<{ dispose: () => void }>();

  /** Adds a parsed asset file (core or extra). Returns the body kind it contained. */
  add(assets: PeopleAssets): BodyKind | null {
    for (const clip of assets.clips) this.rawClips.set(clip.name, clip);
    let kind: BodyKind | null = null;
    assets.scene.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) {
        this.disposables.add(mesh.geometry);
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          this.disposables.add(m);
          Object.values(m).forEach((v) => v instanceof Texture && this.disposables.add(v));
        });
      }
      if (node.name.startsWith('Hair_') && mesh.isMesh) {
        const mat = mesh.material as MeshStandardMaterial;
        // Quantised meshes carry their dequantisation in the node transform: keep it.
        mesh.updateMatrix();
        this.hairs.set(node.name, { geometry: mesh.geometry, map: mat.map, normalMap: mat.normalMap, matrix: mesh.matrix.clone() });
      }
      if (node.name === 'Rig_F' || node.name === 'Rig_M') kind = node.name === 'Rig_F' ? 'F' : 'M';
    });
    if (!kind) return null;
    const k = kind as BodyKind;
    const rig = assets.scene.getObjectByName(`Rig_${k}`)!;
    // Keep only the rig (body, eyes, brows); hair meshes live in the library.
    const hairs = assets.scene.getObjectByName('Hairs');
    hairs?.removeFromParent();
    const pelvis = rig.getObjectByName('pelvis') as Bone;
    const body = rig.getObjectByName(`Body_${k}`) as SkinnedMesh;
    prepareBodyGeometry(body);
    const heights = (body.geometry.userData.heights ?? {}) as { sole: number; waist: number };
    this.bodies.set(k, {
      kind: k,
      root: rig,
      pelvisHeight: pelvis.position.length(),
      soleH: heights.sole,
      waistH: heights.waist,
      clips: new Map(),
      speeds: new Map(),
    });
    return k;
  }

  has(kind: BodyKind) {
    return this.bodies.has(kind);
  }

  hasClip(name: string) {
    return this.rawClips.has(name);
  }

  body(kind: BodyKind): BodyTemplate {
    const b = this.bodies.get(kind);
    if (!b) throw new Error(`body ${kind} not loaded`);
    return b;
  }

  /** Clip retargeted to a body: pelvis translation scaled to its proportions. */
  clip(kind: BodyKind, name: string): AnimationClip | null {
    const body = this.body(kind);
    let clip = body.clips.get(name);
    if (clip) return clip;
    const raw = this.rawClips.get(name);
    if (!raw) return null;
    const ratio = body.pelvisHeight / MANNEQUIN_PELVIS;
    clip = raw.clone();
    clip.tracks = clip.tracks.map((t) => {
      if (t.name === 'pelvis.position' && t instanceof VectorKeyframeTrack) {
        const scaled = t.clone();
        for (let i = 0; i < scaled.values.length; i++) scaled.values[i] *= ratio;
        return scaled;
      }
      return t;
    });
    body.clips.set(name, clip);
    return clip;
  }

  hair(name: string) {
    return this.hairs.get(name) ?? null;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.clear();
    this.bodies.clear();
    this.hairs.clear();
    this.rawClips.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Body-space coordinates for procedural clothing
// ---------------------------------------------------------------------------------------------

const GROUP_OF: Array<[RegExp, number]> = [
  [/^(pelvis|spine_0[123]|clavicle_[lr])$/, 0], // torso
  [/^(upperarm|lowerarm|hand|index|middle|pinky|ring|thumb)/, 1], // arm
  [/^(thigh|calf)_[lr]$/, 2], // leg
  [/^(foot|ball)/, 3], // foot
];

function groupOf(name: string): number {
  for (const [re, g] of GROUP_OF) if (re.test(name)) return g;
  return 4; // head / neck / root
}

/** Parameter of point p along a polyline of joints (0 at first joint, +1 per segment). */
function chainParam(p: Vector3, chain: Vector3[]): number {
  let best = Infinity;
  let bestT = 0;
  const seg = new Vector3();
  const rel = new Vector3();
  const closest = new Vector3();
  for (let i = 0; i < chain.length - 1; i++) {
    seg.subVectors(chain[i + 1], chain[i]);
    const len2 = seg.lengthSq() || 1e-6;
    const t = Math.min(1, Math.max(i === 0 ? -0.5 : 0, rel.subVectors(p, chain[i]).dot(seg) / len2));
    closest.copy(chain[i]).addScaledVector(seg, t);
    const d = closest.distanceToSquared(p);
    if (d < best) {
      best = d;
      bestT = i + t;
    }
  }
  return bestT;
}

/**
 * Adds `aSeg` (torso height, arm param, leg param, outwardness) and `aGrp` (torso, arm, leg,
 * foot membership from skin weights). Runs once per body geometry (~7k vertices).
 */
function prepareBodyGeometry(mesh: SkinnedMesh) {
  const geo = mesh.geometry;
  if (geo.getAttribute('aSeg')) return;
  const bones = mesh.skeleton.bones;
  const bindPos = new Map<string, Vector3>();
  const inv = new Matrix4();
  bones.forEach((b, i) => {
    inv.copy(mesh.skeleton.boneInverses[i]).invert();
    bindPos.set(b.name, new Vector3().setFromMatrixPosition(inv));
  });
  const get = (n: string) => bindPos.get(n) ?? new Vector3();
  const armChain = (s: string) => [get(`upperarm_${s}`), get(`lowerarm_${s}`), get(`hand_${s}`), get(`middle_04_leaf_${s}`)];
  const legChain = (s: string) => [get(`thigh_${s}`), get(`calf_${s}`), get(`foot_${s}`), get(`ball_leaf_${s}`)];
  const arms = { l: armChain('l'), r: armChain('r') };
  const legs = { l: legChain('l'), r: legChain('r') };
  const hipY = (get('thigh_l').y + get('thigh_r').y) / 2;
  const neckY = get('neck_01').y;
  const span = neckY - hipY;
  const leftSign = Math.sign(get('thigh_l').x) || 1;
  const boneGroup = bones.map((b) => groupOf(b.name));

  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const skinIndex = geo.getAttribute('skinIndex');
  const skinWeight = geo.getAttribute('skinWeight');
  const count = pos.count;
  const seg = new Float32Array(count * 4);
  const grp = new Float32Array(count * 4);
  const p = new Vector3();
  const n = new Vector3();
  let minY = Infinity;
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    n.fromBufferAttribute(nor, i);
    minY = Math.min(minY, p.y);
    const side = Math.sign(p.x) === leftSign ? 'l' : 'r';
    seg[i * 4] = (p.y - hipY) / span;
    seg[i * 4 + 1] = chainParam(p, arms[side]);
    seg[i * 4 + 2] = chainParam(p, legs[side]);
    seg[i * 4 + 3] = n.x * (side === 'l' ? leftSign : -leftSign);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w <= 0) continue;
      const g = boneGroup[skinIndex.getComponent(i, k)];
      if (g < 4) grp[i * 4 + g] += w;
    }
  }
  geo.setAttribute('aSeg', new BufferAttribute(seg, 4));
  geo.setAttribute('aGrp', new BufferAttribute(grp, 4));
  // Torso height of sole top (~3 cm above the floor) and of the natural waist.
  geo.userData.heights = { sole: (minY + 0.035 - hipY) / span, waist: 0.3 };
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const toLinear = (hex: string) => new Color().setStyle(hex, SRGBColorSpace);

export interface PersonMaterials {
  skin: MeshStandardMaterial;
  hair: MeshStandardMaterial;
  brows: MeshStandardMaterial;
  eyes: Material;
  uniforms: {
    uDesat: { value: number };
    uReveal: { value: number };
    uGlow: { value: Color };
  };
}

/**
 * Rim light for people only (a lit silhouette against the landscape), done in the shader so it
 * never fills in the ground shadows the way a second directional light would.
 */
export const peopleRim = { value: new Color(0, 0, 0) };

const RIM_FRAG = /* glsl */ `
  {
    float rimK = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    totalEmissiveRadiance += uRim * pow(rimK, 3.0);
  }
`;

const GARMENT_VERT_PARS = /* glsl */ `
attribute vec4 aSeg;
attribute vec4 aGrp;
varying vec4 vSeg;
varying vec4 vGrp;
uniform float uInflate;
`;

const GARMENT_FRAG_PARS = /* glsl */ `
varying vec4 vSeg;
varying vec4 vGrp;
uniform vec3 uSkin;
uniform vec3 uTexAvg;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uShoe;
uniform vec3 uTrim;
uniform vec4 uCut;   // hem, neck, sleeve, bottom length
uniform vec4 uMisc;  // waist, sole, _, _
uniform float uDesat;
uniform float uReveal;
uniform vec3 uGlow;
uniform vec3 uRim;
float gCloth;
float gShoe;
float sEdge(float edge, float x) {
  float w = max(fwidth(x), 1e-4) * 0.9;
  return smoothstep(edge - w, edge + w, x);
}
float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float i = q.x + q.y * 4.0;
  // 4x4 Bayer matrix, flattened.
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
  for (int k = 0; k < 16; k++) { if (float(k) == i) return (m[k] + 0.5) / 16.0; }
  return 0.5;
}
`;

const GARMENT_FRAG_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 texel = texture2D( map, vMapUv );
#else
  vec4 texel = vec4(uTexAvg, 1.0);
#endif
  if (uReveal < 0.999 && bayer4(gl_FragCoord.xy) > uReveal) discard;
  float h = vSeg.x;
  float armT = vSeg.y;
  float legT = vSeg.z;
  float outward = vSeg.w;
  float wT = vGrp.x, wA = vGrp.y, wL = vGrp.z, wF = vGrp.w;
  // Coverage votes, weighted by limb membership, then thresholded with AA.
  float topV = wT * sEdge(uCut.x, h) * (1.0 - sEdge(uCut.y, h)) + wA * (1.0 - sEdge(uCut.z, armT));
  float botV = wT * (1.0 - sEdge(uMisc.x, h)) + wL * (1.0 - sEdge(uCut.w, legT));
  float shoeV = wF + wL * sEdge(1.9, legT);
  float top = sEdge(0.5, topV);
  float bottom = sEdge(0.5, botV) * (1.0 - top);
  gShoe = sEdge(0.5, shoeV) * (1.0 - top) * (1.0 - bottom);
  gCloth = max(top, bottom);
  // Detail from the texture: per-channel ratio keeps lips, brows and shading.
  vec3 ratio = clamp(texel.rgb / uTexAvg, 0.0, 2.2);
  vec3 skinCol = uSkin * ratio;
  float shade = mix(1.0, clamp(dot(ratio, vec3(0.3333)), 0.55, 1.25), 0.45);
  // Trims: neckline + sleeve cuffs on the top, waistband + side stripe on the bottoms.
  float neckBand = sEdge(uCut.y - 0.035, h) * wT;
  float cuff = sEdge(uCut.z - 0.06, armT) * wA;
  float waistBand = sEdge(uMisc.x - 0.05, h) * wT;
  float stripe = sEdge(0.975, outward) * wL * (1.0 - sEdge(uCut.w - 0.05, legT));
  vec3 topCol = mix(uTop, uTrim, sEdge(0.5, neckBand + cuff));
  vec3 botCol = mix(uBottom, uTrim, sEdge(0.5, waistBand + stripe));
  float sole = 1.0 - sEdge(uMisc.y, h);
  vec3 shoeCol = mix(uShoe, vec3(0.86, 0.85, 0.82), sole);
  vec3 col = skinCol;
  col = mix(col, botCol * shade, bottom);
  col = mix(col, topCol * shade, top);
  col = mix(col, shoeCol * shade, gShoe);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum) * vec3(0.98, 1.0, 1.03), uDesat);
  diffuseColor.rgb *= col;
`;

const TINT_FRAG_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 texel = texture2D( map, vMapUv );
  float l = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722)) / ${TEX_HAIR_LUM.toFixed(3)};
  diffuseColor.rgb *= clamp(l, 0.2, 2.0);
#endif
  if (uReveal < 0.999 && bayer4(gl_FragCoord.xy) > uReveal) discard;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), uDesat);
`;

const BAYER_PARS = /* glsl */ `
uniform vec3 uRim;
uniform float uDesat;
uniform float uReveal;
float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float i = q.x + q.y * 4.0;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
  for (int k = 0; k < 16; k++) { if (float(k) == i) return (m[k] + 0.5) / 16.0; }
  return 0.5;
}
`;

function makeSkinMaterial(src: MeshStandardMaterial, look: Look, body: BodyTemplate, shared: PersonMaterials['uniforms']) {
  const mat = new MeshStandardMaterial({
    map: src.map,
    normalMap: src.normalMap,
    roughness: 0.62,
    metalness: 0,
  });
  mat.name = `garment_${look.body}`;
  const u = {
    uSkin: { value: toLinear(look.skin) },
    uTexAvg: { value: TEX_SKIN_AVG },
    uTop: { value: toLinear(look.top) },
    uBottom: { value: toLinear(look.bottom) },
    uShoe: { value: toLinear(look.shoe) },
    uTrim: { value: toLinear(look.trim) },
    uCut: { value: [look.hem ?? 0.2, 1.02, look.sleeve, look.bottomLen] },
    uMisc: { value: [body.waistH, body.soleH, 0, 0] },
    uInflate: { value: 0.006 },
    ...shared,
  };
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, u, { uRim: peopleRim });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GARMENT_VERT_PARS}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSeg = aSeg; vGrp = aGrp;
        // Clothes sit a few millimetres proud of the skin; shoes a little more.
        float clothy = clamp(aGrp.x * 0.9 + aGrp.z * 0.9 + aGrp.w * 3.2, 0.0, 3.2);
        transformed += objectNormal * uInflate * clothy;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GARMENT_FRAG_PARS}`)
      .replace('#include <map_fragment>', GARMENT_FRAG_MAP)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.86, gCloth);
        roughnessFactor = mix(roughnessFactor, 0.5, gShoe);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mix(normal, nonPerturbedNormal, max(gCloth, gShoe) * 0.8));`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n totalEmissiveRadiance += uGlow * (0.35 + 0.65 * gCloth);\n${RIM_FRAG}`);
  };
  mat.customProgramCacheKey = () => 'onb-garment-v1';
  mat.userData.garment = u;
  return mat;
}

function makeTintMaterial(src: { map: Texture | null; normalMap?: Texture | null }, color: string, shared: PersonMaterials['uniforms'], roughness: number, doubleSided = false) {
  const mat = new MeshStandardMaterial({
    map: src.map,
    normalMap: src.normalMap ?? null,
    color: toLinear(color),
    roughness,
    metalness: 0,
    side: doubleSided ? 2 : 0,
  });
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, shared, { uRim: peopleRim });
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BAYER_PARS}`)
      .replace('#include <map_fragment>', TINT_FRAG_MAP)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${RIM_FRAG}`);
  };
  mat.customProgramCacheKey = () => 'onb-tint-v1';
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------------------------

export type GroundFn = (x: number, z: number) => number;

export interface PlayOptions {
  fade?: number;
  timeScale?: number;
  once?: boolean;
  /** Sync the new locomotion clip's phase with the current one (walk ↔ jog). */
  warp?: boolean;
  /** Start at this fraction of the clip. */
  at?: number;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _up = new Vector3(0, 1, 0);

interface Leg {
  thigh: Bone;
  calf: Bone;
  foot: Bone;
  ball: Bone;
  /** Smoothed extra height applied to this foot (m). */
  lift: number;
  planted: boolean;
}

export class Person {
  /** Place this in the world: position on the ground, rotation.y = heading. */
  readonly object = new Group();
  readonly look: Look;
  readonly mixer: AnimationMixer;
  readonly materials: PersonMaterials;
  private model: Object3D;
  private actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private legs: Leg[];
  private neck: Bone;
  private arms: Record<'l' | 'r', { upper: Bone; lower: Bone; hand: Bone }>;
  private head: Bone;
  private lookYaw = 0;
  /** World-space point to glance at (friends chatting), or null. */
  lookTarget: Vector3 | null = null;
  /** Ground height below the root (smoothed); the station sets xz and heading. */
  private baseY: number | null = null;
  /** Called when a play-once clip ends (stations chain clips with it). */
  onClipFinished: ((clip: string) => void) | null = null;
  /** Called when a foot lands (world position of the ball of the foot, foot index). */
  onFootPlant: ((position: Vector3, foot: number) => void) | null = null;
  private meshes: Mesh[] = [];

  constructor(
    private readonly lib: PeopleLibrary,
    look: Look,
  ) {
    this.look = look;
    const body = lib.body(look.body);
    this.model = cloneSkinned(body.root);
    this.model.scale.setScalar(look.scale ?? 1);
    this.object.add(this.model);
    this.mixer = new AnimationMixer(this.model);
    this.mixer.addEventListener('finished', (e) => this.onClipFinished?.((e.action as AnimationAction).getClip().name));

    const shared = { uDesat: { value: 0 }, uReveal: { value: 1 }, uGlow: { value: new Color(0, 0, 0) } };
    let skin: MeshStandardMaterial | null = null;
    let brows: MeshStandardMaterial | null = null;
    let eyes: Material | null = null;
    this.model.traverse((node) => {
      const mesh = node as SkinnedMesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Fixed generous bounds: skinned bounds are computed once in whatever pose is current.
      mesh.geometry.boundingSphere = new Sphere(new Vector3(0, 0.9, 0), 1.4);
      mesh.frustumCulled = true;
      const src = mesh.material as MeshStandardMaterial;
      if (mesh.name.startsWith('Body_')) {
        skin = makeSkinMaterial(src, look, body, shared);
        mesh.material = skin;
      } else if (mesh.name.startsWith('Brows_')) {
        brows = makeTintMaterial(src, look.hairColor, shared, 0.8);
        mesh.material = brows;
        mesh.castShadow = false;
      } else if (mesh.name.startsWith('Eyes_')) {
        eyes = src; // shared, untouched
        mesh.castShadow = false;
      }
    });

    const hairSrc = look.hair ? lib.hair(look.hair) : null;
    const hairMat = makeTintMaterial(
      { map: hairSrc?.map ?? null, normalMap: hairSrc?.normalMap ?? null },
      look.hairColor,
      shared,
      0.78,
      true,
    );
    const headBone = this.model.getObjectByName('Head') as Bone;
    if (hairSrc) {
      const hair = new Mesh(hairSrc.geometry, hairMat);
      hairSrc.matrix.decompose(hair.position, hair.quaternion, hair.scale);
      hair.castShadow = true;
      headBone.add(hair);
    }
    let beardMat: MeshStandardMaterial | null = null;
    if (look.beard) {
      const beardSrc = lib.hair('Hair_Beard');
      if (beardSrc) {
        beardMat = makeTintMaterial(beardSrc, look.beardColor ?? look.hairColor, shared, 0.85, true);
        const beard = new Mesh(beardSrc.geometry, beardMat);
        beardSrc.matrix.decompose(beard.position, beard.quaternion, beard.scale);
        headBone.add(beard);
      }
    }
    this.extraMaterials = beardMat ? [beardMat] : [];
    this.materials = { skin: skin!, hair: hairMat, brows: brows!, eyes: eyes!, uniforms: shared };

    const bone = (n: string) => this.model.getObjectByName(n) as Bone;
    this.legs = (['l', 'r'] as const).map((s) => ({
      thigh: bone(`thigh_${s}`),
      calf: bone(`calf_${s}`),
      foot: bone(`foot_${s}`),
      ball: bone(`ball_${s}`),
      lift: 0,
      planted: true,
    }));
    this.neck = bone('neck_01');
    this.arms = {
      l: { upper: bone('upperarm_l'), lower: bone('lowerarm_l'), hand: bone('hand_l') },
      r: { upper: bone('upperarm_r'), lower: bone('lowerarm_r'), hand: bone('hand_r') },
    };
    this.head = headBone;
  }

  private extraMaterials: Material[];

  get kind() {
    return this.look.body;
  }

  private action(name: string): AnimationAction | null {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.lib.clip(this.look.body, name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    this.actions.set(name, a);
    return a;
  }

  get currentClip() {
    return this.current?.getClip().name ?? null;
  }

  /** Crossfades to `name`. Returns the action (or null if that clip is not loaded yet). */
  play(name: string, opts: PlayOptions = {}): AnimationAction | null {
    const next = this.action(name);
    if (!next) return null;
    const { fade = 0.35, timeScale = 1, once = false, warp = false, at } = opts;
    const prev = this.current;
    if (prev === next && next.isRunning()) {
      next.setEffectiveTimeScale(timeScale);
      return next;
    }
    next.reset();
    next.setLoop(once ? LoopOnce : LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    if (at !== undefined) next.time = at * next.getClip().duration;
    else if (warp && prev) next.time = (prev.time / prev.getClip().duration) * next.getClip().duration;
    next.play();
    if (prev && fade > 0) {
      prev.crossFadeTo(next, fade, false);
    } else {
      prev?.stop();
    }
    this.current = next;
    return next;
  }

  /** Stops everything and poses the first frame of `name` (used when a station resets). */
  pose(name: string, at = 0, timeScale = 1) {
    this.mixer.stopAllAction();
    this.current = null;
    this.play(name, { fade: 0, at, timeScale });
    this.mixer.update(0);
  }

  /** Ground speed implied by the blended locomotion clips (m/s), so feet never slide. */
  groundSpeed(): number {
    const body = this.lib.body(this.look.body);
    let v = 0;
    this.actions.forEach((a, name) => {
      const speed = body.speeds.get(name);
      if (!speed || !a.isRunning()) return;
      v += speed * a.getEffectiveWeight() * a.getEffectiveTimeScale();
    });
    return v * (this.look.scale ?? 1);
  }

  /** Measures no-slide speeds for the locomotion clips of this body (once per body). */
  calibrate() {
    const body = this.lib.body(this.look.body);
    for (const name of LOCOMOTION) {
      if (body.speeds.has(name) || !this.lib.hasClip(name)) continue;
      const action = this.action(name);
      if (!action) continue;
      this.mixer.stopAllAction();
      action.reset().play();
      const duration = action.getClip().duration;
      const steps = 48;
      const samples: Array<{ y: number; z: number }[]> = [[], []];
      for (let i = 0; i <= steps; i++) {
        this.mixer.setTime((i / steps) * duration);
        this.model.updateMatrixWorld(true);
        this.legs.forEach((leg, k) => {
          leg.ball.getWorldPosition(_v1);
          this.model.worldToLocal(_v1);
          samples[k].push({ y: _v1.y, z: _v1.z });
        });
      }
      let dist = 0;
      let time = 0;
      samples.forEach((s) => {
        const minY = Math.min(...s.map((q) => q.y));
        for (let i = 1; i < s.length; i++) {
          if (s[i].y < minY + 0.012 && s[i - 1].y < minY + 0.012) {
            dist += s[i - 1].z - s[i].z;
            time += duration / steps;
          }
        }
      });
      const scale = 1 / (this.look.scale ?? 1);
      body.speeds.set(name, time > 0 ? Math.max(0, (dist / time) * scale) : 1);
      action.stop();
    }
    this.mixer.stopAllAction();
    this.current = null;
  }

  private get skinUniforms() {
    return this.materials.skin.userData.garment as { uTop: { value: Color } } | undefined;
  }

  setTop(hex: string) {
    const u = this.skinUniforms;
    if (u) u.uTop.value.setStyle(hex, SRGBColorSpace);
  }

  setDesaturate(v: number) {
    this.materials.uniforms.uDesat.value = v;
  }

  setReveal(v: number) {
    this.materials.uniforms.uReveal.value = v;
  }

  setGlow(color: Color, strength: number) {
    this.materials.uniforms.uGlow.value.copy(color).multiplyScalar(strength);
  }

  /** Snap the smoothed ground height (after teleporting the person). */
  resetGround() {
    this.baseY = null;
    this.legs.forEach((l) => {
      l.lift = 0;
      l.planted = true;
    });
  }

  /**
   * Advances the animation. `ground` (optional) enables stair-aware feet: the body sits on the
   * lower foot's ground and the other leg is solved with two-bone IK onto its step.
   */
  update(dt: number, ground: GroundFn | null, ik: boolean) {
    this.mixer.update(dt);
    const obj = this.object;
    if (ground) {
      obj.updateMatrixWorld(true);
      const heights = this.legs.map((leg) => this.footGround(leg, ground));
      const target = ik ? Math.min(heights[0], heights[1]) : ground(obj.position.x, obj.position.z);
      if (this.baseY === null) this.baseY = target;
      else {
        // Drop quickly (never float), rise a little softer.
        const k = target < this.baseY ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 14);
        this.baseY += (target - this.baseY) * k;
      }
      obj.position.y = this.baseY;
      obj.updateMatrixWorld(true);
      if (ik) {
        this.legs.forEach((leg, i) => {
          const want = Math.max(0, heights[i] - this.baseY!);
          const k = want > leg.lift ? 1 - Math.exp(-dt * 26) : 1 - Math.exp(-dt * 18);
          leg.lift += (want - leg.lift) * k;
          if (leg.lift > 0.004) this.solveLeg(leg, leg.lift);
        });
      }
    } else {
      obj.updateMatrixWorld(true);
    }
    this.updateLook(dt);
    this.applyArmsUp();
    this.detectPlants(ground);
  }

  private footGround(leg: Leg, ground: GroundFn): number {
    leg.foot.getWorldPosition(_v1);
    leg.ball.getWorldPosition(_v2);
    // A little ahead of the toes too, so a step edge lifts the foot before it clips.
    _v3.subVectors(_v2, _v1).setY(0);
    const len = _v3.length() || 1;
    _v3.multiplyScalar(0.09 / len).add(_v2);
    return Math.max(ground(_v1.x, _v1.z), ground(_v2.x, _v2.z), ground(_v3.x, _v3.z));
  }

  /** Two-bone IK (thigh → calf → foot) raising the ankle by `lift`, keeping the foot's world orientation. */
  private solveLeg(leg: Leg, lift: number) {
    const a = leg.thigh.getWorldPosition(new Vector3());
    const b = leg.calf.getWorldPosition(new Vector3());
    const c = leg.foot.getWorldPosition(new Vector3());
    const footWorldQ = leg.foot.getWorldQuaternion(new Quaternion());
    const t = c.clone().setY(c.y + lift);
    const lab = a.distanceTo(b);
    const lcb = b.distanceTo(c);
    const lat = Math.min(Math.max(t.distanceTo(a), Math.abs(lab - lcb) + 0.01), lab + lcb - 0.01);

    const acab0 = Math.acos(clamp1(_v1.subVectors(c, a).normalize().dot(_v2.subVectors(b, a).normalize())));
    const babc0 = Math.acos(clamp1(_v1.subVectors(a, b).normalize().dot(_v2.subVectors(c, b).normalize())));
    const acat0 = Math.acos(clamp1(_v1.subVectors(c, a).normalize().dot(_v2.subVectors(t, a).normalize())));
    const acab1 = Math.acos(clamp1((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
    const babc1 = Math.acos(clamp1((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));

    const axis0 = _v3.crossVectors(_v1.subVectors(c, a), _v2.subVectors(b, a));
    if (axis0.lengthSq() < 1e-8) {
      // Straight leg: bend around the body's right axis.
      axis0.set(1, 0, 0).applyQuaternion(this.object.quaternion);
    }
    axis0.normalize();
    const axis1 = _v4.crossVectors(_v1.subVectors(c, a), _v2.subVectors(t, a));
    const haveAxis1 = axis1.lengthSq() > 1e-10;
    axis1.normalize();

    const aGr = leg.thigh.getWorldQuaternion(new Quaternion());
    const bGr = leg.calf.getWorldQuaternion(new Quaternion());
    const aInv = aGr.clone().invert();
    const bInv = bGr.clone().invert();

    _q1.setFromAxisAngle(axis0.clone().applyQuaternion(aInv), acab1 - acab0);
    leg.thigh.quaternion.multiply(_q1);
    if (haveAxis1) {
      _q3.setFromAxisAngle(axis1.clone().applyQuaternion(aInv), acat0);
      leg.thigh.quaternion.multiply(_q3);
    }
    _q2.setFromAxisAngle(axis0.clone().applyQuaternion(bInv), babc1 - babc0);
    leg.calf.quaternion.multiply(_q2);
    leg.thigh.updateMatrixWorld(true);
    // Keep the foot's world orientation (flat on the step).
    const parentQ = leg.calf.getWorldQuaternion(new Quaternion()).invert();
    leg.foot.quaternion.copy(parentQ.multiply(footWorldQ));
    leg.foot.updateMatrixWorld(true);
  }

  /**
   * Procedural celebration layer: raises the arms overhead (a victory V / fist pump) on top of
   * whatever clip is playing. Weights 0…1 per arm, usually driven by anime.js.
   */
  readonly armsUp = { l: 0, r: 0 };

  private applyArmsUp() {
    for (const side of ['l', 'r'] as const) {
      const w = this.armsUp[side];
      if (w < 0.002) continue;
      const upper = this.arms[side].upper;
      const lower = this.arms[side].lower;
      const hand = this.arms[side].hand;
      const sign = side === 'l' ? 1 : -1;
      const q = this.object.getWorldQuaternion(_q3);
      const outward = _v3.set(sign, 0, 0).applyQuaternion(q);
      const forward = _v4.set(0, 0, 1).applyQuaternion(q);
      const upperDir = new Vector3().copy(_up).multiplyScalar(0.9).addScaledVector(outward, 0.4).addScaledVector(forward, 0.1).normalize();
      const lowerDir = new Vector3().copy(_up).multiplyScalar(0.95).addScaledVector(outward, 0.12).addScaledVector(forward, 0.22).normalize();
      aimBone(upper, lower, upperDir, w);
      aimBone(lower, hand, lowerDir, w);
    }
  }

  private updateLook(dt: number) {
    let want = 0;
    if (this.lookTarget) {
      this.head.getWorldPosition(_v1);
      _v2.subVectors(this.lookTarget, _v1).setY(0);
      const fwd = _v3.set(0, 0, 1).applyQuaternion(this.object.quaternion).setY(0);
      if (_v2.lengthSq() > 1e-4 && fwd.lengthSq() > 1e-4) {
        const angle = Math.atan2(fwd.x * _v2.z - fwd.z * _v2.x, fwd.x * _v2.x + fwd.z * _v2.z);
        want = Math.max(-1.0, Math.min(1.0, -angle));
      }
    }
    this.lookYaw += (want - this.lookYaw) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.lookYaw) < 0.002) return;
    for (const [bone, share] of [
      [this.neck, 0.4],
      [this.head, 0.6],
    ] as const) {
      const parent = bone.parent!;
      parent.getWorldQuaternion(_q1).invert();
      _v1.copy(_up).applyQuaternion(_q1).normalize();
      _q2.setFromAxisAngle(_v1, this.lookYaw * share);
      bone.quaternion.premultiply(_q2);
      bone.updateMatrixWorld(true);
    }
  }

  private detectPlants(ground: GroundFn | null) {
    if (!this.onFootPlant) return;
    this.legs.forEach((leg, i) => {
      leg.ball.getWorldPosition(_v1);
      const g = ground ? ground(_v1.x, _v1.z) : this.object.position.y;
      const h = _v1.y - g;
      const down = h < 0.045;
      if (down && !leg.planted) this.onFootPlant?.(_v1.clone().setY(g), i);
      if (h > 0.07) leg.planted = false;
      else if (down) leg.planted = true;
    });
  }

  /** World position of a bone (e.g. 'hand_r' for catching coins). */
  bonePosition(name: string, target = new Vector3()) {
    const b = this.model.getObjectByName(name);
    return b ? b.getWorldPosition(target) : this.object.getWorldPosition(target);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.actions.forEach((a) => this.mixer.uncacheAction(a.getClip(), this.model));
    this.mixer.uncacheRoot(this.model);
    this.materials.skin.dispose();
    this.materials.hair.dispose();
    this.materials.brows.dispose();
    this.extraMaterials.forEach((m) => m.dispose());
    this.meshes.forEach((m) => (m as SkinnedMesh).skeleton?.dispose());
    this.object.removeFromParent();
  }
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

const _aq = new Quaternion();
const _aw = new Quaternion();
const _ap = new Quaternion();
const _identity = new Quaternion();

/** Rotates a bone (by a weight) so the direction to its child points along a world-space direction. */
function aimBone(bone: Bone, child: Object3D, dir: Vector3, weight: number) {
  const a = bone.getWorldPosition(new Vector3());
  const b = child.getWorldPosition(new Vector3());
  const current = b.sub(a).normalize();
  _ap.setFromUnitVectors(current, dir);
  _aq.slerpQuaternions(_identity, _ap, weight);
  bone.getWorldQuaternion(_aw);
  _aw.premultiply(_aq);
  bone.parent!.getWorldQuaternion(_ap).invert();
  bone.quaternion.copy(_ap.multiply(_aw));
  bone.updateMatrixWorld(true);
}
