import { PixelBuffer, clonePixels } from '../pixel-buffer';

/** Patch radius — patches are (2·HALF+1)² px. */
const HALF = 2;
/** EM rounds: match sources, rebuild colors, repeat. */
const EM_PASSES = 3;
/** NNF sweeps per EM round (alternating scan direction). */
const SWEEPS = 4;

/**
 * Content-aware spot heal via PatchMatch inpainting — the approach behind
 * Photoshop's content-aware fill. Every masked pixel finds its OWN best
 * source patch nearby (random init → propagation → random search), so edges
 * and distinct textures each continue from the right material instead of one
 * patch being pasted over everything. Colors start from a diffusion fill and
 * are refined over a few EM rounds; the final round blends overlapping patch
 * votes to avoid seams. Pure TS — runs in the worker.
 * mask = 1 byte/pixel, 255 where healing applies.
 */
export function heal(buf: PixelBuffer, mask: Uint8Array): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const masked: number[] = [];
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      masked.push(y * w + x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (masked.length === 0) return clonePixels(buf);

  const out = clonePixels(buf);
  diffuse(out, masked); // smooth color estimate to seed the matching

  // Search window around the mask, kept clear of the image border so every
  // valid source center has a full patch inside the image.
  const mw = maxX - minX + 1;
  const mh = maxY - minY + 1;
  const R = Math.min(Math.max(32, 2 * Math.max(mw, mh)), Math.max(w, h));
  const rx0 = Math.max(HALF, minX - R);
  const ry0 = Math.max(HALF, minY - R);
  const rx1 = Math.min(w - 1 - HALF, maxX + R);
  const ry1 = Math.min(h - 1 - HALF, maxY + R);
  if (rx1 < rx0 || ry1 < ry0) return out;
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;

  // Valid source centers = patch window fully unmasked, via a summed-area
  // table of the mask over the (window + patch margin) grid.
  const gx0 = rx0 - HALF;
  const gy0 = ry0 - HALF;
  const gw = rw + 2 * HALF;
  const gh = rh + 2 * HALF;
  const sw = gw + 1;
  const sat = new Uint32Array(sw * (gh + 1));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const m = mask[(gy0 + y) * w + gx0 + x] ? 1 : 0;
      sat[(y + 1) * sw + x + 1] = m + sat[y * sw + x + 1] + sat[(y + 1) * sw + x] - sat[y * sw + x];
    }
  }
  const P = 2 * HALF + 1;
  const valid = new Uint8Array(rw * rh);
  const validList: number[] = [];
  for (let cy = ry0; cy <= ry1; cy++) {
    for (let cx = rx0; cx <= rx1; cx++) {
      const lx = cx - HALF - gx0;
      const ly = cy - HALF - gy0;
      const sum =
        sat[(ly + P) * sw + lx + P] - sat[ly * sw + lx + P] - sat[(ly + P) * sw + lx] + sat[ly * sw + lx];
      if (sum === 0) {
        valid[(cy - ry0) * rw + (cx - rx0)] = 1;
        validList.push(cy * w + cx);
      }
    }
  }
  if (validList.length === 0) return out; // mask ate everything — keep diffusion

  // Masked-pixel slot lookup within the mask bbox (for propagation + voting).
  const slotMap = new Int32Array(mw * mh).fill(-1);
  for (let i = 0; i < masked.length; i++) {
    const p = masked[i];
    slotMap[(((p / w) | 0) - minY) * mw + (p % w) - minX] = i;
  }
  const slotAt = (x: number, y: number): number => {
    if (x < minX || x > maxX || y < minY || y > maxY) return -1;
    return slotMap[(y - minY) * mw + (x - minX)];
  };

  // Deterministic LCG so results (and tests) are reproducible.
  let seed = 123456789;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };

  const isValid = (s: number): boolean => {
    const sx = s % w;
    const sy = (s / w) | 0;
    return sx >= rx0 && sx <= rx1 && sy >= ry0 && sy <= ry1 && valid[(sy - ry0) * rw + (sx - rx0)] === 1;
  };

  /** SSD between the patch around target p (current estimate) and source s. */
  const dist = (p: number, s: number, cutoff: number): number => {
    const px = p % w;
    const py = (p / w) | 0;
    const d = out.data;
    let sum = 0;
    for (let dy = -HALF; dy <= HALF; dy++) {
      const ty = py + dy;
      if (ty < 0 || ty >= h) continue;
      for (let dx = -HALF; dx <= HALF; dx++) {
        const tx = px + dx;
        if (tx < 0 || tx >= w) continue;
        const ti = (ty * w + tx) * 4;
        const si = (s + dy * w + dx) * 4;
        const dr = d[ti] - src[si];
        const dg = d[ti + 1] - src[si + 1];
        const db = d[ti + 2] - src[si + 2];
        sum += dr * dr + dg * dg + db * db;
      }
      if (sum > cutoff) return sum;
    }
    return sum;
  };

  const nnf = new Int32Array(masked.length);
  const bestD = new Float64Array(masked.length);
  for (let i = 0; i < masked.length; i++) {
    nnf[i] = validList[rand() % validList.length];
  }

  for (let em = 0; em < EM_PASSES; em++) {
    for (let i = 0; i < masked.length; i++) bestD[i] = dist(masked[i], nnf[i], Infinity);

    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      const fwd = sweep % 2 === 0;
      for (let k = 0; k < masked.length; k++) {
        const i = fwd ? k : masked.length - 1 - k;
        const p = masked[i];
        const px = p % w;
        const py = (p / w) | 0;

        // Propagation: continue a good neighbor's source, shifted one pixel.
        const nbs = fwd
          ? [slotAt(px - 1, py), slotAt(px, py - 1)]
          : [slotAt(px + 1, py), slotAt(px, py + 1)];
        const shifts = fwd ? [1, w] : [-1, -w];
        for (let n = 0; n < 2; n++) {
          const j = nbs[n];
          if (j < 0) continue;
          const cand = nnf[j] + shifts[n];
          if (cand === nnf[i] || !isValid(cand)) continue;
          const dd = dist(p, cand, bestD[i]);
          if (dd < bestD[i]) {
            bestD[i] = dd;
            nnf[i] = cand;
          }
        }

        // Random search around the current best, radius halving each step.
        for (let r = R; r >= 1; r >>= 1) {
          const bx = nnf[i] % w;
          const by = (nnf[i] / w) | 0;
          const span = 2 * r + 1;
          const cx = bx + (rand() % span) - r;
          const cy = by + (rand() % span) - r;
          const cand = cy * w + cx;
          if (cx < rx0 || cx > rx1 || cy < ry0 || cy > ry1 || !isValid(cand)) continue;
          const dd = dist(p, cand, bestD[i]);
          if (dd < bestD[i]) {
            bestD[i] = dd;
            nnf[i] = cand;
          }
        }
      }
    }

    if (em < EM_PASSES - 1) {
      // Rebuild the estimate from each pixel's matched source center.
      for (let i = 0; i < masked.length; i++) {
        const di = masked[i] * 4;
        const si = nnf[i] * 4;
        out.data[di] = src[si];
        out.data[di + 1] = src[si + 1];
        out.data[di + 2] = src[si + 2];
      }
    } else {
      // Final round: blend the votes of every patch covering each pixel —
      // overlapping contributions hide seams between differing sources.
      const accR = new Float32Array(masked.length);
      const accG = new Float32Array(masked.length);
      const accB = new Float32Array(masked.length);
      const wgt = new Float32Array(masked.length);
      for (let i = 0; i < masked.length; i++) {
        const q = masked[i];
        const qx = q % w;
        const qy = (q / w) | 0;
        const s = nnf[i];
        for (let dy = -HALF; dy <= HALF; dy++) {
          for (let dx = -HALF; dx <= HALF; dx++) {
            const j = slotAt(qx + dx, qy + dy);
            if (j < 0) continue;
            const si = (s + dy * w + dx) * 4;
            accR[j] += src[si];
            accG[j] += src[si + 1];
            accB[j] += src[si + 2];
            wgt[j]++;
          }
        }
      }
      for (let i = 0; i < masked.length; i++) {
        if (!wgt[i]) continue;
        const di = masked[i] * 4;
        out.data[di] = accR[i] / wgt[i];
        out.data[di + 1] = accG[i] / wgt[i];
        out.data[di + 2] = accB[i] / wgt[i];
      }
    }
  }
  return out;
}

/**
 * In-place diffusion fill: iteratively average masked pixels from their
 * neighbors. Used to seed PatchMatch and as the result of last resort.
 */
function diffuse(buf: PixelBuffer, masked: number[]): void {
  const { width: w, height: h, data: d } = buf;
  const passes = 40;
  for (let pass = 0; pass < passes; pass++) {
    // Alternate sweep direction so color diffuses evenly from all sides.
    const list = pass % 2 === 0 ? masked : [...masked].reverse();
    for (const idx of list) {
      const x = idx % w;
      const y = (idx / w) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      if (x > 0) {
        const ni = (idx - 1) * 4;
        r += d[ni];
        g += d[ni + 1];
        b += d[ni + 2];
        n++;
      }
      if (x < w - 1) {
        const ni = (idx + 1) * 4;
        r += d[ni];
        g += d[ni + 1];
        b += d[ni + 2];
        n++;
      }
      if (y > 0) {
        const ni = (idx - w) * 4;
        r += d[ni];
        g += d[ni + 1];
        b += d[ni + 2];
        n++;
      }
      if (y < h - 1) {
        const ni = (idx + w) * 4;
        r += d[ni];
        g += d[ni + 1];
        b += d[ni + 2];
        n++;
      }
      if (n) {
        const di = idx * 4;
        d[di] = r / n;
        d[di + 1] = g / n;
        d[di + 2] = b / n;
      }
    }
  }
}
