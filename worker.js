// worker.js — FMM travel-time computation (runs off the main thread)

// ── Gaussian blur (separable) ─────────────────────────────────────────────────
function gaussianBlur(data, w, h, sigma) {
  if (sigma <= 0) return new Float32Array(data);
  const r    = Math.ceil(sigma * 3);
  const size = 2 * r + 1;
  const ker  = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - r;
    ker[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += ker[i];
  }
  for (let i = 0; i < size; i++) ker[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < size; k++)
        v += data[y * w + Math.min(w - 1, Math.max(0, x + k - r))] * ker[k];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < size; k++)
        v += tmp[Math.min(h - 1, Math.max(0, y + k - r)) * w + x] * ker[k];
      out[y * w + x] = v;
    }
  }
  return out;
}

// ── Min-heap ──────────────────────────────────────────────────────────────────
class MinHeap {
  constructor() { this._a = []; }
  get size()     { return this._a.length; }

  push(val, idx) {
    this._a.push([val, idx]);
    this._up(this._a.length - 1);
  }
  pop() {
    const top  = this._a[0];
    const last = this._a.pop();
    if (this._a.length > 0) { this._a[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    const a = this._a;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  _down(i) {
    const a = this._a, n = a.length;
    for (;;) {
      let s = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && a[l][0] < a[s][0]) s = l;
      if (r < n && a[r][0] < a[s][0]) s = r;
      if (s === i) break;
      [a[s], a[i]] = [a[i], a[s]];
      i = s;
    }
  }
}

// ── Fast Marching Method ──────────────────────────────────────────────────────
// Solves the Eikonal equation |∇T|·F = 1 from a single seed pixel.
// speed[i] = F at pixel i (brightness + offset).
// Returns Float32Array T of travel times (same layout as speed: row-major).
function fmmTravelTime(speed, w, h, seedX, seedY) {
  const N      = w * h;
  const T      = new Float32Array(N).fill(Infinity);
  const frozen = new Uint8Array(N);   // 1 = finalized
  const heap   = new MinHeap();

  const si = Math.min(h - 1, Math.max(0, Math.round(seedY * (h - 1))));
  const sj = Math.min(w - 1, Math.max(0, Math.round(seedX * (w - 1))));
  T[si * w + sj] = 0;
  heap.push(0, si * w + sj);

  while (heap.size > 0) {
    const [, idx] = heap.pop();
    if (frozen[idx]) continue;
    frozen[idx] = 1;

    const iy = (idx / w) | 0;
    const ix = idx % w;

    for (let d = 0; d < 4; d++) {
      const ny = iy + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const nx = ix + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nidx = ny * w + nx;
      if (frozen[nidx]) continue;

      const F = speed[nidx];
      if (F <= 0) continue;

      // Eikonal update: pick min frozen neighbor along each axis
      let Tx = Infinity, Ty = Infinity;
      if (nx > 0   && frozen[nidx - 1]) Tx = Math.min(Tx, T[nidx - 1]);
      if (nx < w-1 && frozen[nidx + 1]) Tx = Math.min(Tx, T[nidx + 1]);
      if (ny > 0   && frozen[nidx - w]) Ty = Math.min(Ty, T[nidx - w]);
      if (ny < h-1 && frozen[nidx + w]) Ty = Math.min(Ty, T[nidx + w]);

      let newT;
      const invF2 = 1.0 / (F * F);
      if (!isFinite(Tx) && !isFinite(Ty)) {
        newT = 1.0 / F;
      } else if (!isFinite(Tx)) {
        newT = Ty + 1.0 / F;
      } else if (!isFinite(Ty)) {
        newT = Tx + 1.0 / F;
      } else {
        const disc = 2.0 * invF2 - (Tx - Ty) ** 2;
        newT = disc >= 0
          ? 0.5 * (Tx + Ty) + 0.5 * Math.sqrt(disc)
          : Math.min(Tx, Ty) + 1.0 / F;
      }

      if (newT < T[nidx]) {
        T[nidx] = newT;
        heap.push(newT, nidx);
      }
    }
  }

  return T;
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = function ({ data }) {
  const { gray, w, h, blur, gamma, seedX, seedY, speedOffset } = data;

  self.postMessage({ type: 'status', msg: 'Applying blur & gamma…' });

  let img = gaussianBlur(gray, w, h, blur);
  for (let i = 0; i < img.length; i++) {
    img[i] = Math.pow(Math.max(0, img[i]), gamma);
  }

  const speed = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) {
    speed[i] = img[i] + speedOffset;
  }

  self.postMessage({ type: 'status', msg: 'Computing travel time (FMM)…' });

  const tMap = fmmTravelTime(speed, w, h, seedX, seedY);

  // Transfer the buffer so the main thread gets it zero-copy
  self.postMessage({ type: 'done', tMap, w, h }, [tMap.buffer]);
};
