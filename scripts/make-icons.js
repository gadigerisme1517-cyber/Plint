'use strict';
/* ============================================================================
   Generates the home-screen icons from the Plint mark, so they can be
   regenerated rather than being binary files nobody can edit.

     node scripts/make-icons.js

   Two sets, because Android and iOS want different things:

     icon-<n>.png           the mark on a rounded brand tile, for anywhere the
                            platform shows the image as-is
     icon-maskable-<n>.png  the same mark, smaller, on a full-bleed tile, for
                            Android's adaptive icons which crop to a circle or
                            a squircle. The mark sits inside the middle 80%
                            "safe zone" so no crop can clip it.
   ========================================================================= */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const BRAND = '#635BFF';
const OUT = path.join(__dirname, '..', 'public', 'icons');

/** The mark from plint-v21, on a 32-unit grid. */
const mark = (fill, counter) => `
  <path d="M14.2 3h4.6a8.6 8.6 0 0 1 0 17.2h-4.6V29H8.4v-8.4l5.8-5.8V3Z" fill="${fill}"/>
  <path d="M14.2 8.6V15h4.6a3.2 3.2 0 0 0 0-6.4h-4.6Z" fill="${counter}"/>
  <rect x="5.4" y="8.6" width="6.4" height="6.4" rx="1.6" fill="${fill}"/>`;

/* scale < 1 shrinks the mark towards the centre, which is what buys the
   maskable safe zone. */
function svg(size, { maskable }) {
  const scale = maskable ? 0.62 : 0.78;
  const offset = (32 - 32 * scale) / 2;
  const radius = maskable ? 0 : 7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="${radius}" fill="${BRAND}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${mark('#FFFFFF', BRAND)}</g>
</svg>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const made = [];

  for (const size of [192, 512]) {
    for (const maskable of [false, true]) {
      const name = 'icon' + (maskable ? '-maskable' : '') + '-' + size + '.png';
      await sharp(Buffer.from(svg(size, { maskable })))
        .png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
      made.push(name);
    }
  }

  // iOS does not read the manifest for this one and does not mask it, so it
  // gets the rounded tile at the size Safari asks for.
  await sharp(Buffer.from(svg(180, { maskable: false })))
    .png({ compressionLevel: 9 }).toFile(path.join(OUT, 'apple-touch-icon.png'));
  made.push('apple-touch-icon.png');

  // A vector favicon for browsers that take one, at any size.
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg(32, { maskable: false }) + '\n');
  made.push('favicon.svg');

  for (const f of made) {
    const p = path.join(OUT, f);
    console.log('  ' + f.padEnd(26) + (fs.statSync(p).size / 1024).toFixed(1) + ' KB');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
