'use strict';
/* ============================================================================
   THE SEEDED EVIDENCE, AS ACTUAL FILES.

   `db/seed.js` wrote every evidence row with a fabricated hash and no file:
   `mime` was NULL, nothing existed on disk, and the screens printed the
   caption and the co-ordinates as text. That was fine while no screen rendered
   an image. Pass 4 puts the photographs on the buyer's stage screen, the
   engineer's villa screen and the certificate, so a row with no file behind it
   is now a broken tile.

   This fills them. For every evidence row whose `mime` is NULL it generates a
   plate, stores it through the same content-addressed writer an upload uses,
   and updates the row to the hash of the bytes that are actually on disk.

   WHAT IT DRAWS, AND WHAT IT DOES NOT. It draws a plate: the villa, the stage,
   the caption, the date and the co-ordinates on a flat ground, in this
   product's own colours. It is not a photograph of a building and it does not
   pretend to be one - a demo that invents site photographs of villas that were
   never built is a demo that lies about the one thing this product is for.
   Every plate says SEEDED DEMO EVIDENCE across the bottom.

   It is idempotent: rows that already have a file are skipped, so it can run
   on the deployed database, which was seeded long before this existed.
   ========================================================================= */
const { Client } = require('pg');
const sharp = require('sharp');
const config = require('../src/config');
const EV = require('../src/evidence');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* The product's own tokens, so a plate belongs to the screen it appears on. */
const GROUND = '#EEF1F6', INK = '#0C0D10', GREY = '#71737A', ACCENT = '#2F6BFF';

/** One plate, as a JPEG. Deterministic: the same row always makes the same bytes. */
async function plate({ code, stage, caption, when, gps }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720">
<rect width="960" height="720" fill="${GROUND}"/>
<rect x="0" y="0" width="960" height="8" fill="${ACCENT}"/>
<g font-family="Helvetica, Arial, sans-serif" fill="${INK}">
<text x="56" y="150" font-size="72" font-weight="bold">${esc(code)}</text>
<text x="56" y="212" font-size="34" fill="${GREY}">${esc(stage)}</text>
<text x="56" y="330" font-size="40" font-weight="bold">${esc(caption)}</text>
<text x="56" y="386" font-size="26" fill="${GREY}">${esc(when)}</text>
<text x="56" y="426" font-size="26" fill="${GREY}">${esc(gps)}</text>
<text x="56" y="660" font-size="22" fill="${GREY}" letter-spacing="3">SEEDED DEMO EVIDENCE</text>
</g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

async function fill(c, { quiet } = {}) {
  /* Every row, not only the ones with no `mime`.

     The deployed demo runs on a plan with no persistent disk: the evidence
     directory is inside the container and is gone on every deploy. A row that
     was filled last time therefore still points at a file that no longer
     exists, and the screens would show broken tiles. A plate is deterministic
     - the same row always makes the same bytes and therefore the same hash -
     so a missing file is simply written again and the row does not change. */
  const all = (await c.query(
    `SELECT e.id, e.caption, e.taken_at, e.gps, e.mime, e.sha256, u.code, t.name stage_name
       FROM evidence e
       JOIN unit_stages s ON s.id = e.unit_stage_id
       JOIN units u ON u.id = s.unit_id
       JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
      ORDER BY e.id`)).rows;
  const rows = all.filter(r => !r.mime || !EV.exists(r.sha256));
  if (!rows.length) return { filled: 0, already: true };

  /* Whoever the office is, because somebody has to have uploaded it and the
     CHECK on this table refuses half a record: a mime with no uploader. */
  const by = (await c.query(
    `SELECT id FROM users WHERE role = 'office' ORDER BY id LIMIT 1`)).rows[0];
  if (!by) throw new Error('no office user to attribute the seeded evidence to');

  let filled = 0;
  for (const r of rows) {
    const buf = await plate({
      code: r.code,
      stage: r.stage_name,
      caption: r.caption,
      when: new Date(r.taken_at).toLocaleDateString('en-IN',
        { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
      gps: r.gps,
    });
    /* `store()` refuses to overwrite - it writes with `wx` - so a file that is
       already there for this hash is left exactly as it is. */
    let stored;
    try {
      stored = await EV.store(buf);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      stored = null;
    }
    if (stored && stored.sha256 !== r.sha256) {
      await c.query(
        `UPDATE evidence SET sha256 = $2, mime = $3, byte_size = $4,
                uploaded_by = $5, uploaded_at = $6
          WHERE id = $1`,
        [r.id, stored.sha256, stored.mime, stored.byteSize, by.id, r.taken_at]);
    } else if (!r.mime) {
      await c.query(
        `UPDATE evidence SET mime = $2, byte_size = $3, uploaded_by = $4, uploaded_at = $5
          WHERE id = $1`,
        [r.id, 'image/jpeg', buf.length, by.id, r.taken_at]);
    }
    filled++;
    if (!quiet && filled % 100 === 0) console.log('  ' + filled + ' of ' + rows.length);
  }
  return { filled, already: false };
}

async function main() {
  const c = new Client(config.adminDb());
  await c.connect();
  try {
    await c.query('SET search_path = plint, public');
    await c.query('BEGIN');
    const out = await fill(c);
    await c.query('COMMIT');
    console.log('\n── evidence files\n  '
      + (out.already ? 'every photograph already has a file'
        : 'wrote ' + out.filled + ' plates'));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { fill, plate };
