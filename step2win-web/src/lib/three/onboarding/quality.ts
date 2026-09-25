/**
 * Quality tiers for the onboarding world. Chosen once from the GPU string, core count, memory
 * and screen density, then lowered automatically if frames stay slow.
 */

export type Tier = 'high' | 'medium' | 'low';

export interface TierSettings {
  tier: Tier;
  /** Device pixel ratio cap. */
  maxDpr: number;
  /** Real-time shadow map size, or 0 for blob/contact shadows only. */
  shadowMapSize: number;
  /** Bloom + multisampled post chain. */
  post: boolean;
  /** Native MSAA on the default framebuffer (ignored when `post` renders through a composer). */
  antialias: boolean;
  /** Frame rate while only idle loops are playing. */
  idleFps: number;
  /** Terrain grid resolution (segments per side). */
  terrainSegments: number;
  /** Two-bone leg IK on stairs. */
  footIk: boolean;
  /** Scattered trees / props multiplier. */
  density: number;
}

const SETTINGS: Record<Tier, TierSettings> = {
  high: { tier: 'high', maxDpr: 2, shadowMapSize: 2048, post: true, antialias: true, idleFps: 60, terrainSegments: 180, footIk: true, density: 1 },
  medium: { tier: 'medium', maxDpr: 1.5, shadowMapSize: 1024, post: false, antialias: true, idleFps: 30, terrainSegments: 128, footIk: true, density: 0.8 },
  low: { tier: 'low', maxDpr: 1, shadowMapSize: 0, post: false, antialias: true, idleFps: 30, terrainSegments: 80, footIk: false, density: 0.55 },
};

export const tierSettings = (tier: Tier): TierSettings => SETTINGS[tier];

export const lowerTier = (tier: Tier): Tier | null => (tier === 'high' ? 'medium' : tier === 'medium' ? 'low' : null);

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

const OVERRIDE_KEY = 'onboarding3d_tier';

/** QA override: localStorage `onboarding3d_tier` = high | medium | low (also pins the tier). */
export function tierOverride(): Tier | null {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY);
    return v === 'high' || v === 'medium' || v === 'low' ? v : null;
  } catch {
    return null;
  }
}

function gpuString(gl: WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(value || '');
  } catch {
    return '';
  }
}

/** Picks a tier using the context the renderer already created (no extra probe canvas). */
export function detectTier(gl: WebGL2RenderingContext): Tier {
  const forced = tierOverride();
  if (forced) return forced;
  const nav = navigator as NavigatorWithMemory;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory;
  const gpu = gpuString(gl);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || ('ontouchstart' in window && window.innerWidth < 900);

  if (/SwiftShader|llvmpipe|Software|Microsoft Basic/i.test(gpu)) return 'low';
  if (/Mali-(4|T)|Mali-G(31|51|52|57)|Adreno \(TM\) ([2-4]\d\d|50\d|51\d|52\d)|PowerVR|Vivante|VideoCore/i.test(gpu)) return 'low';
  if (cores <= 4 || (typeof memory === 'number' && memory <= 3)) return 'low';

  if (mobile) {
    const strongGpu = /Adreno \(TM\) (6[4-9]\d|7\d\d|8\d\d)|Mali-G(7[1-9]|6[1-9]|7\d\d|9\d\d)|Immortalis|Xclipse|Apple/i.test(gpu);
    const plentyMemory = typeof memory !== 'number' || memory >= 6;
    return strongGpu && cores >= 8 && plentyMemory ? 'high' : 'medium';
  }
  // Desktop / laptop browsers.
  if (cores <= 4 || /Intel\(R\) (HD|UHD) Graphics [2-6]\d\d\b/i.test(gpu)) return 'medium';
  return 'high';
}

/**
 * Watches frame intervals while the scene is animating. If the smoothed frame time stays above
 * the budget for long enough, `onSlow` fires (once per call to `reset`).
 */
export class FrameGovernor {
  private ema = 16.7;
  private slowFor = 0;
  private samples = 0;
  private fired = false;

  constructor(
    private readonly budgetMs = 22,
    private readonly sustainMs = 1600,
  ) {}

  /** `intervalMs` = time since the previous rendered frame while rendering continuously. */
  sample(intervalMs: number, onSlow: () => void) {
    if (this.fired || intervalMs <= 0 || intervalMs > 250) return;
    this.samples += 1;
    this.ema += (intervalMs - this.ema) * 0.08;
    // Ignore the first frames: shader compilation and texture uploads are not representative.
    if (this.samples < 45) return;
    if (this.ema > this.budgetMs) {
      this.slowFor += intervalMs;
      if (this.slowFor > this.sustainMs) {
        this.fired = true;
        onSlow();
      }
    } else {
      this.slowFor = Math.max(0, this.slowFor - intervalMs * 0.5);
    }
  }

  get average() {
    return this.ema;
  }

  reset() {
    this.fired = false;
    this.slowFor = 0;
    this.samples = 0;
    this.ema = 16.7;
  }
}
