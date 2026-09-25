import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  BufferGeometry,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forgetParsedAssets, loadAsset, prefetchAssets } from './onboarding/assets';
import { PLAIN_Y, buildStairs, buildTerrain, StairPath } from './onboarding/path';
import { groundDetail } from './onboarding/textures';
import { PeopleLibrary, peopleRim } from './onboarding/people';
import { disposeObject, releaseSharedTextures } from './onboarding/props';
import { FrameGovernor, detectTier, lowerTier, tierOverride, tierSettings, type Tier, type TierSettings } from './onboarding/quality';
import { buildShrubs, buildSkyline, buildSky, buildStars, buildTrees } from './onboarding/scenery';
import { HabitStation, MOVE_VIEW, MoveStation, PoolStation, TogetherStation, type CameraPose, type Palette, type Station } from './onboarding/stations';
import { tokenColor, webgl2Available } from './webgl';

/**
 * The onboarding world: one continuous savanna hill outside Nairobi with a stair-path climbing
 * it, and four stations on the way — a runner at dawn (every step counts), friends walking
 * together to a milestone flag, the pool plaza where those who qualified share the coins, and
 * the seven-day staircase to the summit, from where the camera pulls back over the whole climb.
 *
 * Rigged, skeletally animated people (Quaternius CC0) with procedural athletic wear; ACES tone
 * mapping, image-based lighting from a PMREM'd RoomEnvironment, a warm key with soft shadows on
 * capable devices (blob shadows otherwise), a camera-relative rim light, exponential fog, and
 * bloom on the high tier only. Quality tiers adapt to the device and step down if frames are slow.
 */

export const STATION_COUNT = 4;

export interface OnboardingWorld {
  /** Continuous position along the stations (0…3); fractional while dragging or flying. */
  setProgress: (progress: number) => void;
  /** Restart station `index`'s story (after `delayMs`, as the camera arrives). */
  enterStation: (index: number, delayMs?: number) => void;
  /** Canvas CSS size. */
  resize: (width: number, height: number) => void;
  /** Pixels covered by UI at the top and bottom; the scene is framed in the band between. */
  setViewInsets: (top: number, bottom: number) => void;
  /** Re-read the light/dark tokens. */
  refreshTheme: () => void;
  readonly tier: Tier;
  dispose: () => void;
}

export interface OnboardingWorldOptions {
  tokenScope?: Element;
  onContextLost?: () => void;
  /** First frame with the page-1 characters on screen. */
  onFirstFrame?: () => void;
  /** Assets failed to load: the caller should keep the static fallback. */
  onError?: (error: unknown) => void;
}

/** Starts downloading the character files (call during the splash). */
export function preloadOnboardingAssets() {
  // Without WebGL2 the stills are used: never download the models.
  if (!webgl2Available()) return;
  prefetchAssets();
  // Decode too (meshopt + WebP) while the splash is up; the world picks the parsed result.
  void loadAsset('core')
    .then(() => loadAsset('extra'))
    .catch(() => null);
}

const SUN_DIR = new Vector3(-0.9, 0.44, -0.08).normalize();
const CITY_CENTER = new Vector3(-88, PLAIN_Y, 300);
const BAND_FOV = 36;
/** Arc length of each station's subject, for mid-flight framing. */
const STATION_S = [34, 70, 104, 122];

interface Look3D {
  zenith: string;
  horizon: string;
  ground: string;
  sunSky: string;
  halo: number;
  sunSize: number;
  cityGlow: string;
  fog: string;
  fogDensity: number;
  key: string;
  keyIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  env: number;
  rim: string;
  rimIntensity: number;
  exposure: number;
  windows: number;
  stars: boolean;
}

const LIGHT: Look3D = {
  zenith: '#4d8ad1',
  horizon: '#fbd8b2',
  ground: '#d3bc98',
  sunSky: '#ffd29a',
  halo: 0.55,
  sunSize: 0.99955,
  cityGlow: '#000000',
  fog: '#ecd9c2',
  fogDensity: 0.0042,
  key: '#ffdcb2',
  keyIntensity: 5.6,
  hemiSky: '#bcd3ef',
  hemiGround: '#7d6448',
  hemiIntensity: 0.5,
  env: 0.2,
  rim: '#fff0da',
  rimIntensity: 1.6,
  exposure: 0.88,
  windows: 0,
  stars: false,
};

const DARK: Look3D = {
  zenith: '#07101c',
  horizon: '#1b2a3e',
  ground: '#0b1119',
  sunSky: '#a9bfe0',
  halo: 0.18,
  sunSize: 0.99975,
  cityGlow: '#ff9446',
  fog: '#131e2c',
  fogDensity: 0.0088,
  key: '#a9c0ea',
  keyIntensity: 1.7,
  hemiSky: '#2c3f5e',
  hemiGround: '#120e0b',
  hemiIntensity: 0.42,
  env: 0.1,
  rim: '#ffb77a',
  rimIntensity: 2.1,
  exposure: 1.02,
  windows: 1.5,
  stars: true,
};

function tokenCss(name: string, el: Element, fallback: string) {
  const raw = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  // Comma syntax: understood by both canvas and three's Color.setStyle.
  return raw ? `hsl(${raw.split(/\s+/).slice(0, 3).join(', ')})` : fallback;
}

function readPalette(scope: Element): Palette {
  const page = tokenColor('bg-page', '#F6F5F2', scope);
  const hsl = { h: 0, s: 0, l: 0 };
  page.getHSL(hsl, SRGBColorSpace);
  const dark = hsl.l < 0.4;
  const brand = tokenColor('brand', '#14855D', scope);
  const reward = tokenColor('reward', '#F5A30A', scope);
  return {
    dark,
    brand,
    brandCss: tokenCss('brand', scope, '#14855D'),
    reward,
    rewardCss: tokenCss('reward', scope, '#F5A30A'),
    fgCss: tokenCss('brand-fg', scope, '#FFFFFF'),
    inkCss: tokenCss('reward-ink', scope, '#8A4B0B'),
    card: {
      card: tokenCss('bg-card', scope, '#FFFFFF'),
      text: tokenCss('text-primary', scope, '#111'),
      muted: tokenCss('text-secondary', scope, '#555'),
      brand: tokenCss('brand', scope, '#14855D'),
      border: tokenCss('border-default', scope, '#E2DFDA'),
    },
    idle: tokenColor('text-muted', '#6B7479', scope),
  };
}

/** Timeline marks (visible in the Performance panel and to QA scripts). */
const mark = (label: string) => performance.mark(`onboarding3d:${label}`);

export function createOnboardingWorld(canvas: HTMLCanvasElement, options: OnboardingWorldOptions = {}): OnboardingWorld {
  mark('create');
  if (!webgl2Available()) throw new Error('WebGL2 unavailable');
  const scope = options.tokenScope ?? document.documentElement;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  const tierState: TierSettings = { ...tierSettings(detectTier(renderer.getContext() as WebGL2RenderingContext)) };
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = tierState.shadowMapSize > 0;
  renderer.shadowMap.type = PCFShadowMap;

  let palette = readPalette(scope);
  const scene = new Scene();
  const camera = new PerspectiveCamera(BAND_FOV, 1, 0.15, 2000);
  let needsCompile = true;
  let disposed = false;

  // Image-based lighting: a procedural studio room, prefiltered once (no HDR download). The
  // prefilter shaders are heavy; they are compiled in parallel first so nothing blocks.
  mark('renderer');
  let envTarget: WebGLRenderTarget | null = null;
  let envReady = false;
  /** Materials can compile their final variants (real or placeholder environment bound). */
  let envCompilable = false;
  const envPromise = (async () => {
    if (tierState.tier === 'low') {
      // Low tier: hemisphere + key light only (the prefilter shaders are the slowest to compile).
      envReady = true;
      envCompilable = true;
      return;
    }
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const internals = pmrem as unknown as {
      _setSize?: (size: number) => void;
      _allocateTargets?: () => WebGLRenderTarget;
      _blurMaterial?: Material | null;
      _ggxMaterial?: Material | null;
    };
    let placeholder: WebGLRenderTarget | null = null;
    try {
      internals._setSize?.(128);
      // A same-sized (empty) PMREM target lets every scene material compile its final
      // environment variant now, in parallel with the prefilter shaders below.
      placeholder = internals._allocateTargets?.() ?? null;
      if (placeholder) {
        scene.environment = placeholder.texture;
        envCompilable = true;
        needsCompile = true;
      }
      const warm = new Scene();
      [internals._blurMaterial, internals._ggxMaterial].forEach((m) => m && warm.add(new Mesh(new BufferGeometry(), m)));
      const cube = new PerspectiveCamera(90, 1, 0.1, 100);
      await Promise.all([renderer.compileAsync(warm, new OrthographicCamera()), renderer.compileAsync(room, cube)]);
      warm.children.forEach((m) => (m as Mesh).geometry.dispose());
    } catch {
      // Internals changed: fall back to a plain (synchronous) prefilter below.
    }
    if (disposed) {
      pmrem.dispose();
      return;
    }
    envTarget = pmrem.fromScene(room, 0.04, 0.1, 100, { size: 128 });
    mark('pmrem');
    room.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as Material).dispose();
      }
    });
    pmrem.dispose();
    scene.environment = envTarget.texture;
    placeholder?.dispose();
    envReady = true;
    envCompilable = true;
    needsCompile = true;
  })();
  void envPromise;

  const hemi = new HemisphereLight();
  const key = new DirectionalLight();
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 2.5;
  const rim = new DirectionalLight();
  scene.add(hemi, key, key.target, rim, rim.target);

  const sky = buildSky();
  const stars = buildStars();
  scene.add(sky.mesh, stars);

  // The world.
  const path = new StairPath();
  mark('path');
  const terrain = buildTerrain(path, tierState.terrainSegments);
  mark('terrain');
  const terrainMesh = new Mesh(terrain.geometry, terrain.material);
  terrainMesh.receiveShadow = true;
  const stairs = buildStairs(path);
  mark('stairs');
  stairs.mesh.castShadow = true;
  stairs.mesh.receiveShadow = true;
  const plaza = path.plaza();
  // Keep trees out of the camera moves on pages 3 and 4.
  const trees = buildTrees(path, tierState.density, [
    { center: plaza.center, radius: plaza.radius + 4 },
    { center: path.pointAt(121.5), radius: 11 },
    { center: path.pointAt(110), radius: 12 },
    // Page 1's tracking camera runs beside the stairs.
    ...[12, 20, 28, 36, 44, 52].map((sAt) => ({ center: path.pointAt(sAt).addScaledVector(MOVE_VIEW, 7), radius: 6.5 })),
  ]);
  mark('trees');
  const shrubs = buildShrubs(path, tierState.density);
  const facing = CITY_CENTER.clone().sub(path.pointAt(10)).setY(0).normalize();
  const skyline = buildSkyline(CITY_CENTER, facing);
  mark('skyline');
  // The plain beyond the hill, out to the fogged horizon.
  const plainDetail = groundDetail();
  plainDetail.repeat.set(500, 500);
  const plain = new Mesh(new CircleGeometry(1400, 48).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: '#b09658', roughness: 1, map: plainDetail }));
  plain.position.set(0, PLAIN_Y - 0.05, 0);
  plain.receiveShadow = false;
  scene.add(terrainMesh, plain, stairs.mesh, trees.trunks, trees.canopies, shrubs, skyline.mesh);

  const lib = new PeopleLibrary();
  let firstFrameSent = false;
  const ctx = { path, lib, tier: tierState, palette, onSpawn: () => (needsCompile = true) };
  const stations: Station[] = [new MoveStation(ctx), new TogetherStation(ctx), new PoolStation(ctx), new HabitStation(ctx)];
  mark('stations');
  const habit = stations[3] as HabitStation;
  stations.forEach((s) => scene.add(s.group));

  // ---------------------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------------------

  function applyTheme() {
    palette = readPalette(scope);
    ctx.palette = palette;
    const L = palette.dark ? DARK : LIGHT;
    const u = sky.material.uniforms;
    (u.uZenith.value as Color).set(L.zenith);
    (u.uHorizon.value as Color).set(L.horizon);
    (u.uGround.value as Color).set(L.ground);
    (u.uSun.value as Color).set(L.sunSky);
    (u.uSunDir.value as Vector3).copy(SUN_DIR);
    u.uHalo.value = L.halo;
    u.uSunSize.value = L.sunSize;
    (u.uGlow.value as Color).set(L.cityGlow).multiplyScalar(0.55);
    (u.uGlowDir.value as Vector3).copy(facing);
    scene.fog = new FogExp2(new Color(L.fog), L.fogDensity);
    hemi.color.set(L.hemiSky);
    hemi.groundColor.set(L.hemiGround);
    // Low tier has no image-based light: the sky light makes up for it.
    hemi.intensity = L.hemiIntensity * (scene.environment ? 1 : 2.2);
    key.color.set(L.key);
    key.intensity = L.keyIntensity;
    // The directional rim stays subtle (it would fill in ground shadows); people get a shader rim.
    rim.color.set(L.rim);
    rim.intensity = L.rimIntensity * 0.2;
    peopleRim.value.set(L.rim).multiplyScalar(palette.dark ? 0.55 : 0.32);
    scene.environmentIntensity = L.env;
    renderer.toneMappingExposure = L.exposure;
    skyline.material.emissiveIntensity = L.windows;
    // The city is a matte-painted silhouette: unfogged, tinted towards the horizon haze.
    skyline.material.color.set(palette.dark ? '#1c2533' : '#a7b2c2');
    skyline.material.emissive.set(palette.dark ? '#ffc98a' : '#000000');
    (stars as Points).visible = L.stars;
    stations.forEach((s) => s.applyPalette(palette));
    dirty = true;
  }

  // ---------------------------------------------------------------------------------------
  // Post (high tier)
  // ---------------------------------------------------------------------------------------

  let composer: EffectComposer | null = null;
  let composerTarget: WebGLRenderTarget | null = null;
  let bloom: UnrealBloomPass | null = null;
  let outputPass: OutputPass | null = null;
  let renderPass: RenderPass | null = null;

  function setupPost() {
    teardownPost();
    if (!tierState.post) return;
    composerTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, composerTarget);
    renderPass = new RenderPass(scene, camera);
    bloom = new UnrealBloomPass(new Vector2(256, 256), 0.3, 0.55, 1.25);
    outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(outputPass);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(size.w, size.h);
  }

  function teardownPost() {
    composer?.dispose();
    composerTarget?.dispose();
    bloom?.dispose();
    outputPass?.dispose();
    renderPass?.dispose();
    composer = null;
    composerTarget = null;
    bloom = null;
    outputPass = null;
    renderPass = null;
  }

  // ---------------------------------------------------------------------------------------
  // Size and framing
  // ---------------------------------------------------------------------------------------

  const size = { w: 1, h: 1 };
  const insets = { top: 0, bottom: 0 };

  function applyPixelRatio() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tierState.maxDpr));
  }

  function updateProjection() {
    const { w, h } = size;
    const band = Math.max(80, h - insets.top - insets.bottom);
    const bandAspect = w / band;
    // Keep at least ~27° horizontally on narrow phones; the band is what the user sees.
    const bandFov = Math.max(BAND_FOV, (2 * Math.atan(Math.tan((27 * Math.PI) / 360) / bandAspect) * 180) / Math.PI);
    const tanBand = Math.tan((bandFov * Math.PI) / 360);
    camera.fov = (2 * Math.atan(tanBand * (h / band)) * 180) / Math.PI;
    camera.aspect = w / h;
    // Shift the principal point to the middle of the visible band.
    const centre = insets.top + band / 2;
    camera.setViewOffset(w, h, 0, h / 2 - centre, w, h);
    camera.updateProjectionMatrix();
  }

  function resize(width: number, height: number) {
    size.w = Math.max(1, Math.round(width));
    size.h = Math.max(1, Math.round(height));
    applyPixelRatio();
    renderer.setSize(size.w, size.h, false);
    composer?.setPixelRatio(renderer.getPixelRatio());
    composer?.setSize(size.w, size.h);
    updateProjection();
    dirty = true;
  }

  // ---------------------------------------------------------------------------------------
  // Tiers
  // ---------------------------------------------------------------------------------------

  function applyShadowSettings() {
    const on = tierState.shadowMapSize > 0;
    const changed = renderer.shadowMap.enabled !== on;
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = PCFShadowMap;
    key.castShadow = on;
    if (on) {
      key.shadow.mapSize.set(tierState.shadowMapSize, tierState.shadowMapSize);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      const c = key.shadow.camera;
      c.left = -13;
      c.right = 13;
      c.top = 13;
      c.bottom = -13;
      c.near = 1;
      c.far = 140;
      c.updateProjectionMatrix();
    }
    if (changed) {
      scene.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => (x.needsUpdate = true));
      });
    }
  }

  const governor = new FrameGovernor(22, 1600);
  const pinnedTier = tierOverride() !== null;

  function downgrade() {
    const next = lowerTier(tierState.tier);
    if (!next) return;
    Object.assign(tierState, tierSettings(next));
    applyPixelRatio();
    applyShadowSettings();
    setupPost();
    applyTheme();
    resize(size.w, size.h);
    governor.reset();
    if (import.meta.env.DEV) console.info(`[onboarding3d] downgraded to ${next}`);
  }

  // ---------------------------------------------------------------------------------------
  // Camera flights
  // ---------------------------------------------------------------------------------------

  let progress = 0;
  let lastProgress = -1;
  const poseA: CameraPose = { position: new Vector3(), target: new Vector3() };
  const poseB: CameraPose = { position: new Vector3(), target: new Vector3() };
  const camTarget = new Vector3();
  const ctrl = new Vector3();

  function computeCamera(time: number) {
    const f = Math.min(STATION_COUNT - 1, Math.max(0, progress));
    const i = Math.min(STATION_COUNT - 2, Math.floor(f));
    const u = f - i;
    stations[i].cameraPose(poseA);
    if (u < 1e-4) {
      camera.position.copy(poseA.position);
      camTarget.copy(poseA.target);
    } else if (u > 1 - 1e-4) {
      stations[i + 1].cameraPose(poseB);
      camera.position.copy(poseB.position);
      camTarget.copy(poseB.target);
    } else {
      stations[i + 1].cameraPose(poseB);
      // Quadratic Bézier through a lifted midpoint: the camera rises over the hill between stops.
      const dist = poseA.position.distanceTo(poseB.position);
      const lift = Math.min(9, Math.max(2, dist * 0.14));
      ctrl.addVectors(poseA.position, poseB.position).multiplyScalar(0.5);
      ctrl.y += lift;
      const k = 1 - u;
      camera.position
        .copy(poseA.position)
        .multiplyScalar(k * k)
        .addScaledVector(ctrl, 2 * k * u)
        .addScaledVector(poseB.position, u * u);
      // Look ahead to the destination early, and keep the horizon in view while airborne.
      const tu = 1 - Math.pow(1 - u, 2.2);
      camTarget.copy(poseA.target).lerp(poseB.target, tu);
      // Mid-flight the lens stays on the path between the two stations.
      const sMid = STATION_S[i] + (STATION_S[i + 1] - STATION_S[i]) * u;
      const onPath = path.pointAt(sMid);
      onPath.y = path.smoothHeightAt(sMid) + 1;
      camTarget.lerp(onPath, Math.sin(u * Math.PI) * 0.8);
      camTarget.y += Math.sin(u * Math.PI) * lift * 0.2;
    }
    // A breath of hand-held drift keeps held shots alive.
    camera.position.x += Math.sin(time * 0.37) * 0.035;
    camera.position.y += Math.sin(time * 0.53 + 1.3) * 0.028;
    camera.lookAt(camTarget);
  }

  function updateLights() {
    // Key follows the action so its shadow map stays sharp where we look.
    key.target.position.copy(camTarget);
    key.position.copy(camTarget).addScaledVector(SUN_DIR, 70);
    key.target.updateMatrixWorld();
    // Rim: from behind the subject, relative to the camera.
    const back = camTarget.clone().sub(camera.position).setY(0).normalize();
    rim.position.copy(camTarget).addScaledVector(back, 10).add(new Vector3(0, 6, 0));
    rim.target.position.copy(camTarget);
    rim.target.updateMatrixWorld();
  }

  // ---------------------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------------------

  function spawnAll() {
    stations.forEach((s) => s.spawn());
  }

  loadAsset('core')
    .then((assets) => {
      if (disposed) return;
      mark('core-parsed');
      lib.add(assets);
      spawnAll();
      mark('core-spawned');
      dirty = true;
      // Male body and the remaining clips stream in afterwards.
      return loadAsset('extra').then((extra) => {
        if (disposed) return;
        lib.add(extra);
        spawnAll();
        dirty = true;
      });
    })
    .catch((err) => {
      if (!disposed) options.onError?.(err);
    });

  // ---------------------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------------------

  let raf = 0;
  let lastRender = 0;
  let lastFrame = 0;
  let dirty = true;
  let clock = 0;
  let bgAccum = 0;
  let compiling = false;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const interval = lastFrame ? now - lastFrame : 16.7;
    lastFrame = now;
    const flying = progress !== lastProgress;
    const near = (i: number) => Math.abs(progress - i) < 1;
    const anyBusy = busyFlags.some((b, i) => near(i) && b);
    const busy = flying || dirty || anyBusy;
    const fps = busy ? 60 : tierState.idleFps;
    if (lastRender && now - lastRender < 1000 / fps - 2) return;
    const dt = Math.min(0.05, lastRender ? (now - lastRender) / 1000 : 1 / 60);
    lastRender = now;
    clock += dt;
    lastProgress = progress;
    dirty = false;

    // Compile once the environment exists (it changes every lit material's program).
    if (needsCompile && !compiling && envCompilable) {
      needsCompile = false;
      compiling = true;
      // Compile new shader variants off the critical path where supported.
      const done = () => {
        compiling = false;
        dirty = true;
      };
      mark('compile-start');
      renderer.compileAsync(scene, camera).then(() => { mark('compile-end'); done(); }, done);
    }

    // Nothing is shown before page 1's people exist and every shader has compiled in parallel
    // (KHR_parallel_shader_compile): no synchronous compile stalls on the first frames.
    if (!firstFrameSent && (!envReady || compiling || needsCompile || stations[0].people.length === 0)) {
      lastRender = 0;
      return;
    }

    const revealing = habit.revealing && near(3) && tierState.tier !== 'low';
    stations.forEach((s, i) => {
      const active = near(i);
      const background = !active && revealing;
      if (background && !s.background) {
        s.settle();
        s.background = true;
      }
      if (!background) s.background = false;
      s.setPeopleVisible(active || background);
      if (active) busyFlags[i] = s.update(dt);
    });
    if (revealing) {
      // Background stations tick at ~15 fps: they are small and far away.
      bgAccum += dt;
      if (bgAccum >= 1 / 15) {
        stations.forEach((s) => s.background && s.update(bgAccum));
        bgAccum = 0;
      }
    }

    computeCamera(clock);
    updateLights();
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);

    if (busy && fps === 60 && !pinnedTier) governor.sample(interval, downgrade);

    if (!firstFrameSent && !compiling && stations[0].people.length > 0) {
      firstFrameSent = true;
      mark('first-frame');
      options.onFirstFrame?.();
    }
  }
  const busyFlags = [true, true, true, true];

  function start() {
    if (raf || disposed) return;
    lastRender = 0;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onLost = (event: Event) => {
    event.preventDefault();
    stop();
    options.onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  // Theme switches while open.
  const themeObserver = new MutationObserver(() => applyTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

  applyTheme();
  applyShadowSettings();
  setupPost();
  if (!document.hidden) start();

  const world: OnboardingWorld = {
    get tier() {
      return tierState.tier;
    },
    setProgress(p: number) {
      progress = p;
    },
    enterStation(index: number, delayMs = 0) {
      stations[index]?.enter(delayMs);
      busyFlags[index] = true;
      dirty = true;
    },
    resize,
    setViewInsets(top: number, bottom: number) {
      insets.top = Math.max(0, top);
      insets.bottom = Math.max(0, bottom);
      updateProjection();
      dirty = true;
    },
    refreshTheme: applyTheme,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      themeObserver.disconnect();
      stations.forEach((s) => s.dispose());
      lib.dispose();
      forgetParsedAssets();
      teardownPost();
      disposeObject(terrainMesh);
      disposeObject(plain);
      disposeObject(stairs.mesh);
      trees.trunks.dispose();
      trees.canopies.dispose();
      disposeObject(trees.trunks);
      disposeObject(trees.canopies);
      shrubs.dispose();
      disposeObject(shrubs);
      disposeObject(skyline.mesh);
      skyline.windows.dispose();
      disposeObject(sky.mesh);
      stars.geometry.dispose();
      (stars.material as Material).dispose();
      stairs.mesh.dispose();
      key.shadow.map?.dispose();
      key.dispose();
      rim.dispose();
      envTarget?.texture.dispose();
      envTarget?.dispose();
      releaseSharedTextures();
      scene.clear();
      renderer.setAnimationLoop(null);
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };

  if (import.meta.env.DEV) {
    (window as unknown as { __onboardingWorld?: unknown }).__onboardingWorld = {
      world,
      stations,
      camera,
      renderer,
      get fps() {
        return 1000 / governor.average;
      },
      downgrade,
    };
  }

  return world;
}
