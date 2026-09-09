'use strict';
/* ============================================================================
   THE FILE A BUILDER HANDS OVER.

   A builder's villas exist in a spreadsheet before they exist here, so the way
   they get in is a file. This reads one, and its whole job is to decide -
   before anything is written - which rows would become villas and which would
   not, and to say why for each one.

   IT DOES NOT WRITE ANYTHING. The office sees this list, presses a button, and
   the same text is read again by the same function on the way to the database.
   What is confirmed is exactly what was shown; there is no server-side state
   between the two that could go stale, and no half-parsed row is carried over.

   WHY A ROW IS ONLY EVER SKIPPED, NEVER PATCHED. A villa with a blank
   agreement value is not a villa with a zero agreement value, and a villa with
   no buyer name is not a villa named "Unknown". Every stage of that villa, and
   every demand ever raised against it, would be priced off a number somebody
   guessed. The row is left out, named, with the reason, and the file is fixed.
   ========================================================================= */

/** Columns understood, in the order a header-less file must use them. */
const COLUMNS = ['code', 'unit_type', 'agreement_value', 'buyer_name',
                 'bank', 'site_engineer', 'channel_partner', 'relationship_manager'];

/* A comma-separated line, allowing a quoted field to contain commas, because
   "4 BHK, 3,640 sq ft" is exactly the sort of thing a builder's file carries. */
function cells(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** Rupees as a person writes them - 32,00,000 or "3200000.00" - as paise. */
function paiseOf(text) {
  const clean = String(text == null ? '' : text).replace(/[\s,₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  const paise = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  if (paise <= 0n || paise > 9_000_000_000_000n) return null;   // a villa, not a country
  return Number(paise);
}

/**
 * @param {string} text     the file, or what was pasted
 * @param {Set<string>} existing  codes already on the project
 * @returns {{text, header, rows}}  every row, in file order, each either
 *   ready to create or carrying `why` it will be skipped.
 */
function parse(text, existing = new Set()) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const rows = [];
  const seen = new Set();
  let header = null;
  let index = COLUMNS.slice();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const c = cells(raw);

    /* A header is optional, and if it is there it decides the order - a
       builder's file is not obliged to be in ours. */
    if (header === null && /^code$/i.test(c[0] || '')) {
      header = c.map(h => h.toLowerCase().replace(/[^a-z_]/g, '_'));
      index = header.map(h => (h === 'agreement_value_paise' ? 'agreement_value' : h));
      continue;
    }
    if (header === null) header = false;

    const get = name => {
      const at = index.indexOf(name);
      return at < 0 ? '' : (c[at] || '').trim();
    };

    /* A COMMA INSIDE AN UNQUOTED NUMBER.

       "2,80,00,000" written the way an Indian spreadsheet writes it, without
       quotes, is four cells. Every column after it shifts left, and the row
       still parses: the agreement value becomes 2 and the buyer's name becomes
       "80". That is a villa created for two rupees, priced against a schedule,
       with demands to follow - the worst thing this reader could do, and it
       looks like a success.

       So the shape of the row is checked before its contents. A row with more
       cells than the file declares is skipped and told why. */
    const width = header ? header.length : index.length;
    if (c.length > width) {
      rows.push({
        line: i + 1, code: (c[0] || '').trim(),
        why: c.length + ' columns where the file declares ' + width
          + ' - is a number written with commas and no quotes?',
      });
      continue;
    }

    const row = {
      line: i + 1,
      code: get('code'),
      unit_type: get('unit_type'),
      buyer_name: get('buyer_name'),
      bank: get('bank') || null,
      site_engineer: get('site_engineer') || null,
      channel_partner: get('channel_partner') || null,
      relationship_manager: get('relationship_manager') || null,
      agreement_value_paise: paiseOf(get('agreement_value')),
    };

    if (!row.code) row.why = 'no villa code';
    else if (seen.has(row.code.toLowerCase())) row.why = 'the same code twice in this file';
    else if (existing.has(row.code)) row.why = 'already on this project';
    else if (!row.unit_type) row.why = 'no unit type';
    else if (!row.buyer_name) row.why = 'no buyer name';
    else if (row.agreement_value_paise === null) {
      row.why = get('agreement_value')
        ? 'the agreement value "' + get('agreement_value') + '" is not a plain amount in rupees'
        : 'no agreement value';
    }

    if (!row.why) seen.add(row.code.toLowerCase());
    rows.push(row);
  }

  return { text: src, header, rows };
}

module.exports = { parse, paiseOf, cells, COLUMNS };
