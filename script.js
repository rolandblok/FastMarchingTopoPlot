// script.js — FMM Topo web UI

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  origImg:    null,   // HTMLImageElement
  fullW: 0,   fullH: 0,
  gray:       null,   // Float32Array [0,1], working (scaled) grayscale
  alpha:      null,   // Float32Array [0,1] or null
  imgW: 0,    imgH: 0,
  procCanvas: null,   // <canvas> with blur+gamma preview image
  paths:      [],     // [[x,y],...] arrays (image-space) for redraw + SVG
  worker:     null,
  running:    false,
  // letterbox offsets into the display canvas
  dx: 0, dy: 0, dw: 1, dh: 1,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas');
const ctx       = canvas.getContext('2d');
const $status   = document.getElementById('status');
const $progress = document.getElementById('progress');

// ── slider factory ────────────────────────────────────────────────────────────
function slider(id, dec, onChange) {
  const el  = document.getElementById(id);
  const lbl = document.getElementById(id + '-val');
  const fmt = v => (+v).toFixed(dec);
  lbl.textContent = fmt(el.value);
  el.addEventListener('input', () => { lbl.textContent = fmt(el.value); onChange && onChange(); });
  return () => +el.value;
}

const getBlur     = slider('blur',         1, () => updatePreview());
const getGamma    = slider('gamma',        2, () => updatePreview());
const getScale    = slider('scale',        0, () => { applyScale(); updatePreview(); });
const getNumLines = slider('numlines',     0);
const getSeedX    = slider('seed-x',      2);
const getSeedY    = slider('seed-y',      2);
const getSpeed    = slider('speed-offset',2);
const getStroke   = slider('stroke',      2, redraw);

// ── image loading ─────────────────────────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('Loading…');
  const img = new Image();
  img.onload = () => {
    S.origImg = img;
    S.fullW   = img.width;
    S.fullH   = img.height;
    S.paths   = [];
    document.getElementById('save-btn').disabled   = true;
    document.getElementById('save-gcode').disabled = true;
    document.getElementById('show-img').checked    = true;
    applyScale();
    updatePreview();
    document.getElementById('start-btn').disabled = false;
    setStatus('Loaded. Press ▶ Start to compute.');
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => setStatus('Could not load image.');
  img.crossOrigin = 'anonymous';
  img.src = URL.createObjectURL(file);
});

// Extract grayscale + alpha float arrays at the given size via an offscreen canvas
function extractPixels(img, w, h) {
  const oc  = document.createElement('canvas');
  oc.width  = w;
  oc.height = h;
  oc.getContext('2d').drawImage(img, 0, 0, w, h);
  const d     = oc.getContext('2d').getImageData(0, 0, w, h).data;
  const N     = w * h;
  const gray  = new Float32Array(N);
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = d[i*4]   / 255, g = d[i*4+1] / 255;
    const b = d[i*4+2] / 255, a = d[i*4+3] / 255;
    gray[i]  = (0.299*r + 0.587*g + 0.114*b) * a + (1 - a); // transparent → white
    alpha[i] = a;
  }
  return { gray, alpha };
}

function applyScale() {
  if (!S.origImg) return;
  const pct = getScale() / 100;
  const w   = Math.max(1, Math.round(S.fullW * pct));
  const h   = Math.max(1, Math.round(S.fullH * pct));
  const { gray, alpha } = extractPixels(S.origImg, w, h);
  S.gray  = gray;
  S.alpha = alpha;
  S.imgW  = w;
  S.imgH  = h;
  document.getElementById('img-size').textContent =
    (w === S.fullW)
      ? `${w} × ${h} px`
      : `${S.fullW} × ${S.fullH}  →  ${w} × ${h} px`;
}

// ── preview (blur + gamma applied in main thread for display) ─────────────────
function gaussianBlur(data, w, h, sigma) {
  if (sigma <= 0) return new Float32Array(data);
  const r    = Math.ceil(sigma * 3);
  const size = 2 * r + 1;
  const ker  = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) { const x = i-r; ker[i] = Math.exp(-x*x/(2*sigma*sigma)); sum += ker[i]; }
  for (let i = 0; i < size; i++) ker[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let k = 0; k < size; k++) v += data[y*w + Math.min(w-1, Math.max(0, x+k-r))] * ker[k];
    tmp[y*w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let k = 0; k < size; k++) v += tmp[Math.min(h-1, Math.max(0, y+k-r))*w + x] * ker[k];
    out[y*w + x] = v;
  }
  return out;
}

function updatePreview() {
  if (!S.gray) return;
  const blur  = getBlur();
  const gamma = getGamma();
  const w = S.imgW, h = S.imgH;

  const proc  = gaussianBlur(S.gray, w, h, blur);
  const idata = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(Math.min(1, Math.max(0, Math.pow(proc[i], gamma))) * 255);
    idata.data[i*4] = idata.data[i*4+1] = idata.data[i*4+2] = v;
    idata.data[i*4+3] = 255;
  }
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  oc.getContext('2d').putImageData(idata, 0, 0);
  S.procCanvas = oc;

  S.paths = [];   // preview change invalidates old contours
  document.getElementById('save-btn').disabled   = true;
  document.getElementById('save-gcode').disabled = true;
  redraw();
}

// ── canvas drawing ────────────────────────────────────────────────────────────
function computeLetterbox() {
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / S.imgW, ch / S.imgH);
  const dw    = Math.round(S.imgW * scale);
  const dh    = Math.round(S.imgH * scale);
  S.dx = Math.round((cw - dw) / 2);
  S.dy = Math.round((ch - dh) / 2);
  S.dw = dw; S.dh = dh;
}

function redraw() {
  if (!S.procCanvas) return;

  // Sync drawing-buffer size to CSS size
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  computeLetterbox();

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (document.getElementById('show-img').checked) {
    ctx.drawImage(S.procCanvas, S.dx, S.dy, S.dw, S.dh);
  }

  if (document.getElementById('show-topo').checked && S.paths.length > 0) {
    const sx = S.dw / S.imgW;
    const sy = S.dh / S.imgH;
    // Convert SVG stroke width (mm) to canvas pixels
    const svgScale    = Math.min(210 / S.imgW, 297 / S.imgH); // mm per image pixel
    const canvasScale = S.dw / S.imgW;                         // canvas px per image pixel
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(0.5, getStroke() * canvasScale / svgScale);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    for (const path of S.paths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(S.dx + path[0][0] * sx, S.dy + path[0][1] * sy);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(S.dx + path[i][0] * sx, S.dy + path[i][1] * sy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

new ResizeObserver(redraw).observe(canvas);
document.getElementById('show-img').addEventListener('change',  redraw);
document.getElementById('show-topo').addEventListener('change', redraw);

canvas.addEventListener('click', e => {
  if (!S.procCanvas || S.running) return;
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const x  = Math.max(0, Math.min(1, (cx - S.dx) / S.dw));
  const y  = Math.max(0, Math.min(1, (cy - S.dy) / S.dh));
  const sx = document.getElementById('seed-x');
  const sy = document.getElementById('seed-y');
  sx.value = x; sx.dispatchEvent(new Event('input'));
  sy.value = y; sy.dispatchEvent(new Event('input'));
});

// ── contour extraction (d3-contour, main thread) ──────────────────────────────
// d3-contour.size([w, h]) expects values[x + y*w] with x=col, y=row — same as
// our row-major layout tMap[row*w + col], so we pass tMap directly.

function clipRingToAlpha(ring, alpha, w, h) {
  const segs = [];
  let seg = [];
  for (const [x, y] of ring) {
    const xi = Math.min(w-1, Math.max(0, Math.round(x)));
    const yi = Math.min(h-1, Math.max(0, Math.round(y)));
    if (alpha[yi*w + xi] >= 0.5) {
      seg.push([x, y]);
    } else {
      if (seg.length >= 2) segs.push(seg);
      seg = [];
    }
  }
  if (seg.length >= 2) segs.push(seg);
  return segs;
}

function extractContours(tMap, w, h) {
  // Find finite range
  let tMin = Infinity, tMax = -Infinity;
  for (let i = 0; i < tMap.length; i++) {
    if (isFinite(tMap[i])) {
      if (tMap[i] < tMin) tMin = tMap[i];
      if (tMap[i] > tMax) tMax = tMap[i];
    }
  }
  if (!isFinite(tMin)) { setStatus('Error: no reachable pixels.'); finishRun(); return; }

  const n      = Math.max(2, getNumLines() | 0);
  const levels = Array.from({ length: n }, (_, i) =>
    tMin + (tMax - tMin) * (i + 1) / (n + 1)
  );

  const vals       = Array.from(tMap);
  const contourGen = d3.contours().size([w, h]);
  const skipTransp = document.getElementById('skip-transp').checked;
  const alpha      = (skipTransp && S.alpha) ? S.alpha : null;

  S.paths = [];
  let idx = 0;
  const BATCH = 5;   // levels per animation frame

  function step() {
    if (!S.running) { setStatus('Stopped.'); finishRun(); return; }

    const end = Math.min(idx + BATCH, levels.length);
    for (; idx < end; idx++) {
      const geom = contourGen.thresholds([levels[idx]])(vals);
      for (const polygon of geom[0].coordinates) {
        for (const ring of polygon) {
          if (alpha) {
            S.paths.push(...clipRingToAlpha(ring, alpha, w, h));
          } else {
            if (ring.length >= 2) S.paths.push(ring);
          }
        }
      }
    }

    $progress.value = idx / levels.length * 100;
    redraw();

    if (idx < levels.length) {
      requestAnimationFrame(step);
    } else {
      $progress.value = 100;
      const lenA4 = pathLengthMm(S.paths, w, h, 210, 297) / 1000;
      const lenA3 = pathLengthMm(S.paths, w, h, 297, 420) / 1000;
      setStatus(
        `Done!  ${S.paths.length} paths\n` +
        `A4: ${lenA4.toFixed(2)} m\n` +
        `A3: ${lenA3.toFixed(2)} m`
      );
      document.getElementById('save-btn').disabled   = false;
      document.getElementById('save-gcode').disabled = false;
      finishRun();
    }
  }

  requestAnimationFrame(step);
}

function pathLengthMm(paths, w, h, pw, ph) {
  const sx = pw / w, sy = ph / h;
  let total = 0;
  for (const p of paths) {
    for (let i = 1; i < p.length; i++) {
      const dx = (p[i][0] - p[i-1][0]) * sx;
      const dy = (p[i][1] - p[i-1][1]) * sy;
      total += Math.sqrt(dx*dx + dy*dy);
    }
  }
  return total;
}

// ── worker ────────────────────────────────────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', () => {
  if (!S.gray || S.running) return;

  S.running = true;
  S.paths   = [];
  $progress.value = 0;
  document.getElementById('start-btn').disabled = true;
  document.getElementById('stop-btn').disabled  = false;
  document.getElementById('save-btn').disabled   = true;
  document.getElementById('save-gcode').disabled = true;
  document.getElementById('show-img').checked    = false;
  redraw();

  if (S.worker) S.worker.terminate();
  S.worker = new Worker('worker.js');

  S.worker.onmessage = ({ data }) => {
    if (data.type === 'status') {
      setStatus(data.msg);
    } else if (data.type === 'done') {
      setStatus('Tracing contours…');
      extractContours(data.tMap, data.w, data.h);
    } else if (data.type === 'error') {
      setStatus('Error: ' + data.msg);
      finishRun();
    }
  };
  S.worker.onerror = e => { setStatus('Worker error: ' + e.message); finishRun(); };

  // Send a copy of gray so S.gray stays valid for preview sliders during compute
  S.worker.postMessage({
    gray:        S.gray.slice(),
    w:           S.imgW,
    h:           S.imgH,
    blur:        getBlur(),
    gamma:       getGamma(),
    seedX:       getSeedX(),
    seedY:       getSeedY(),
    speedOffset: getSpeed(),
  });
});

document.getElementById('stop-btn').addEventListener('click', () => {
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  setStatus('Stopped.');
  finishRun();
});

function finishRun() {
  S.running = false;
  document.getElementById('start-btn').disabled = !S.origImg;
  document.getElementById('stop-btn').disabled  = true;
}

// ── paper size helper ─────────────────────────────────────────────────────────
function getPaperDims() {
  const preset = document.getElementById('paper-size').value;
  let pw, ph;
  if (preset === 'a4')       { pw = 210; ph = 297; }
  else if (preset === 'a3')  { pw = 297; ph = 420; }
  else {
    pw = parseFloat(document.getElementById('paper-w').value) || 210;
    ph = parseFloat(document.getElementById('paper-h').value) || 297;
  }
  if (document.getElementById('orientation').value === 'landscape') {
    [pw, ph] = [ph, pw];
  }
  return { pw, ph };
}

document.getElementById('paper-size').addEventListener('change', () => {
  document.getElementById('custom-paper').style.display =
    document.getElementById('paper-size').value === 'custom' ? '' : 'none';
});

// ── SVG export ────────────────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', saveSVG);

function saveSVG() {
  if (!S.paths.length) return;
  const { pw, ph } = getPaperDims();
  const marginPct = (parseFloat(document.getElementById('svg-margin').value) || 0) / 100;
  const sw        = getStroke();

  const drawW = pw * (1 - 2 * marginPct);
  const drawH = ph * (1 - 2 * marginPct);
  const margin = pw * marginPct;
  const scale = Math.min(drawW / S.imgW, drawH / S.imgH);
  const dw    = S.imgW * scale;
  const dh    = S.imgH * scale;
  const ox    = margin + (drawW - dw) / 2;
  const oy    = margin + (drawH - dh) / 2;

  const rows = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}mm" height="${ph}mm" viewBox="0 0 ${pw} ${ph}">`,
    '<rect width="100%" height="100%" fill="white"/>',
  ];
  for (const path of S.paths) {
    const d = 'M ' + path.map(([x, y]) =>
      `${(ox + x * scale).toFixed(3)},${(oy + y * scale).toFixed(3)}`
    ).join(' L ');
    rows.push(`<path d="${d}" stroke="black" fill="none" stroke-width="${sw.toFixed(3)}"/>`);
  }
  rows.push('</svg>');

  const blob = new Blob([rows.join('\n')], { type: 'image/svg+xml' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: 'fmm_topo.svg',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── G-code export ─────────────────────────────────────────────────────────────
document.getElementById('save-gcode').addEventListener('click', saveGcode);

function saveGcode() {
  if (!S.paths.length) return;
  const { pw, ph } = getPaperDims();
  const marginPct = (parseFloat(document.getElementById('svg-margin').value) || 0) / 100;
  const zDown  = document.getElementById('gcode-z-down').value.trim() || 'M3 S40';
  const zUp    = document.getElementById('gcode-z-up').value.trim() || 'M3 S40';
  const fDraw  = parseFloat(document.getElementById('gcode-f-draw').value) || 3000;
  const fMove  = parseFloat(document.getElementById('gcode-f-move').value) || 3000;

  const drawW = pw * (1 - 2 * marginPct);
  const drawH = ph * (1 - 2 * marginPct);
  const margin = pw * marginPct;
  const scale = Math.min(drawW / S.imgW, drawH / S.imgH);
  const dw    = S.imgW * scale;
  const dh    = S.imgH * scale;
  const ox    = margin + (drawW - dw) / 2;
  const oy    = margin + (drawH - dh) / 2;

  const lines = [
    'G21 ; mm',
    'G90 ; absolute',
    zUp,
  ];
  for (const path of S.paths) {
    if (path.length < 2) continue;
    const [x0, y0] = path[0];
    lines.push(`G0 X${(ox + x0 * scale).toFixed(3)} Y${(oy + y0 * scale).toFixed(3)} F${fMove}`);
    lines.push(zDown);
    for (let i = 1; i < path.length; i++) {
      const [x, y] = path[i];
      lines.push(`G1 X${(ox + x * scale).toFixed(3)} Y${(oy + y * scale).toFixed(3)} F${fDraw}`);
    }
    lines.push(zUp);
  }
  lines.push(`G0 X0 Y0 F${fMove}`);
  lines.push(zUp);

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: 'fmm_topo.gcode',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── utils ─────────────────────────────────────────────────────────────────────
function setStatus(msg) { $status.textContent = msg; }

// ── auto-load default image ───────────────────────────────────────────────────
(function () {
  setStatus('Loading default image…');
  const img = new Image();
  img.onload = () => {
    S.origImg = img;
    S.fullW   = img.width;
    S.fullH   = img.height;
    S.paths   = [];
    document.getElementById('img-size').textContent = `${img.width} × ${img.height} px`;
    document.getElementById('save-btn').disabled   = true;
    document.getElementById('save-gcode').disabled = true;
    document.getElementById('show-img').checked    = true;
    applyScale();
    updatePreview();
    document.getElementById('start-btn').disabled = false;
    setStatus('Loaded. Press ▶ Start to compute.');
  };
  img.onerror = () => setStatus('Load an image to begin.');
  img.crossOrigin = 'anonymous';
  img.src = 'typewriter_nobg.png';
})();
