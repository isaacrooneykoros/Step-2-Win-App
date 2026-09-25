import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping } from 'three';
import { rand } from './path';

/**
 * Small procedural detail maps (no downloads): tileable value noise, multiplied over vertex
 * colours so the ground and the stone read as surfaces instead of flat fills.
 */

function tileNoise(size: number, period: number, seed: number) {
  const r = rand(seed);
  const grid = Array.from({ length: period * period }, () => r());
  const at = (x: number, y: number) => grid[((y % period) + period) % period * period + (((x % period) + period) % period)];
  return (u: number, v: number) => {
    const x = (u / size) * period;
    const y = (v / size) * period;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function toTexture(size: number, fill: (x: number, y: number) => number) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fill(x, y) * 255)));
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

/** Savanna ground: clumpy grass/soil variation around 0.85. */
export function groundDetail() {
  const size = 128;
  const n1 = tileNoise(size, 4, 3);
  const n2 = tileNoise(size, 16, 5);
  const n3 = tileNoise(size, 64, 9);
  return toTexture(size, (x, y) => 0.62 + n1(x, y) * 0.18 + n2(x, y) * 0.16 + n3(x, y) * 0.14);
}

/** Stone slab: soft mottling, fine grit and darker worn edges (each face maps the full tile). */
export function stoneDetail() {
  const size = 128;
  const n1 = tileNoise(size, 3, 13);
  const n2 = tileNoise(size, 12, 17);
  const n3 = tileNoise(size, 48, 19);
  return toTexture(size, (x, y) => {
    const u = x / (size - 1);
    const v = y / (size - 1);
    const edge = Math.min(u, v, 1 - u, 1 - v);
    const bevel = 0.82 + 0.18 * Math.min(1, edge / 0.06);
    return (0.8 + n1(x, y) * 0.1 + n2(x, y) * 0.07 + n3(x, y) * 0.06) * bevel;
  });
}
