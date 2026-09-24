import {
  BufferGeometry,
  Color,
  Material,
  Mesh,
  NoToneMapping,
  Object3D,
  Path,
  Shape,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from 'three';

/**
 * Shared Three.js plumbing for the splash and onboarding scenes. Lives in the lazily loaded
 * 3D chunk only — nothing here may be imported from the main entry.
 */

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

/** Rough low-end heuristic: few cores or little RAM (Chrome/WebView expose deviceMemory). */
export function isLowEndDevice(): boolean {
  const nav = navigator as NavigatorWithMemory;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory;
  return cores <= 4 || (typeof memory === 'number' && memory <= 3);
}

/** Device pixel ratio capped at 2 (1.5 on low-end phones). */
export function cappedPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, isLowEndDevice() ? 1.5 : 2);
}

let webgl2Ok: boolean | null = null;

/**
 * Probes WebGL2 once on a throwaway canvas (three.js r163+ needs WebGL2). Checking first keeps
 * the console clean on devices without it: three.js logs errors when context creation fails.
 */
export function webgl2Available(): boolean {
  if (webgl2Ok !== null) return webgl2Ok;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    webgl2Ok = !!gl && !gl.isContextLost();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2Ok = false;
  }
  return webgl2Ok;
}

/**
 * Creates a transparent renderer (the page background shows through, so both themes match
 * exactly). Throws when WebGL is unavailable; callers fall back to their static version.
 */
export function createRenderer(canvas: HTMLCanvasElement, options: { antialias?: boolean } = {}): WebGLRenderer {
  if (!webgl2Available()) throw new Error('WebGL2 unavailable');
  const pixelRatio = cappedPixelRatio();
  // MSAA only where it is cheap and visible: low-DPR screens, or when the caller insists.
  const antialias = options.antialias ?? (pixelRatio < 2 && !isLowEndDevice());
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias,
    powerPreference: 'low-power',
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false,
    depth: true,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  return renderer;
}

/**
 * Reads an HSL design token (`--brand: 158 74% 29%`) into a Three.js colour, so the scene
 * always uses the live light/dark palette. Unknown tokens fall back to `fallback`.
 */
export function tokenColor(name: string, fallback = '#888888', el: Element = document.documentElement): Color {
  const raw = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  const match = raw.match(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%/);
  const color = new Color();
  if (!match) return color.setStyle(fallback);
  return color.setHSL(Number(match[1]) / 360, Number(match[2]) / 100, Number(match[3]) / 100, SRGBColorSpace);
}

/** 2D rounded rectangle centred on the origin (used for the logo tile and stroke segments). */
export function roundedRectShape(width: number, height: number, radius: number): Shape {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const shape = new Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(w, h - r);
  shape.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-w + r, h);
  shape.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w, -h + r);
  shape.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** Closed path helper for simple outlines (shield, footprint). */
export function pathFrom(points: Array<[number, number]>): Path {
  const path = new Path();
  points.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  return path;
}

/**
 * Frees every GPU resource under `root`: geometries, materials and their textures.
 * Shared resources are tracked in a Set so each is disposed exactly once.
 */
export function disposeTree(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) {
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => materials.add(m));
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((material) => {
    Object.values(material).forEach((value) => {
      if (value instanceof Texture) value.dispose();
    });
    material.dispose();
  });
}

/**
 * Releases the renderer and its WebGL context immediately (instead of waiting for GC),
 * so opening and closing a scene repeatedly can never exhaust the browser's context limit.
 */
export function releaseRenderer(renderer: WebGLRenderer) {
  renderer.setAnimationLoop(null);
  renderer.renderLists.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}

/** Smoothstep easing for scrubbed (finger-driven) values. */
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
