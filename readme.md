# ROLLE

Du bist ein Senior Frontend-Entwickler. Baue ein vollständiges, produktionsreifes
Web-Tool zur Stapelverarbeitung von Bildern. Liefere den kompletten Code aus:
- `index.html` (HTML + inline `<style>` + inline `<script>`-Block für die App-Logik)
- `worker.js` (separater Web-Worker)

Externe Dependency: JSZip per CDN (`https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js`).
Sonst **keine** Libraries, kein Framework, kein Build-Schritt. Vanilla JS (ES2022).

---

# ZIEL

Nutzer lädt mehrere Bilder, sieht sie als Galerie, kann pro Bild eine Kette von
Bearbeitungsoperationen (Freistellen, Zuschneiden, Rotieren, Resize) **nicht-destruktiv**
definieren, die Vorschau live sehen, die Ops wahlweise auf **ein Bild** oder den
**gesamten Stapel** anwenden, und abschließend alle Bilder in einem gewünschten
Format – optional in mehreren Auflösungen – als flaches ZIP herunterladen.

---

# DESIGN

- Dunkel, seriös, zweckmäßig. Kein verspieltes UI.
- Farbpalette: Hintergrund `#1a1a1d`, Panels `#242428`, Rahmen `#35353a`,
  Text `#e8e8ea`, Sekundärtext `#9a9aa2`, Akzent `#4a9eff` (nur für aktive
  Zustände/primäre Buttons).
- Sans-Serif (System-Stack), klare Hierarchie, viel Whitespace, dezente Radien (4–6px).
- Keine Animationen außer schnellen Hover/Focus-Transitions (<150ms).
- Sprache der gesamten UI: **Deutsch**.

- Der Bearbeiten-Dialog zeigt das Vorschaubild und darunter die 
    - angewandten Schritte (Platzsparend und mit Entfernen-Button),
    - Zuschneiden (mit Rechteckauswahl)
    - Rotation, Farbe entfernen @todo

---

# DATENMODELL

```js
Image = {
  id: string,               // crypto.randomUUID()
  name: string,             // Originaldateiname ohne Endung
  sourceBlob: Blob,         // Originaldatei
  sourceBitmap: ImageBitmap,// einmalig decodiert
  committedOps: Op[],       // dauerhaft angewendete Ops
  draftOps: Op[] | null,    // nur im Editor gesetzt
  thumbnailURL: string      // ObjectURL des Thumbnails
}

Op =
  | { type: 'removeColor', hex: '#rrggbb', tolerance: number /* 0..100 */ }
  | { type: 'crop',   x: number, y: number, w: number, h: number }  // Pixel, im Koordinatensystem NACH allen vorherigen Ops
  | { type: 'rotate', deg: 90 | 180 | 270 }                          // im Uhrzeigersinn
  | { type: 'resize', w: number, h: number }                         // Zielpixel, kein keepRatio-Flag im Op (wird im UI aufgelöst)

ExportSettings = {
  format: 'jpeg' | 'png' | 'webp',
  quality: number,           // 0..1, nur relevant wenn format !== 'png'
  resizeList: number[],      // Zielbreiten, z.B. [512, 1024]; leer = keine Batch-Versionen; wenn vorhanden, werden Versionen von den bearbeiteten Bildern erstellt und nur diese landen in der export zip
  suffix: string             // z.B. '', '.', '--'
}