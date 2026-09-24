import { createTimeline, cubicBezier, type Timeline } from 'animejs';
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  Shape,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { clamp, createRenderer, disposeTree, releaseRenderer, tokenColor } from './webgl';

/**
 * The onboarding world: four small scenes on floating landings, joined by flights of steps
 * that climb from one to the next — the Step2Win stair, literally. One persistent canvas; the
 * camera flies (or follows the finger) between landings, and each landing plays a short,
 * one-off entrance when it is reached. No textures, no network assets, ~10k triangles.
 *
 *   0 Move         — footprints land on a stair, one per step; a shield confirms they count.
 *   1 Challenge    — four walkers climb a shared stair toward a milestone flag; you are in green.
 *   2 Earn         — each entry drops a coin into the pool; it is split only among those who qualified.
 *   3 Consistency  — seven days rise as a staircase; you hop up your streak to today.
 */

export const STATION_COUNT = 4;

const STATION_SPACING = new Vector3(22, 5, 0);
const PLATFORM_R = 6;
/** Camera direction from each landing (slightly left, above) and base distance. */
const CAMERA_DIR = new Vector3(-0.2, 0.56, 0.8).normalize();
const CAMERA_DISTANCE = 21;
const LOOK_OFFSET = new Vector3(0.3, 1.1, 0);
/** Width (world units) that must always fit horizontally, so narrow phones pull back. */
const FRAME_WIDTH = 14.6;
const FOV = 34;

const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.05, 0.7, 0.1, 1),
};

export interface OnboardingWorld {
  /** Continuous position along the landings (0…3); fractional while dragging or flying. */
  setProgress: (progress: number) => void;
  /** Reset landing `index` and play its entrance (after `delayMs`, as the camera arrives). */
  enterStation: (index: number, delayMs?: number) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

interface Station {
  group: Group;
  reset: () => void;
  play: (tl: Timeline) => void;
}

interface Palette {
  surface: Color;
  platform: Color;
  brand: Color;
  brandSoft: Color;
  reward: Color;
  success: Color;
  neutral: Color;
  faint: Color;
  fg: Color;
  page: Color;
}

function readPalette(scope: Element): Palette {
  return {
    surface: tokenColor('bg-card', '#FFFFFF', scope),
    platform: tokenColor('bg-input', '#EDEBE7', scope),
    brand: tokenColor('brand', '#14855D', scope),
    brandSoft: tokenColor('brand-soft', '#E6F4EC', scope),
    reward: tokenColor('reward', '#F5A30A', scope),
    success: tokenColor('success', '#1F8A5B', scope),
    neutral: tokenColor('text-muted', '#6B7479', scope),
    faint: tokenColor('border-default', '#E2DFDA', scope),
    fg: tokenColor('brand-fg', '#FFFFFF', scope),
    page: tokenColor('bg-page', '#F6F5F2', scope),
  };
}

export function createOnboardingWorld(
  canvas: HTMLCanvasElement,
  options: { tokenScope: Element; onContextLost: () => void; onFirstFrame: () => void },
): OnboardingWorld {
  const renderer = createRenderer(canvas);
  const scene = new Scene();
  const palette = readPalette(options.tokenScope);
  // Neighbouring landings fade into the page colour; set relative to the camera distance in resize().
  const fog = new Fog(palette.page, 27, 50);
  scene.fog = fog;

  const camera = new PerspectiveCamera(FOV, 1, 1, 120);

  // Soft, even light: sky/ground fill plus one key from the upper left. Faces separate by
  // orientation (tops brightest) so white-on-warm-white still reads as solid.
  const hemi = new HemisphereLight(0xffffff, palette.neutral, 0.5 * Math.PI);
  const key = new DirectionalLight(0xffffff, 0.56 * Math.PI);
  key.position.set(-6, 12, 8);
  scene.add(hemi, key);

  // ── Shared geometry ─────────────────────────────────────────────────────────
  const geo = {
    /** Unit box with its base at y = 0, so scaling y grows it upward. */
    block: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    platform: new CylinderGeometry(PLATFORM_R, PLATFORM_R, 0.9, 48).translate(0, -0.45, 0),
    body: new CapsuleGeometry(0.42, 0.72, 4, 12).translate(0, 0.78, 0),
    head: new SphereGeometry(0.34, 14, 10).translate(0, 1.98, 0),
    coin: new CylinderGeometry(0.36, 0.36, 0.12, 20),
    ring: new RingGeometry(0.62, 0.8, 28).rotateX(-Math.PI / 2).translate(0, 0.02, 0),
    footprint: footprintGeometry(),
    shield: shieldGeometry(),
    check: checkGeometry(),
    pole: new CylinderGeometry(0.06, 0.06, 2.4, 6).translate(0, 1.2, 0),
    pennant: pennantGeometry(),
    pool: new CylinderGeometry(1.75, 1.5, 0.55, 36).translate(0, 0.275, 0),
    poolFill: new CylinderGeometry(1.5, 1.5, 0.3, 36).translate(0, 0.15, 0),
  };

  const shared = {
    surface: new MeshLambertMaterial({ color: palette.surface }),
    platform: new MeshLambertMaterial({ color: palette.platform }),
    brand: new MeshLambertMaterial({ color: palette.brand }),
    brandSoft: new MeshLambertMaterial({ color: palette.brandSoft }),
    reward: new MeshLambertMaterial({ color: palette.reward }),
    fg: new MeshLambertMaterial({ color: palette.fg }),
    neutral: new MeshLambertMaterial({ color: palette.neutral }),
    faint: new MeshLambertMaterial({ color: palette.faint }),
  };
  /** Per-object material when its colour animates. */
  const own = (color: Color) => new MeshLambertMaterial({ color: color.clone() });

  const mesh = (geometry: BufferGeometry, material: MeshLambertMaterial, parent: Object3D) => {
    const m = new Mesh(geometry, material);
    parent.add(m);
    return m;
  };

  const pawn = (material: MeshLambertMaterial, parent: Object3D) => {
    const g = new Group();
    mesh(geo.body, material, g);
    mesh(geo.head, material, g);
    parent.add(g);
    return g;
  };

  const stationOrigin = (i: number) => STATION_SPACING.clone().multiplyScalar(i);

  // ── Landings and the flights of steps between them ──────────────────────────
  for (let i = 0; i < STATION_COUNT; i += 1) {
    const origin = stationOrigin(i);
    const platform = mesh(geo.platform, shared.platform, scene);
    platform.position.copy(origin);
    if (i < STATION_COUNT - 1) {
      const gap = STATION_SPACING.x - PLATFORM_R * 2;
      const count = 6;
      for (let s = 1; s <= count; s += 1) {
        const step = mesh(geo.block, shared.surface, scene);
        const top = (STATION_SPACING.y * s) / (count + 1);
        step.scale.set(gap / count - 0.12, 0.5, 2.6);
        step.position.set(origin.x + PLATFORM_R + (s - 0.5) * (gap / count), origin.y + top - 0.5, 0);
      }
    }
  }

  const stations: Station[] = [
    buildMove(),
    buildChallenge(),
    buildEarn(),
    buildConsistency(),
  ];
  stations.forEach((station, i) => {
    station.group.position.copy(stationOrigin(i));
    scene.add(station.group);
    station.reset();
  });

  // ── Station 0: Move ─────────────────────────────────────────────────────────
  function buildMove(): Station {
    const group = new Group();
    const tops: number[] = [];
    const xs: number[] = [];
    for (let k = 0; k < 5; k += 1) {
      const step = mesh(geo.block, shared.surface, group);
      const top = 0.6 * (k + 1);
      const x = -4.2 + k * 2;
      step.scale.set(2, top, 3.4);
      step.position.set(x, 0, 0);
      tops.push(top);
      xs.push(x);
    }
    const prints = xs.map((x, k) => {
      const m = mesh(geo.footprint, own(palette.faint), group);
      m.position.set(x - 0.1, tops[k] + 0.01, k % 2 === 0 ? 0.62 : -0.62);
      return m;
    });
    const shield = new Group();
    mesh(geo.shield, shared.brand, shield);
    const check = mesh(geo.check, shared.fg, shield);
    check.position.z = 0.44;
    group.add(shield);
    const shieldHome = new Vector3(3.9, tops[4] + 2.2, 0.2);

    return {
      group,
      reset() {
        prints.forEach((m) => {
          m.scale.setScalar(0.001);
          (m.material as MeshLambertMaterial).color.copy(palette.faint);
        });
        shield.scale.setScalar(0.001);
        shield.rotation.y = -1.3;
        shield.position.copy(shieldHome).add(new Vector3(0, -0.9, 0));
      },
      play(tl) {
        prints.forEach((m, k) => {
          const at = 80 + k * 170;
          tl.add(m.scale, { x: [0.001, 1.35], y: [0.001, 1], z: [0.001, 1.35], duration: 320, ease: 'outBack(1.8)' }, at);
          addColor(tl, m, palette.faint, palette.brand, 260, at + 60);
        });
        const at = 80 + 5 * 170;
        tl.add(shield.scale, { x: 1.3, y: 1.3, z: 1.3, duration: 520, ease: 'outBack(1.4)' }, at);
        tl.add(shield.rotation, { y: 0, duration: 700, ease: ease.enter }, at);
        tl.add(shield.position, { y: shieldHome.y, duration: 600, ease: ease.enter }, at);
      },
    };
  }

  // ── Station 1: Challenge ────────────────────────────────────────────────────
  function buildChallenge(): Station {
    const group = new Group();
    const stepTop = (level: number) => 0.55 * level;
    const stepX = (level: number) => (level === 0 ? -4.8 : -2.6 + (level - 1) * 1.9);
    for (let k = 0; k < 4; k += 1) {
      const step = mesh(geo.block, shared.surface, group);
      step.scale.set(1.9, stepTop(k + 1), 6.2);
      step.position.set(stepX(k + 1), 0, 0);
    }
    const flag = new Group();
    mesh(geo.pole, shared.neutral, flag);
    const pennant = mesh(geo.pennant, shared.brand, flag);
    pennant.position.set(0.05, 1.65, 0);
    flag.position.set(stepX(4) + 0.45, stepTop(4), -2.6);
    group.add(flag);

    // Lanes (back to front) and how far each walker gets. "You" is second.
    const lanes = [
      { z: -2.1, levels: 4, you: false },
      { z: -0.7, levels: 3, you: true },
      { z: 0.7, levels: 2, you: false },
      { z: 2.1, levels: 1, you: false },
    ];
    const walkers = lanes.map((lane) => {
      const g = pawn(lane.you ? shared.brand : shared.neutral, group);
      g.rotation.y = -0.35;
      return { g, lane };
    });

    return {
      group,
      reset() {
        walkers.forEach(({ g, lane }) => g.position.set(stepX(0), 0, lane.z));
        flag.scale.set(1, 0.001, 1);
      },
      play(tl) {
        tl.add(flag.scale, { y: 1, duration: 480, ease: 'outBack(1.6)' }, 60);
        walkers.forEach(({ g, lane }, i) => {
          for (let level = 1; level <= lane.levels; level += 1) {
            const at = 220 + (level - 1) * 250 + i * 70;
            const fromY = stepTop(level - 1);
            const toY = stepTop(level);
            tl.add(g.position, { x: stepX(level), duration: 250, ease: 'inOutSine' }, at);
            tl.add(g.position, { y: [{ to: Math.max(fromY, toY) + 0.7, duration: 125, ease: 'outQuad' }, { to: toY, duration: 125, ease: 'inQuad' }] }, at);
          }
        });
      },
    };
  }

  // ── Station 2: Earn ─────────────────────────────────────────────────────────
  function buildEarn(): Station {
    const group = new Group();
    const poolAt = new Vector3(0, 0, 0.9);
    const pool = mesh(geo.pool, shared.surface, group);
    pool.position.copy(poolAt);
    const fill = mesh(geo.poolFill, shared.reward, group);
    fill.position.copy(poolAt).add(new Vector3(0, 0.12, 0));

    const qualified = [true, true, false, true, false];
    const people = qualified.map((ok, i) => {
      const angle = Math.PI * (1.12 + 0.19 * i);
      const g = pawn(own(palette.neutral), group);
      g.position.set(Math.cos(angle) * 4.4, 0, poolAt.z + Math.sin(angle) * 3.4);
      g.lookAt(poolAt.x, 0, poolAt.z + 6);
      const ring = mesh(geo.ring, own(palette.success), group);
      ring.position.set(g.position.x, 0, g.position.z);
      const coin = mesh(geo.coin, shared.reward, group);
      return { g, ok, ring, coin, material: g.children[0] as Mesh };
    });

    return {
      group,
      reset() {
        fill.scale.set(1, 0.001, 1);
        people.forEach((p) => {
          p.coin.scale.setScalar(0.001);
          p.coin.position.set(p.g.position.x, 2.75, p.g.position.z);
          p.coin.rotation.set(Math.PI / 2, 0, 0);
          p.ring.scale.setScalar(0.001);
          p.g.scale.setScalar(1);
          ((p.material.material) as MeshLambertMaterial).color.copy(palette.neutral);
        });
      },
      play(tl) {
        // Everyone's entry goes into the pool…
        people.forEach((p, i) => {
          const at = 80 + i * 120;
          tl.add(p.coin.scale, { x: 1, y: 1, z: 1, duration: 200, ease: 'outBack(2)' }, at);
          tl.add(p.coin.position, { x: poolAt.x + (i - 2) * 0.25, z: poolAt.z, duration: 380, ease: 'inOutSine' }, at + 180);
          tl.add(p.coin.position, { y: [{ to: 3.6, duration: 170, ease: 'outQuad' }, { to: 0.5, duration: 210, ease: 'inQuad' }] }, at + 180);
          tl.add(p.coin.rotation, { x: 0, duration: 380, ease: 'inOutSine' }, at + 180);
          tl.add(p.coin.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 120, ease: 'inQuad' }, at + 520);
          tl.add(fill.scale, { y: (i + 1) / 5, duration: 220, ease: 'outQuad' }, at + 540);
        });
        // …and only those who qualified share it.
        const split = 1280;
        let q = 0;
        people.forEach((p) => {
          if (p.ok) {
            const at = split + q * 110;
            q += 1;
            tl.set(p.coin.position, { x: poolAt.x, y: 0.5, z: poolAt.z }, at);
            tl.set(p.coin.rotation, { x: 0 }, at);
            tl.add(p.coin.scale, { x: 1, y: 1, z: 1, duration: 160, ease: 'outBack(2)' }, at);
            tl.add(p.coin.position, { x: p.g.position.x, z: p.g.position.z + 0.95, duration: 420, ease: 'inOutSine' }, at);
            tl.add(p.coin.position, { y: [{ to: 2.6, duration: 190, ease: 'outQuad' }, { to: 0.08, duration: 230, ease: 'inQuad' }] }, at);
            addColor(tl, p.material, palette.neutral, palette.success, 260, at + 380);
            tl.add(p.ring.scale, { x: 1, y: 1, z: 1, duration: 360, ease: 'outBack(1.6)' }, at + 380);
          } else {
            addColor(tl, p.material, palette.neutral, palette.faint, 360, split + 200);
            tl.add(p.g.scale, { x: 0.94, y: 0.9, z: 0.94, duration: 360, ease: 'outQuad' }, split + 200);
          }
        });
        tl.add(fill.scale, { y: 0.001, duration: 560, ease: ease.standard }, split);
      },
    };
  }

  // ── Station 3: Consistency ──────────────────────────────────────────────────
  function buildConsistency(): Station {
    const group = new Group();
    const DONE = 5;
    const x = (k: number) => -4.35 + k * 1.45;
    const height = (k: number) => 0.45 + k * 0.38;
    const days = Array.from({ length: 7 }, (_, k) => {
      const m = mesh(geo.block, own(palette.faint), group);
      m.position.set(x(k), 0, 0);
      return m;
    });
    const walker = pawn(shared.brand, group);
    walker.rotation.y = -0.4;
    // Today is under way; tomorrow is just a tile.
    const finalHeight = (k: number) => (k < DONE ? height(k) : k === DONE ? height(k) * 0.55 : 0.14);
    const finalColor = (k: number) => (k < DONE ? palette.brand : k === DONE ? palette.brandSoft : palette.faint);

    return {
      group,
      reset() {
        days.forEach((m) => {
          m.scale.set(1.2, 0.02, 2.4);
          (m.material as MeshLambertMaterial).color.copy(palette.faint);
        });
        walker.scale.setScalar(0.001);
        walker.position.set(x(0), height(0), 0);
      },
      play(tl) {
        days.forEach((m, k) => {
          const at = 80 + k * 200;
          tl.add(m.scale, { y: finalHeight(k), duration: 420, ease: 'outBack(1.3)' }, at);
          addColor(tl, m, palette.faint, finalColor(k), 300, at + 120);
        });
        tl.add(walker.scale, { x: 1, y: 1, z: 1, duration: 320, ease: 'outBack(1.8)' }, 380);
        for (let k = 1; k < DONE; k += 1) {
          const at = 520 + k * 200;
          tl.add(walker.position, { x: x(k), duration: 200, ease: 'inOutSine' }, at);
          tl.add(walker.position, { y: [{ to: height(k) + 0.8, duration: 100, ease: 'outQuad' }, { to: height(k), duration: 100, ease: 'inQuad' }] }, at);
        }
      },
    };
  }

  // ── Colour tweens: anime animates `t`; the material colour follows. ─────────
  function addColor(tl: Timeline, target: Mesh, from: Color, to: Color, duration: number, at: number) {
    const material = target.material as MeshLambertMaterial;
    const proxy = { t: 0 };
    tl.add(
      proxy,
      { t: [0, 1], duration, ease: 'outQuad', onUpdate: () => material.color.lerpColors(from, to, proxy.t) },
      at,
    );
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  let progress = 0;
  let aspect = 1;
  const lookTarget = new Vector3();
  const tmpA = new Vector3();
  const tmpB = new Vector3();

  const cameraDistance = () => {
    const vHalf = Math.tan(((FOV / 2) * Math.PI) / 180);
    return Math.max(CAMERA_DISTANCE, FRAME_WIDTH / 2 / (vHalf * aspect));
  };

  function placeCamera() {
    const f = clamp(progress, 0, STATION_COUNT - 1);
    const i = Math.min(Math.floor(f), STATION_COUNT - 2);
    const t = f - i;
    tmpA.copy(stationOrigin(i)).add(LOOK_OFFSET);
    tmpB.copy(stationOrigin(i + 1)).add(LOOK_OFFSET);
    lookTarget.lerpVectors(tmpA, tmpB, t);
    // A gentle lift mid-flight, like cresting the stairs between landings.
    const lift = Math.sin(Math.PI * t) * 1.6;
    camera.position.copy(CAMERA_DIR).multiplyScalar(cameraDistance()).add(lookTarget);
    camera.position.y += lift;
    camera.lookAt(lookTarget.x, lookTarget.y + lift * 0.4, lookTarget.z);
  }

  // ── Rendering on demand ─────────────────────────────────────────────────────
  let frame = 0;
  let disposed = false;
  let firstFrame = false;
  const render = () => {
    frame = 0;
    if (disposed) return;
    placeCamera();
    renderer.render(scene, camera);
    if (!firstFrame) {
      firstFrame = true;
      options.onFirstFrame();
    }
  };
  const invalidate = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
  };

  const timelines = new Map<number, Timeline>();

  const handleLost = (event: Event) => {
    event.preventDefault();
    options.onContextLost();
  };
  canvas.addEventListener('webglcontextlost', handleLost);

  return {
    setProgress(next) {
      progress = next;
      invalidate();
    },
    enterStation(index, delayMs = 0) {
      const station = stations[index];
      if (!station || disposed) return;
      timelines.get(index)?.pause();
      station.reset();
      const tl = createTimeline({ autoplay: false, delay: delayMs, onUpdate: invalidate, onComplete: invalidate });
      station.play(tl);
      timelines.set(index, tl);
      tl.play();
      invalidate();
    },
    resize(width, height) {
      if (width < 2 || height < 2) return;
      aspect = width / height;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      const distance = cameraDistance();
      fog.near = distance + 5;
      fog.far = distance + 30;
      renderer.setSize(width, height, false);
      invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      timelines.forEach((tl) => tl.pause());
      timelines.clear();
      canvas.removeEventListener('webglcontextlost', handleLost);
      disposeTree(scene);
      releaseRenderer(renderer);
    },
  };
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/** A simple footprint (sole + heel), lying flat and pointing along +x. */
function footprintGeometry(): BufferGeometry {
  const sole = new Shape();
  sole.absellipse(0.28, 0, 0.44, 0.3, 0, Math.PI * 2, false, 0);
  const heel = new Shape();
  heel.absellipse(-0.38, 0, 0.26, 0.22, 0, Math.PI * 2, false, 0);
  const g = new ExtrudeGeometry([sole, heel], { depth: 0.08, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Shield outline (rounded top, pointed base), facing +z. */
function shieldGeometry(): BufferGeometry {
  const s = new Shape();
  s.moveTo(0, 1.1);
  s.bezierCurveTo(0.45, 0.95, 0.75, 0.9, 0.95, 0.9);
  s.lineTo(0.95, 0.05);
  s.bezierCurveTo(0.95, -0.55, 0.45, -0.95, 0, -1.15);
  s.bezierCurveTo(-0.45, -0.95, -0.95, -0.55, -0.95, 0.05);
  s.lineTo(-0.95, 0.9);
  s.bezierCurveTo(-0.75, 0.9, -0.45, 0.95, 0, 1.1);
  const g = new ExtrudeGeometry(s, {
    depth: 0.3,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 2,
    curveSegments: 8,
  });
  return g;
}

/** Check mark as a thick polyline outline. */
function checkGeometry(): BufferGeometry {
  const w = 0.13;
  const s = new Shape();
  s.moveTo(-0.45, 0.02);
  s.lineTo(-0.12, -0.31);
  s.lineTo(0.47, 0.28);
  s.lineTo(0.47 - w * 1.2, 0.28 + w * 1.2);
  s.lineTo(-0.12, -0.31 + w * 1.7);
  s.lineTo(-0.45 + w * 1.2, 0.02 + w * 1.2);
  s.closePath();
  return new ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: false });
}

/** Triangular pennant for the milestone flag. */
function pennantGeometry(): BufferGeometry {
  const s = new Shape();
  s.moveTo(0, 0.75);
  s.lineTo(1.05, 0.4);
  s.lineTo(0, 0.02);
  s.closePath();
  return new ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false }).translate(0, -0.4, -0.025);
}

