// worker.js – Op-Kette + SVG-Tracing auf ImageBitmap
// Nachrichten: { id, bitmap, ops } → { id, bitmap }
//              { id, type:'svg', bitmap, options } → { id, svgString }

self.onmessage = async (e) => {
  const { id, bitmap, ops, type, options } = e.data;
  try {
    if (type === 'svg') {
      const svgString = await bitmapToSvg(bitmap, options || {});
      bitmap.close?.();
      self.postMessage({ id, svgString });
      return;
    }
    let current = bitmap;
    for (const op of ops) current = await applyOp(current, op);
    self.postMessage({ id, bitmap: current }, [current]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

async function applyOp(bitmap, op) {
  switch (op.type) {
    case 'crop':          return crop(bitmap, op);
    case 'rotate':        return rotate(bitmap, op);
    case 'resize':        return resize(bitmap, op);
    case 'removeColor':   return removeColor(bitmap, op);
    case 'colorToAlpha':  return colorToAlpha(bitmap, op);
    default: throw new Error('Unbekannte Op: ' + op.type);
  }
}

function makeCanvas(w, h) { return new OffscreenCanvas(w, h); }

async function crop(bitmap, { x, y, w, h }) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (x + w > bitmap.width) w = bitmap.width - x;
  if (y + h > bitmap.height) h = bitmap.height - y;
  if (w <= 0 || h <= 0) throw new Error('Crop außerhalb des Bildes');
  const canvas = makeCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  return canvas.transferToImageBitmap();
}

async function rotate(bitmap, { deg }) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return bitmap;
  const swap = deg === 90 || deg === 270;
  const canvas = makeCanvas(swap ? bitmap.height : bitmap.width, swap ? bitmap.width : bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return canvas.transferToImageBitmap();
}

async function resize(bitmap, { w, h }) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === bitmap.width && h === bitmap.height) return bitmap;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.transferToImageBitmap();
}

async function colorToAlpha(bitmap, { hex, tolerance }) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const tr = parseInt(hex.slice(1, 3), 16) / 255;
  const tg = parseInt(hex.slice(3, 5), 16) / 255;
  const tb = parseInt(hex.slice(5, 7), 16) / 255;
  const threshold = Math.max(0, Math.min(1, tolerance / 100));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, a = data[i + 3] / 255;
    let minRatio = Infinity;
    if (tr > 0) minRatio = Math.min(minRatio, r / tr);
    if (tg > 0) minRatio = Math.min(minRatio, g / tg);
    if (tb > 0) minRatio = Math.min(minRatio, b / tb);
    if (!isFinite(minRatio)) minRatio = Math.min(r, g, b);
    let alpha = 1 - Math.min(1, Math.max(0, minRatio));
    if (threshold > 0) {
      const dist = Math.sqrt((r-tr)**2 + (g-tg)**2 + (b-tb)**2) / Math.sqrt(3);
      const factor = Math.max(0, Math.min(1, (dist - threshold) / Math.max(1e-6, 1 - threshold)));
      alpha *= factor;
    }
    let nr = r, ng = g, nb = b;
    if (alpha > 1e-6) {
      nr = Math.min(1, Math.max(0, (r - tr * (1 - alpha)) / alpha));
      ng = Math.min(1, Math.max(0, (g - tg * (1 - alpha)) / alpha));
      nb = Math.min(1, Math.max(0, (b - tb * (1 - alpha)) / alpha));
    }
    data[i] = Math.round(nr * 255);
    data[i + 1] = Math.round(ng * 255);
    data[i + 2] = Math.round(nb * 255);
    data[i + 3] = Math.round(alpha * a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}

async function removeColor(bitmap, { hex, tolerance }) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  const maxDist = (tolerance / 100) * 441.67;
  const md2 = maxDist * maxDist;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb;
    if (dr*dr + dg*dg + db*db <= md2) data[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}

/* ============================================================
 *  SVG Tracing
 * ============================================================ */

async function bitmapToSvg(bitmap, opts = {}) {
  const alphaThreshold  = opts.alphaThreshold  ?? 128;
  const colorThreshold  = opts.colorThreshold  ?? 16;
  const minArea         = opts.minArea         ?? 8;
  const simplifyTol     = opts.simplifyTolerance ?? 0.75;

  const W = bitmap.width, H = bitmap.height;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  // 1) Farben quantisiert sammeln (Bucket-Größe 8)
  const MASK = ~7;
  const colorMap = new Map();
  for (let i = 0; i < W * H; i++) {
    if (data[i * 4 + 3] < alphaThreshold) continue;
    const r = data[i * 4] & MASK, g = data[i * 4 + 1] & MASK, b = data[i * 4 + 2] & MASK;
    const key = (r << 16) | (g << 8) | b;
    let e = colorMap.get(key);
    if (!e) { e = { count: 0, sr: 0, sg: 0, sb: 0 }; colorMap.set(key, e); }
    e.count++;
    e.sr += data[i * 4]; e.sg += data[i * 4 + 1]; e.sb += data[i * 4 + 2];
  }

  // 2) Cluster nach Farbabstand zusammenfassen
  const colors = Array.from(colorMap.values())
    .map(c => ({ r: c.sr / c.count, g: c.sg / c.count, b: c.sb / c.count, count: c.count }))
    .sort((a, b) => b.count - a.count);

  const ct2 = colorThreshold * colorThreshold;
  const clusters = [];
  for (const c of colors) {
    let merged = false;
    for (const cl of clusters) {
      const dr = c.r - cl.r, dg = c.g - cl.g, db = c.b - cl.b;
      if (dr*dr + dg*dg + db*db <= ct2) {
        const t = cl.count + c.count;
        cl.r = (cl.r * cl.count + c.r * c.count) / t;
        cl.g = (cl.g * cl.count + c.g * c.count) / t;
        cl.b = (cl.b * cl.count + c.b * c.count) / t;
        cl.count = t;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ r: c.r, g: c.g, b: c.b, count: c.count });
  }

  const sig = clusters.filter(c => c.count >= minArea);
  if (sig.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>`;
  }

  // 3) Pixel → nächster Cluster
  const masks = sig.map(() => new Uint8Array(W * H));
  for (let i = 0; i < W * H; i++) {
    if (data[i * 4 + 3] < alphaThreshold) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    let bestK = 0, bestD = Infinity;
    for (let k = 0; k < sig.length; k++) {
      const c = sig[k];
      const dr = r - c.r, dg = g - c.g, db = b - c.b;
      const d = dr*dr + dg*dg + db*db;
      if (d < bestD) { bestD = d; bestK = k; }
    }
    masks[bestK][i] = 1;
  }

  // 4) Pro Cluster tracen
  const paths = [];
  for (let k = 0; k < sig.length; k++) {
    const contours = marchingSquares(masks[k], W, H);
    let d = '';
    for (const contour of contours) {
      if (contour.length < 3) continue;
      const s = simplifyDouglasPeucker(contour, simplifyTol);
      if (s.length < 3) continue;
      d += 'M' + s.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L') + 'Z';
    }
    if (!d) continue;
    const c = sig[k];
    const hex = '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    paths.push(`<path fill="${hex}" fill-rule="evenodd" d="${d}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${paths.join('\n')}\n</svg>`;
}

/* --- Marching Squares --- */

function marchingSquares(mask, W, H) {
  const get = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask[y * W + x];

  // Segmenttabellen: 'T','R','B','L' = Top/Right/Bottom/Left Mittelpunkt.
  // Orientierung: "innen" liegt CCW-links (→ evenodd-kompatibel).
  const segmentsForCase = {
    0: [],
    1: [['T','L']],
    2: [['R','T']],
    3: [['R','L']],
    4: [['B','R']],
    5: [['T','L'],['B','R']],
    6: [['B','T']],
    7: [['B','L']],
    8: [['L','B']],
    9: [['T','B']],
    10: [['R','T'],['L','B']],
    11: [['R','B']],
    12: [['L','R']],
    13: [['T','R']],
    14: [['L','T']],
    15: [],
  };

  const segments = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v0 = get(x, y);
      const v1 = get(x + 1, y);
      const v2 = get(x + 1, y + 1);
      const v3 = get(x, y + 1);
      const c = v0 | (v1 << 1) | (v2 << 2) | (v3 << 3);
      const list = segmentsForCase[c];
      if (!list.length) continue;
      const pt = (e) => e === 'T' ? [x + 0.5, y]
                    : e === 'R' ? [x + 1, y + 0.5]
                    : e === 'B' ? [x + 0.5, y + 1]
                    : [x, y + 0.5];
      for (const [a, b] of list) segments.push([pt(a), pt(b)]);
    }
  }

  // Segmente zu Konturen verketten
  const key = p => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const byStart = new Map();
  for (let i = 0; i < segments.length; i++) {
    const k = key(segments[i][0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(i);
  }

  const used = new Set();
  const contours = [];
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const contour = [segments[i][0]];
    let current = segments[i][1];
    const startKey = key(contour[0]);
    let safety = segments.length + 10;
    while (safety-- > 0) {
      contour.push(current);
      if (key(current) === startKey) break;
      const cands = byStart.get(key(current)) || [];
      let next = -1;
      for (const ci of cands) { if (!used.has(ci)) { next = ci; break; } }
      if (next < 0) break;
      used.add(next);
      current = segments[next][1];
    }
    if (contour.length >= 3) contours.push(contour);
  }
  return contours;
}

/* --- Douglas-Peucker --- */

function simplifyDouglasPeucker(points, epsilon) {
  if (points.length < 3) return points;
  const sqDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, py = a[1] + t * dy;
    return (p[0] - px) ** 2 + (p[1] - py) ** 2;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const eps2 = epsilon * epsilon;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    let maxDist = 0, maxIdx = first;
    for (let i = first + 1; i < last; i++) {
      const d = sqDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > eps2) {
      keep[maxIdx] = true;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}