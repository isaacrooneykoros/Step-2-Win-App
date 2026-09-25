/**
 * Builds the onboarding 3D assets (src/assets/onboarding/*.glb) from Quaternius' CC0 packs.
 *
 *   node scripts/build-onboarding-assets.mjs <sourceDir>
 *
 * <sourceDir> holds the three unzipped "Standard" (free, CC0) downloads:
 *   ubc/  Universal Base Characters[Standard]     https://quaternius.itch.io/universal-base-characters
 *   ual1/ Universal Animation Library[Standard]   https://quaternius.itch.io/universal-animation-library
 *   ual2/ Universal Animation Library 2[Standard] https://quaternius.itch.io/universal-animation-library-2
 *
 * Output:
 *   people-core.glb   female body + eyes/brows, every hairstyle (baked into head-bone space),
 *                     the clips page 1 needs (jog, walk, idle, talk)
 *   people-extra.glb  male body + eyes/brows, the remaining clips (celebrate, jump, pose…)
 *
 * Each file: unused attributes stripped, welded, quantised, meshopt-compressed; textures resized
 * and re-encoded as WebP; animation tracks limited to bone rotations (+ pelvis translation) and
 * resampled. Decoded at runtime with three's MeshoptDecoder (bundled, no CDN).
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, quantize, resample, textureCompress, weld, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const src = path.resolve(process.argv[2] || '');
const out = path.resolve('src/assets/onboarding');
if (!fs.existsSync(path.join(src, 'ubc'))) {
  console.error('usage: node scripts/build-onboarding-assets.mjs <dir with ubc/ ual1/ ual2/>');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const UBC = path.join(src, 'ubc', 'Universal Base Characters[Standard]');
const BODY_DIR = path.join(UBC, 'Base Characters', 'Godot - UE');
const TEX_DIR = path.join(UBC, 'Base Characters', 'Textures');
const GL_NORMALS = path.join(TEX_DIR, 'Normals Unity - Godot');
const HAIR_DIR = path.join(UBC, 'Hairstyles', 'Rigged to Head Bone', 'glTF (Godot -Unreal)');
const UAL1 = path.join(src, 'ual1', 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb');
const UAL2 = path.join(src, 'ual2', 'Universal Animation Library 2[Standard]', 'Unreal-Godot', 'UAL2_Standard.glb');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** Mannequin pelvis height (m) the clips were authored on; pelvis tracks are rescaled per body. */
const MANNEQUIN_PELVIS = 0.9167;

/** Resolves a texture URI from the pack (some references point at "_png.png" names that do not exist). */
function findTexture(uri, isNormal) {
  const base = decodeURIComponent(uri).replace(/_png\.png$/, '.png');
  if (isNormal && fs.existsSync(path.join(GL_NORMALS, base))) return path.join(GL_NORMALS, base);
  for (const dir of [TEX_DIR, BODY_DIR, HAIR_DIR]) {
    if (fs.existsSync(path.join(dir, base))) return path.join(dir, base);
  }
  throw new Error(`texture not found: ${uri}`);
}

/** Reads a .gltf + .bin, fixing texture paths and picking OpenGL-convention normal maps. */
async function readGltf(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const normalImages = new Set();
  for (const m of json.materials || []) {
    if (m.normalTexture) normalImages.add(json.textures[m.normalTexture.index].source);
  }
  const resources = {};
  json.images = (json.images || []).map((img, i) => {
    const file = findTexture(img.uri, normalImages.has(i));
    const key = `img_${i}.png`;
    resources[key] = new Uint8Array(fs.readFileSync(file));
    return { uri: key, mimeType: 'image/png' };
  });
  for (const b of json.buffers) resources[b.uri] = new Uint8Array(fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(b.uri))));
  return io.readJSON({ json, resources });
}

function stripAttributes(doc, keep) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) {
        if (!keep.includes(semantic)) prim.setAttribute(semantic, null);
      }
    }
  }
}

/** Body: keep base colour + normal map, drop the roughness texture (constant roughness in-app). */
async function buildBody(file, tag) {
  const doc = await readGltf(file);
  stripAttributes(doc, ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']);
  for (const mat of doc.getRoot().listMaterials()) {
    mat.setMetallicRoughnessTexture(null);
    mat.setDoubleSided(false);
    const n = mat.getName();
    if (/Eyes/.test(n)) mat.setNormalTexture(null);
    if (/Hair/.test(n)) {
      // Brows share the hair atlas; flat shading is enough at this size.
      mat.setNormalTexture(null);
    }
    mat.setName(/Eyes/.test(n) ? 'Eyes' : /Hair/.test(n) ? `Brows_${tag}` : `Skin_${tag}`);
  }
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const n = node.getName();
    node.setName(/Eyes/.test(n) ? `Eyes_${tag}` : /Eyebrows|Face/.test(n) ? `Brows_${tag}` : `Body_${tag}`);
    node.getMesh().setName(node.getName());
  }
  doc.getRoot().listNodes().find((n) => n.getName() === 'Armature').setName(`Rig_${tag}`);
  doc.getRoot().listScenes()[0].setName(tag);
  return doc;
}

/** Hair: rigged to the head bone only — bake into head-bone space and drop the skeleton. */
async function buildHair(doc) {
  const files = ['Hair_Buzzed', 'Hair_BuzzedFemale', 'Hair_Buns', 'Hair_Long', 'Hair_Beard', 'Hair_SimpleParted'];
  const scene = doc.getRoot().listScenes()[0];
  const group = doc.createNode('Hairs');
  scene.addChild(group);
  let hairMaterial1 = null;
  let hairMaterial2 = null;
  for (const name of files) {
    const hdoc = await readGltf(path.join(HAIR_DIR, `${name}.gltf`));
    const skin = hdoc.getRoot().listSkins()[0];
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices().getArray();
    const headIndex = joints.findIndex((j) => j.getName() === 'Head');
    const meshNode = hdoc.getRoot().listNodes().find((n) => n.getMesh());
    const prim = meshNode.getMesh().listPrimitives()[0];
    const m = Array.from(ibm.slice(headIndex * 16, headIndex * 16 + 16));
    // Validate all vertices are bound to the head alone.
    const jointsAttr = prim.getAttribute('JOINTS_0').getArray();
    const jointsSeen = new Set();
    for (let i = 0; i < jointsAttr.length; i += 4) jointsSeen.add(jointsAttr[i]);
    if (jointsSeen.size !== 1 || !jointsSeen.has(headIndex)) console.warn(`${name}: joints ${[...jointsSeen]}`);

    const pos = prim.getAttribute('POSITION').getArray();
    const nor = prim.getAttribute('NORMAL').getArray();
    const newPos = new Float32Array(pos.length);
    const newNor = new Float32Array(nor.length);
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
      newPos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      newPos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      newPos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const [a, b, c] = [nor[i], nor[i + 1], nor[i + 2]];
      let nx = m[0] * a + m[4] * b + m[8] * c;
      let ny = m[1] * a + m[5] * b + m[9] * c;
      let nz = m[2] * a + m[6] * b + m[10] * c;
      const len = Math.hypot(nx, ny, nz) || 1;
      newNor[i] = nx / len;
      newNor[i + 1] = ny / len;
      newNor[i + 2] = nz / len;
    }
    const uv = prim.getAttribute('TEXCOORD_0').getArray();
    const idx = prim.getIndices().getArray();

    const buffer = doc.getRoot().listBuffers()[0];
    const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
    const srcMat = prim.getMaterial();
    const is2 = /Hair_2/.test(srcMat.getName());
    let material = is2 ? hairMaterial2 : hairMaterial1;
    if (!material) {
      material = doc.createMaterial(is2 ? 'Hair_2' : 'Hair_1').setMetallicFactor(0).setRoughnessFactor(0.72).setDoubleSided(true);
      const img = srcMat.getBaseColorTexture();
      const tex = doc.createTexture(is2 ? 'hair2' : 'hair1').setImage(img.getImage()).setMimeType(img.getMimeType());
      material.setBaseColorTexture(tex);
      const nimg = srcMat.getNormalTexture();
      if (nimg) material.setNormalTexture(doc.createTexture(is2 ? 'hair2n' : 'hair1n').setImage(nimg.getImage()).setMimeType(nimg.getMimeType()));
      if (is2) hairMaterial2 = material;
      else hairMaterial1 = material;
    }
    const newPrim = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', newPos))
      .setAttribute('NORMAL', acc('VEC3', newNor))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uv)))
      .setIndices(acc('SCALAR', new Uint32Array(idx)))
      .setMaterial(material);
    const mesh = doc.createMesh(name).addPrimitive(newPrim);
    group.addChild(doc.createNode(name).setMesh(mesh));
  }
}

/** Clips: rotations for every bone + pelvis translation (pelvis rescaled per body at runtime), no scale tracks. */
async function addClips(target, file, names, pelvisHeight) {
  const adoc = await io.read(file);
  const nodesByName = new Map(target.getRoot().listNodes().map((n) => [n.getName(), n]));
  const buffer = target.getRoot().listBuffers()[0];
  const ratio = pelvisHeight / MANNEQUIN_PELVIS;
  const found = [];
  for (const anim of adoc.getRoot().listAnimations()) {
    if (!names.includes(anim.getName())) continue;
    found.push(anim.getName());
    const clip = target.createAnimation(anim.getName());
    for (const ch of anim.listChannels()) {
      const nodeName = ch.getTargetNode().getName();
      const pathName = ch.getTargetPath();
      if (pathName === 'scale') continue;
      if (pathName === 'translation' && nodeName !== 'pelvis') continue;
      const node = nodesByName.get(nodeName);
      if (!node) continue;
      const s = ch.getSampler();
      let output = new Float32Array(s.getOutput().getArray());
      if (pathName === 'translation') output = output.map((v) => v * ratio);
      const sampler = target
        .createAnimationSampler()
        .setInput(target.createAccessor().setType('SCALAR').setArray(new Float32Array(s.getInput().getArray())).setBuffer(buffer))
        .setOutput(target.createAccessor().setType(s.getOutput().getType()).setArray(output).setBuffer(buffer))
        .setInterpolation(s.getInterpolation());
      clip.addSampler(sampler).addChannel(target.createAnimationChannel().setTargetNode(node).setTargetPath(pathName).setSampler(sampler));
    }
  }
  const missing = names.filter((n) => !found.includes(n));
  if (missing.length) throw new Error(`missing clips: ${missing}`);
}

async function finish(doc, file, { skinSize, normalSize }) {
  await doc.transform(
    unpartition(),
    prune({ keepLeaves: true }),
    dedup(),
    weld(),
    resample({ tolerance: 0.0005 }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      slots: /baseColor/,
      resize: [skinSize, skinSize],
      quality: 82,
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      slots: /normal/,
      resize: [normalSize, normalSize],
      quality: 88,
    }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    prune({ keepLeaves: true }),
  );
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true);
  await io.write(path.join(out, file), doc);
  console.log(file, (fs.statSync(path.join(out, file)).size / 1024).toFixed(1), 'KB');
}

// Core: female + all hair + page-1 clips.
{
  const doc = await buildBody(path.join(BODY_DIR, 'Superhero_Female_FullBody.gltf'), 'F');
  await buildHair(doc);
  await addClips(doc, UAL1, ['Jog_Fwd_Loop', 'Walk_Loop', 'Idle_Loop', 'Idle_Talking_Loop'], MANNEQUIN_PELVIS);
  await finish(doc, 'people-core.glb', { skinSize: 1024, normalSize: 512 });
}
// Extra: male + the rest of the clips (bound to the male rig; clips drive any rig by bone name).
{
  const doc = await buildBody(path.join(BODY_DIR, 'Superhero_Male_FullBody.gltf'), 'M');
  await addClips(doc, UAL1, ['Dance_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Sprint_Loop'], MANNEQUIN_PELVIS);
  await addClips(doc, UAL2, ['Yes', 'Idle_FoldArms_Loop', 'Idle_Rail_Call'], MANNEQUIN_PELVIS);
  await finish(doc, 'people-extra.glb', { skinSize: 1024, normalSize: 512 });
}
