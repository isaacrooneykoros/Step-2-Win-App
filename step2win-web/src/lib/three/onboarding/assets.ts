import type { AnimationClip, Group } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Onboarding character assets (Quaternius, CC0 — see src/assets/onboarding/LICENSES.md).
 * Two files so page 1 can start as soon as the first arrives:
 *   core  — female body, every hairstyle, jog / walk / idle / talk clips
 *   extra — male body, celebrate / jump / pose clips
 * Bundled by Vite (hashed, same origin); the meshopt decoder is part of this chunk.
 */
const URLS = {
  core: new URL('../../../assets/onboarding/people-core.glb', import.meta.url).href,
  extra: new URL('../../../assets/onboarding/people-extra.glb', import.meta.url).href,
} as const;

export type AssetKey = keyof typeof URLS;

export interface PeopleAssets {
  scene: Group;
  clips: AnimationClip[];
}

const bytes = new Map<AssetKey, Promise<ArrayBuffer>>();
const parsed = new Map<AssetKey, Promise<PeopleAssets>>();

/** Starts (or joins) the download of one file. Safe to call repeatedly. */
export function fetchAsset(key: AssetKey): Promise<ArrayBuffer> {
  let p = bytes.get(key);
  if (!p) {
    p = fetch(URLS[key], { credentials: 'same-origin' }).then((res) => {
      if (!res.ok) throw new Error(`asset ${key}: HTTP ${res.status}`);
      return res.arrayBuffer();
    });
    // A failed download may be retried by a later call.
    p.catch(() => bytes.delete(key));
    bytes.set(key, p);
  }
  return p;
}

/** Fetches both files (core first so it gets the bandwidth). */
export function prefetchAssets() {
  void fetchAsset('core')
    .catch(() => null)
    .then(() => fetchAsset('extra').catch(() => null));
}

/** Downloaded + decoded glTF. Parsing creates fresh objects each time the world is created. */
export function loadAsset(key: AssetKey): Promise<PeopleAssets> {
  let p = parsed.get(key);
  if (!p) {
    p = fetchAsset(key).then(
      (buffer) =>
        new Promise<PeopleAssets>((resolve, reject) => {
          performance.mark(`onboarding3d:parse-${key}-start`);
          const loader = new GLTFLoader();
          loader.setMeshoptDecoder(MeshoptDecoder);
          // parse() copies what it needs; keep the source bytes for a later world.
          loader.parse(
            buffer.slice(0),
            '',
            (gltf: GLTF) => {
              performance.mark(`onboarding3d:parse-${key}-end`);
              resolve({ scene: gltf.scene, clips: gltf.animations });
            },
            (err) => reject(err instanceof Error ? err : new Error(String(err))),
          );
        }),
    );
    p.catch(() => parsed.delete(key));
    parsed.set(key, p);
  }
  return p;
}

/**
 * Parsed scenes own GPU resources once rendered; after a world is disposed they are dropped
 * so the next world parses afresh (bytes stay cached, so no second download).
 */
export function forgetParsedAssets() {
  parsed.clear();
}
