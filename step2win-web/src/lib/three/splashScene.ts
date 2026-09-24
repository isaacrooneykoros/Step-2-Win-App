import {
  AmbientLight,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from 'three';
import { createRenderer, disposeTree, releaseRenderer, roundedRectShape, tokenColor } from './webgl';

/**
 * The Step2Win mark as a small 3D object: the brand tile, the stair stroke as six extrudable
 * segments and the reward dot as a ball. Geometry is laid out in the BrandMark's own 40x40
 * units (SVG y flipped), so the straight-on view lines up with the flat SVG logo.
 */

/** The canvas is this many times the logo size, so tilting never clips. */
export const SPLASH_CANVAS_SCALE = 2.5;

const STROKE = 3.4;
const TILE_DEPTH = 5;
const TILE_BEVEL = 0.6;
/** Stroke extrusion at rest (flat logo). splashMotion.ts animates it up (8.5) and back to this. */
const GLYPH_REST = 1.2;
const BALL_R = 2.6;

type Segment = { cx: number; cy: number; horizontal: boolean; step: number };

// BrandMark path "M11 29h6.5v-6.5H24V16h6.5V9.5" in centred, y-up units (x - 20, 20 - y).
const SEGMENTS: Segment[] = [
  { cx: -5.75, cy: -9, horizontal: true, step: 0 },
  { cx: -2.5, cy: -5.75, horizontal: false, step: 0 },
  { cx: 0.75, cy: -2.5, horizontal: true, step: 1 },
  { cx: 4, cy: 0.75, horizontal: false, step: 1 },
  { cx: 7.25, cy: 4, horizontal: true, step: 2 },
  { cx: 10.5, cy: 7.25, horizontal: false, step: 2 },
];
const SEGMENT_LEN = 6.5;

const BALL_HOME: [number, number] = [10.5, 10.5];

/** Animated values; anime.js tweens these and `render()` applies them. */
export interface SplashState {
  tiltX: number;
  tiltY: number;
  /** Camera distance factor (1 = the flat-logo framing). */
  dolly: number;
  /** Extrusion depth of each of the three steps. */
  step0: number;
  step1: number;
  step2: number;
  ballX: number;
  ballY: number;
  /** Ball depth as a fraction of the stairs' depth (0.5 = centred on the tread). */
  ballDepth: number;
  /** Vertical squash on landing (1 = round). */
  ballSquash: number;
}

export interface SplashRig {
  state: SplashState;
  render: () => void;
  dispose: () => void;
}

export function createSplashScene(
  canvas: HTMLCanvasElement,
  options: { logoPx: number; tokenScope: Element; onContextLost: () => void },
): SplashRig {
  const { logoPx, tokenScope, onContextLost } = options;
  // Tiny canvas and crisp logo edges: MSAA is worth it here (and is cheap on mobile GPUs).
  const renderer = createRenderer(canvas, { antialias: true });
  const cssSize = Math.round(logoPx * SPLASH_CANVAS_SCALE);
  renderer.setSize(cssSize, cssSize, false);

  const scene = new Scene();
  const fov = 16;
  const viewUnits = 40 * SPLASH_CANVAS_SCALE;
  const baseDistance = viewUnits / 2 / Math.tan((fov * Math.PI) / 360);
  const camera = new PerspectiveCamera(fov, 1, baseDistance * 0.5, baseDistance * 1.5);
  camera.position.set(0, 0, baseDistance);
  camera.lookAt(0, 0, 0);

  // Lighting calibrated so a face pointing straight at the camera renders at exactly its
  // token colour (ambient + key * cos = 1): the flat pose is indistinguishable from the SVG.
  const keyDir = { x: 0, y: 0.35, z: 1 };
  const keyCos = keyDir.z / Math.hypot(keyDir.x, keyDir.y, keyDir.z);
  const keyShare = 0.5;
  const ambient = new AmbientLight(0xffffff, (1 - keyShare * keyCos) * Math.PI);
  const key = new DirectionalLight(0xffffff, keyShare * Math.PI);
  key.position.set(keyDir.x, keyDir.y, keyDir.z);
  scene.add(ambient, key);

  const brand = new MeshLambertMaterial({ color: tokenColor('brand', '#14855D', tokenScope) });
  const glyph = new MeshLambertMaterial({ color: tokenColor('brand-fg', '#FFFFFF', tokenScope) });
  const reward = new MeshLambertMaterial({ color: tokenColor('reward', '#F5A30A', tokenScope) });

  // Pitch back first, then turn around the vertical axis: reads like a camera orbiting the mark.
  const pivot = new Group();
  pivot.rotation.order = 'YXZ';
  scene.add(pivot);

  // Tile: rounded square, front face at z = 0 so the flat pose has no perspective offset.
  const tileGeometry = new ExtrudeGeometry(roundedRectShape(40 - TILE_BEVEL * 2, 40 - TILE_BEVEL * 2, 11 - TILE_BEVEL), {
    depth: TILE_DEPTH,
    bevelEnabled: true,
    bevelThickness: TILE_BEVEL,
    bevelSize: TILE_BEVEL,
    bevelSegments: 2,
    curveSegments: 8,
  });
  tileGeometry.translate(0, 0, -(TILE_DEPTH + TILE_BEVEL));
  pivot.add(new Mesh(tileGeometry, brand));

  // Stroke segments: stadium profiles extruded 1 unit, scaled in z to stand up.
  const horizontalGeometry = new ExtrudeGeometry(roundedRectShape(SEGMENT_LEN + STROKE, STROKE, STROKE / 2), {
    depth: 1,
    bevelEnabled: false,
    curveSegments: 6,
  });
  const verticalGeometry = new ExtrudeGeometry(roundedRectShape(STROKE, SEGMENT_LEN + STROKE, STROKE / 2), {
    depth: 1,
    bevelEnabled: false,
    curveSegments: 6,
  });
  const segmentMeshes = SEGMENTS.map((segment) => {
    const mesh = new Mesh(segment.horizontal ? horizontalGeometry : verticalGeometry, glyph);
    mesh.position.set(segment.cx, segment.cy, 0);
    pivot.add(mesh);
    return mesh;
  });

  const ball = new Mesh(new SphereGeometry(BALL_R, 24, 16), reward);
  pivot.add(ball);

  const state: SplashState = {
    tiltX: 0,
    tiltY: 0,
    dolly: 1,
    step0: GLYPH_REST,
    step1: GLYPH_REST,
    step2: GLYPH_REST,
    ballX: BALL_HOME[0],
    ballY: BALL_HOME[1],
    ballDepth: 1,
    ballSquash: 1,
  };

  const handleLost = (event: Event) => {
    event.preventDefault();
    onContextLost();
  };
  canvas.addEventListener('webglcontextlost', handleLost);

  const render = () => {
    const depths = [state.step0, state.step1, state.step2];
    segmentMeshes.forEach((mesh, i) => {
      mesh.scale.z = Math.max(0.01, depths[SEGMENTS[i].step]);
    });
    pivot.rotation.set(state.tiltX, state.tiltY, 0);
    camera.position.z = baseDistance * state.dolly;

    // The ball rides on the step it is over; its depth follows that step's extrusion.
    const over = state.ballX < -2.5 ? 0 : state.ballX < 4 ? 1 : 2;
    const depth = depths[over];
    ball.position.set(state.ballX, state.ballY, depth * state.ballDepth + (1 - state.ballDepth) * 0.5);
    ball.scale.set(1 / Math.sqrt(state.ballSquash), state.ballSquash, 1 / Math.sqrt(state.ballSquash));
    renderer.render(scene, camera);
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', handleLost);
    disposeTree(scene);
    releaseRenderer(renderer);
  };

  return { state, render, dispose };
}
