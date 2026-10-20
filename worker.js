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
    case 'colorToAlpha':return colorToAlpha(bitmap, op);
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


/**
 * GIMP-Style "Color to Alpha".
 * Entfernt die Zielfarbe weich, indem sie aus jedem Pixel herausgerechnet wird.
 * Referenz: https://gitlab.gnome.org/GNOME/gimp/-/blob/master/app/operations/gimpoperationcolortoalpha.c
 *
 * @param {ImageBitmap} bitmap
 * @param {string} hex   Zielfarbe, z.B. "#ffffff"
 * @param {number} tolerance  0..100 (0 = exakt nach GIMP, >0 = zusätzliche Ähnlichkeitsdämpfung)
 */
async function colorToAlpha(bitmap, { hex, tolerance }) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  // Zielfarbe in 0..1
  const tr = parseInt(hex.slice(1, 3), 16) / 255;
  const tg = parseInt(hex.slice(3, 5), 16) / 255;
  const tb = parseInt(hex.slice(5, 7), 16) / 255;

  const threshold = Math.max(0, Math.min(1, tolerance / 100));

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const a = data[i + 3] / 255;

    // --- GIMP-Kern: alpha = 1 - min(c / t) über alle Kanäle mit t > 0 ---
    // Für Zielkanäle == 0 gibt es keinen Beitrag (GIMP behandelt das so,
    // dass reines Schwarz als Ziel trotzdem funktioniert, siehe unten).
    let minRatio = Infinity;
    if (tr > 0) minRatio = Math.min(minRatio, r / tr);
    if (tg > 0) minRatio = Math.min(minRatio, g / tg);
    if (tb > 0) minRatio = Math.min(minRatio, b / tb);

    // Sonderfall: Zielfarbe ist reines Schwarz (alle Kanäle 0).
    // Dann ist alpha = 1 - (das Minimum der Kanäle, das "übrig" bleibt)…
    // GIMP nutzt hier: alpha = 1 - min(r, g, b) / 1  →  also 1 - min(r,g,b)
    if (!isFinite(minRatio)) {
      minRatio = Math.min(r, g, b);
    }

    let alpha = 1 - Math.min(1, Math.max(0, minRatio));

    // --- Toleranz: zusätzlich ähnliche Farben abschwächen ---
    // (GIMP selbst hat keinen Toleranz-Regler; das ist unsere Erweiterung.)
    if (threshold > 0) {
      const dist = Math.sqrt(
        (r - tr) * (r - tr) +
        (g - tg) * (g - tg) +
        (b - tb) * (b - tb)
      ) / Math.sqrt(3); // 0..1

      // Bei dist <= threshold → alpha *= 0 (voll weg)
      // Bei dist >= 1        → alpha bleibt
      const factor = Math.max(0, Math.min(1, (dist - threshold) / Math.max(1e-6, 1 - threshold)));
      alpha *= factor;
    }

    // --- Vordergrundfarbe zurückrechnen: out = (c - t*(1-alpha)) / alpha ---
    // Das ist die Umkehrung von: c = out*alpha + t*(1-alpha)
    let nr = r, ng = g, nb = b;
    if (alpha > 1e-6) {
      nr = (r - tr * (1 - alpha)) / alpha;
      ng = (g - tg * (1 - alpha)) / alpha;
      nb = (b - tb * (1 - alpha)) / alpha;
      // GIMP clampt NICHT auf 0..1 — es kann kurzzeitig >1 oder <0 werden,
      // aber da alpha klein ist, fällt das visuell nicht auf.
      // Für Canvas müssen wir aber auf 0..255 clampen:
      nr = Math.min(1, Math.max(0, nr));
      ng = Math.min(1, Math.max(0, ng));
      nb = Math.min(1, Math.max(0, nb));
    } else {
      // Vollständig transparent → Farbe beliebig; Original behalten
      // (verhindert schwarze Ränder beim Skalieren)
      nr = r; ng = g; nb = b;
    }

    data[i]     = Math.round(nr * 255);
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