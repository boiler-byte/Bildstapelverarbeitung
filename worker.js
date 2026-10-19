// worker.js – Führt die Op-Kette auf einem ImageBitmap aus.
// Nachrichten: { id, bitmap, ops } → Antwort: { id, bitmap } oder { id, error }

self.onmessage = async (e) => {
  const { id, bitmap, ops } = e.data;
  try {
    let current = bitmap;
    for (const op of ops) {
      current = await applyOp(current, op);
    }
    self.postMessage({ id, bitmap: current }, [current]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

async function applyOp(bitmap, op) {
  switch (op.type) {
    case 'crop':     return crop(bitmap, op);
    case 'rotate':   return rotate(bitmap, op);
    case 'resize':   return resize(bitmap, op);
    case 'removeColor': return removeColor(bitmap, op);
    default: throw new Error('Unbekannte Op: ' + op.type);
  }
}

function makeCanvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  return c;
}

async function crop(bitmap, { x, y, w, h }) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  // clamp
  if (x + w > bitmap.width) w = bitmap.width - x;
  if (y + h > bitmap.height) h = bitmap.height - y;
  if (w <= 0 || h <= 0) throw new Error('Crop außerhalb des Bildes');
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  return canvas.transferToImageBitmap();
}

async function rotate(bitmap, { deg }) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return bitmap;
  if (deg === 90 || deg === 270) {
    const canvas = makeCanvas(bitmap.height, bitmap.width);
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    return canvas.transferToImageBitmap();
  }
  // 180
  const canvas = makeCanvas(bitmap.width, bitmap.height);
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

async function removeColor(bitmap, { hex, tolerance }) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  // Toleranz 0..100 → Distanz 0..~441 (max RGB-Distanz)
  const maxDist = (tolerance / 100) * 441.67;
  const md2 = maxDist * maxDist;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    if (dr * dr + dg * dg + db * db <= md2) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}