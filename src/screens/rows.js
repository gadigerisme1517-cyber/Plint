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

  /* How old is too old.
     These are the thresholds the head office's Stuck money worklist has always
     used to colour a row, and they are the only ones in the application. A
     day count with no verdict beside it is a number the reader has to score
     for themselves, and they will score it differently from the screen that
     decides what is late - so every age is put through here. */
  const AGE = { overdue: 21, ageing: 10 };

  /**
   * A pill that says what a day count means, not just what it is.
   * @param {number} n     days
   * @param {string[]} [words]  what to call each band. The thresholds and the
   *                            colours never vary; only the vocabulary does,
   *                            because "on time" is right for a photograph and
   *                            "Open" is right for money that is stuck.
   */
  /** The same three bands, as a class for colouring a bare number. */
  const ageClass = n =>
    n >= AGE.overdue ? 'age-late' : n >= AGE.ageing ? 'age-warn' : 'age-ok';

  function ageChip(n, words) {
    const [ok, mid, bad] = words || ['on time', 'ageing', 'overdue'];
    if (n == null) return `<i class="chip idle">no date</i>`;
    const cls = n >= AGE.overdue ? 'late' : n >= AGE.ageing ? 'warn' : 'wait';
    const word = n >= AGE.overdue ? bad : n >= AGE.ageing ? mid : ok;
    return `<i class="chip ${cls}">${esc(word)}</i>`;
  }


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
      /* A day count is never shown bare. Where the pill's job is the age, it
         carries the word ("on time" / "ageing" / "overdue"). Where the pill
         already means something else - "ready", "0 photos", "Chased" - the
         number itself is coloured on the same thresholds, so the reader is
         never left to score a figure the screen has already scored. */
      (r.days   ? `<span class="days${r.daysAge == null ? '' : ' ' + ageClass(r.daysAge)}">${r.days}</span>` : '') +
      (r.amount ? `<span class="amt n">${r.amount}</span>` : '') +
      (r.action ? `<span class="actc${r.actionIsText ? ' s' : ''}${r.actionWide ? ' wide' : ''}">${r.action}</span>` : '');

    /* `hascode` is what lets the stylesheet swap the two. It is a class rather
       than `:has(.rcode)` because `.id` is not always a villa code: elsewhere
       it carries a radio button, a status chip or a stage code, and a blanket
       rule would hide those. Only a row that genuinely has both forms of the
       same code may drop one of them. */
    /* An amount with no control beside it had a whole row to itself, with
       nothing in the other two columns - a wasted line on every row of a
       list. Where there is no action the money moves up beside the detail. */
    const noact = r.amount && !r.action ? ' noact' : '';
    const cls = 'wrow' + (code ? ' hascode' : '') + noact + (r.cls ? ' ' + r.cls : '');
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

  return { wrow, whead, empty, ageChip, AGE };
};
