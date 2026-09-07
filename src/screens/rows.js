'use strict';
/* ============================================================================
   One list row, built in one place.

   Every screen in this application shows the same object: a villa, what is
   happening to it, how long it has been happening, and what you can do about
   it. Fifteen separate copies of that markup drifted in fifteen directions -
   the villa code in its own column here and inline there, day counts written
   into the amount cell on one screen and the day cell on another, and a title
   that rendered as two labels with a separator floating between them because
   the code and the stage were different grid cells with a gap between.

   So the row is built here and the screens describe their data. The important
   part is `code` and `title` becoming ONE run of text: on a phone the villa
   and the stage are a single heading, one size, one weight, one baseline, and
   there is no way to get that from two boxes sitting in two columns.

   `.id` survives for the desktop table, where the code really is its own
   column under a "Villa" heading. `.rcode` carries it inline for the phone.
   Exactly one of the two is ever visible.
   ========================================================================= */

module.exports = function rowBuilder({ esc }) {

  /**
   * @param {object} r
   * @param {string} [r.code]    villa code - its own column on a desktop,
   *                             the first words of the title on a phone
   * @param {string} r.title     what this row is
   * @param {string} [r.detail]  the line under it. Pre-escaped: callers build
   *                             it out of several fields with separators.
   * @param {string} [r.chip]    status pill, already marked up
   * @param {string} [r.days]    an age. Always the day cell, never the amount
   *                             cell - they used to be mixed up between screens
   * @param {string} [r.amount]  money, right-aligned and tabular
   * @param {string} [r.action]  a control, or `{ text }` for a status word
   * @param {string} [r.href]    makes the whole row the link
   * @param {string} [r.cls]     extra classes
   */
  function wrow(r) {
    const code = r.code ? esc(r.code) : '';
    const inner =
      `<span class="id">${code}</span>` +
      `<span class="mid"><p class="rt">` +
        (code ? `<span class="rcode">${code}</span>` : '') +
        esc(r.title) +
      `</p>` +
      (r.detail ? `<p class="s">${r.detail}</p>` : '') +
      `</span>` +
      (r.chip   ? `<span class="stc">${r.chip}</span>` : '') +
      (r.days   ? `<span class="days">${r.days}</span>` : '') +
      (r.amount ? `<span class="amt n">${r.amount}</span>` : '') +
      (r.action ? `<span class="actc${r.actionIsText ? ' s' : ''}">${r.action}</span>` : '');

    /* `hascode` is what lets the stylesheet swap the two. It is a class rather
       than `:has(.rcode)` because `.id` is not always a villa code: elsewhere
       it carries a radio button, a status chip or a stage code, and a blanket
       rule would hide those. Only a row that genuinely has both forms of the
       same code may drop one of them. */
    const cls = 'wrow' + (code ? ' hascode' : '') + (r.cls ? ' ' + r.cls : '');
    return r.href
      ? `<a class="${cls}" href="${r.href}" style="text-decoration:none;color:inherit">${inner}</a>`
      : `<div class="${cls}">${inner}</div>`;
  }

  /** The column headings, for the desktop table only. */
  function whead(cols) {
    return `<div class="whead">` +
      `<span class="id">${esc(cols[0] || 'Villa')}</span>` +
      `<span class="mid">${esc(cols[1] || '')}</span>` +
      `<span class="stc">${esc(cols[2] || '')}</span>` +
      `<span class="days">${esc(cols[3] || '')}</span>` +
      `<span class="amt">${esc(cols[4] || '')}</span>` +
      `<span class="actc">${esc(cols[5] || '')}</span></div>`;
  }

  /** An empty list says why it is empty rather than showing nothing at all. */
  const empty = why => `<div class="emptyrow"><p class="b ink">${esc(why)}</p></div>`;

  return { wrow, whead, empty };
};
