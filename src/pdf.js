'use strict';
/* Documents. These print strings the calculation layer produced. They contain
   no arithmetic of their own. */
const PDFDocument = require('pdfkit');
const path = require('path');
const M = require('./money');

const INK = '#12213D', INK2 = '#5B6B85', INK3 = '#93A1B8', HAIR = '#DEE5EF',
      HAIR2 = '#F2F6FB', BRAND = '#1B4DD8';
const L = 56, R = 539, W = R - L;

// Inter, the face the screens use. Registered under its own name: the standard
// PDF font names are reserved, and reusing one silently drops the rupee sign.
const REG = 'inter', BOLD = 'inter-semibold';

function newDoc() {
  const d = new PDFDocument({ size: 'A4', margin: L });
  d.registerFont(REG, path.join(__dirname, '../assets/Inter-Regular.ttf'));
  d.registerFont(BOLD, path.join(__dirname, '../assets/Inter-SemiBold.ttf'));
  return d;
}

function head(doc, kick) {
  doc.rect(0, 0, 595, 4).fill(BRAND);
  doc.font(BOLD).fontSize(15).fillColor(INK).text('Plint', L, 44);
  doc.font(REG).fontSize(8).fillColor(INK3)
     .text('NVT ETERNA   \u00B7   PHASE 1', L, 63, { characterSpacing: 1 });
  doc.font(REG).fontSize(8).fillColor(INK3)
     .text(kick.toUpperCase(), L, 63, { width: W, align: 'right', characterSpacing: 1 });
  doc.moveTo(L, 84).lineTo(R, 84).lineWidth(0.7).strokeColor(HAIR).stroke();
  doc.y = 112;
}

function para(doc, text, opts = {}) {
  doc.font(opts.bold ? BOLD : REG).fontSize(opts.size || 10)
     .fillColor(opts.color || INK2)
     .text(text, L, doc.y, { width: opts.width || 440, lineGap: 1.5 });
}

function kicker(doc, text) {
  doc.font(REG).fontSize(8).fillColor(INK3)
     .text(text.toUpperCase(), L, doc.y, { characterSpacing: 1 });
  doc.y += 6;
}

function row(doc, label, value, strong) {
  const y = doc.y;
  doc.font(REG).fontSize(10).fillColor(INK2).text(label, L, y, { width: 250 });
  const yl = doc.y;
  doc.font(strong ? BOLD : REG).fontSize(10).fillColor(strong ? INK : INK2)
     .text(value, 280, y, { width: R - 280, align: 'right' });
  doc.y = Math.max(yl, doc.y) + 6;
  doc.moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).lineWidth(0.5).strokeColor(HAIR2).stroke();
}

const gap = (doc, n) => { doc.y += n; };

/** Demand letter. Priced by money.priceStage, printed here. */
function demandLetter(ctx) {
  const { unit, stage, demand, project, buyer, stageRow } = ctx;
  const doc = newDoc();
  head(doc, 'Demand letter');

  kicker(doc, demand.doc_no);
  doc.font(REG).fontSize(30).fillColor(INK).text(M.money(demand.total_paise), L, doc.y);
  gap(doc, 6);
  para(doc, stage.name + ', ' + (stage.pct_bp / 100) + ' per cent of agreement value, plus GST at '
    + '5 per cent. Due on ' + M.longDate(demand.due_at)
    + '. After that date interest runs at 12 per cent a year.');
  gap(doc, 26);

  row(doc, 'Villa', unit.code + '   \u00B7   ' + unit.unit_type);
  row(doc, 'Buyer', buyer);
  row(doc, 'Lender', unit.bank || 'Self funded');
  row(doc, 'Agreement value', M.money(unit.agreement_value_paise));
  row(doc, 'Stage', stage.name + '   \u00B7   ' + stage.description);
  gap(doc, 14);
  row(doc, 'Stage amount, ' + (stage.pct_bp / 100) + ' per cent', M.money(demand.base_paise));
  if (demand.extras_paise) row(doc, 'Approved finish upgrades', M.money(demand.extras_paise));
  row(doc, 'GST at 5 per cent', M.money(demand.gst_paise));
  row(doc, 'Payable', M.money(demand.total_paise), true);
  gap(doc, 14);
  row(doc, 'Raised', M.longDate(demand.raised_at));
  row(doc, 'Due', M.longDate(demand.due_at), true);

  gap(doc, 30);
  para(doc, 'This demand was raised because ' + stage.name.toLowerCase()
    + ' was verified on site and certified by a qualified engineer. The engineer\u2019s completion '
    + 'certificate and the date, time and GPS stamped photographs accompany this letter'
    + (unit.bank ? ' and are queued for ' + unit.bank + '.' : '.'),
    { size: 9.5, width: 460 });
  gap(doc, 16);
  para(doc, 'Project ' + project.name + ', ' + project.phase
    + '.   RERA reference on the agreement of sale.   Certificate hash '
    + String(stageRow.certificate_hash || '').slice(0, 32) + '\u2026',
    { size: 8, color: INK3, width: 460 });
  doc.end();
  return doc;
}

/** Engineer's certificate of stage completion. */
function completionCertificate(ctx) {
  const { unit, stage, engineer, stageRow, evidence, project } = ctx;
  const doc = newDoc();
  head(doc, 'Completion certificate');

  kicker(doc, 'Engineer\u2019s certificate of stage completion');
  doc.font(REG).fontSize(26).fillColor(INK).text(stage.name, L, doc.y);
  gap(doc, 8);
  para(doc, 'I certify that I have inspected villa ' + unit.code + ' at ' + project.name + ', '
    + project.phase + ', and that the works described as ' + stage.description.toLowerCase()
    + ' were complete and executed in accordance with the approved drawings and specification as at '
    + M.longDate(stageRow.certified_at) + '.', { width: 450 });
  gap(doc, 26);

  row(doc, 'Villa', unit.code + '   \u00B7   ' + unit.unit_type);
  row(doc, 'Stage', stage.name);
  row(doc, 'Marked on site by', stageRow.marked_by + ', on ' + M.longDate(stageRow.marked_at));
  row(doc, 'Certified by', engineer.display_name, true);
  row(doc, 'Qualification', engineer.engineer_qual || '\u2014');
  row(doc, 'Registration', engineer.engineer_reg || '\u2014');
  row(doc, 'Certified on', M.longDate(stageRow.certified_at));
  row(doc, 'Certificate hash', String(stageRow.certificate_hash || '').slice(0, 32) + '\u2026');

  gap(doc, 22);
  kicker(doc, 'Evidence');
  evidence.forEach(e => row(doc, e.caption,
    M.longDate(e.taken_at) + '   \u00B7   ' + e.gps + '   \u00B7   ' + e.sha256.slice(0, 12) + '\u2026'));

  // The photographs themselves, for the rows that have a stored file. A row
  // without one prints as a line above and nothing here, which is what the
  // certificate did before any file existed.
  thumbnails(doc, evidence.filter(e => e.image));

  gap(doc, 46);
  doc.moveTo(L, doc.y).lineTo(L + 190, doc.y).lineWidth(0.7).strokeColor(HAIR).stroke();
  gap(doc, 10);
  doc.font(BOLD).fontSize(10).fillColor(INK).text(engineer.display_name, L, doc.y);
  gap(doc, 2);
  doc.font(REG).fontSize(8.5).fillColor(INK3)
     .text([engineer.engineer_qual, engineer.engineer_reg].filter(Boolean).join('   \u00B7   '), L, doc.y);
  doc.end();
  return doc;
}

/* A row of thumbnails, each captioned with its hash so the picture on the page
   ties to the evidence line above it and to the file on disk. pdfkit embeds
   JPEG and PNG directly; `fit` scales them into the box for display. */
function thumbnails(doc, shots) {
  if (!shots.length) return;
  gap(doc, 14);

  const COLS = 3, BOX = 150, H = 108, GUTTER = (W - COLS * BOX) / (COLS - 1);
  let rowTop = doc.y;

  shots.forEach((e, i) => {
    const col = i % COLS;
    if (col === 0 && i) rowTop += H + 26;
    // A new page rather than a thumbnail sliced by the bottom margin. Only at
    // the start of a row, so a row is never split across two pages.
    if (col === 0 && rowTop + H + 30 > 780) { doc.addPage(); rowTop = 72; }
    const x = L + col * (BOX + GUTTER);

    doc.save();
    doc.rect(x, rowTop, BOX, H).lineWidth(0.7).strokeColor(HAIR).stroke();
    try {
      doc.image(e.image, x + 1, rowTop + 1, { fit: [BOX - 2, H - 2], align: 'center', valign: 'center' });
    } catch {
      // An unreadable file must not take the whole certificate down with it.
      doc.font(REG).fontSize(8).fillColor(INK3)
         .text('photograph unavailable', x + 8, rowTop + H / 2 - 4, { width: BOX - 16, align: 'center' });
    }
    doc.restore();

    doc.font(REG).fontSize(7.5).fillColor(INK3)
       .text(e.sha256.slice(0, 16) + '…', x, rowTop + H + 5, { width: BOX });
  });

  doc.y = rowTop + H + 26;
}

module.exports = { demandLetter, completionCertificate };
