'use strict';
/* ============================================================================
   The furniture every dashboard is built from.

   ONE PLATFORM, THREE DASHBOARDS. The buyer, the engineer and the head office
   are not three products; they are three views of one file, and they have to
   look like it. Before this file there were eleven places drawing the same
   header - two copies of a `hero` helper and nine hand-written `.mhead` blocks
   - so "the summary" meant something slightly different on every screen and a
   change to it had to be made eleven times and remembered a twelfth.

   WHAT A DASHBOARD OWES ITS READER, and what these pieces are for:

     1. What is happening. `summary()` is the first thing on every screen: the
        figure that matters, what it is made of, and how far along it is. Not a
        number and a sentence - a number, its parts, and a bar.

     2. What needs doing, at a glance. `stats()` is the tile grid. Four numbers
        big enough to read without stopping, each one a link to the screen that
        holds it.

     3. What to do about it. That is the worklist, and it comes third.

   AND URGENCY HAS TO BE VISIBLE. Every number here takes a `tone`, and tone is
   not decoration: `hot` means somebody is waiting past the point where waiting
   is acceptable, `warn` means they are getting there. A screen where a stuck
   crore and a settled stage are the same weight of grey is a screen where the
   crore gets scrolled past, which is what happened.

   The thresholds are the ones in ./rows, because a day count on a card and a
   figure in a summary must not disagree about what late means.
   ========================================================================= */

module.exports = function ui({ esc }) {

  const { AGE } = require('./rows')({ esc });

  /** The three weights a figure can carry, and nothing else. */
  const TONES = new Set(['hot', 'warn', 'ok']);
  const toneClass = t => (TONES.has(t) ? ' ' + t : '');

  /**
   * How old is too old, as a tone rather than as a number.
   * The same thresholds the day-count pills use, so a summary and the rows
   * under it never disagree about which of them is late.
   */
  const ageTone = n =>
    n == null ? null : n >= AGE.overdue ? 'hot' : n >= AGE.ageing ? 'warn' : null;

  /** A count is hot when there is any of it and it is somebody waiting. */
  const countTone = (n, waiting) => (n > 0 && waiting ? 'hot' : n > 0 ? 'warn' : null);

  // ------------------------------------------------------------------- head

  /**
   * The page title and its one sentence. Every screen, every role.
   * @param {string} title
   * @param {string} sub    pre-escaped: callers build it from several fields
   * @param {{href,label}} [back]  the way out of a screen that sits behind a
   *                        destination rather than being one. In the header
   *                        rather than the body, because a Back that scrolls
   *                        away is a Back nobody finds.
   * @param {string} extra  the summary card, the tiles, or both - they belong
   *                        to the header rather than to the body, so the
   *                        gutter and the ground behind them come from one
   *                        container instead of from each screen.
   */
  const head = (title, sub, extra, back) => `
<div class="mhead"><div class="hstrip"><div class="g">
<h1 class="pgt">${esc(title)}</h1>
${sub ? `<p class="s" style="margin-top:2px">${sub}</p>` : ''}
</div>${back ? `<div class="kpi"><a class="wbtn st" href="${back.href}"
 style="text-decoration:none">${esc(back.label || 'Back')}</a></div>` : ''}
</div>${extra || ''}</div>`;

  // ---------------------------------------------------------------- summary

  /**
   * What is happening, as the first thing on the screen.
   *
   * @param {object} o
   * @param {string} o.cap     the small-caps label above the figure
   * @param {string} o.figure  the figure itself, already formatted
   * @param {string} [o.tone]  hot | warn | ok - what weight it carries
   * @param {string} [o.note]  the sentence under it, pre-escaped
   * @param {{cap,value,tone}[]} [o.parts]  what the figure is made of
   * @param {{pct,left,right}} [o.bar]      how far along it is
   */
  function summary(o) {
    const parts = (o.parts || []).filter(Boolean).map(p => `
<div class="part"><p class="cap">${esc(p.cap)}</p>
<p class="v${toneClass(p.tone)}">${p.value}</p></div>`).join('');

    /* `.prog`, not `.bar`. v21 uses `.bar` for the prototype's own chrome and
       this application hides it outright, so a progress bar called that would
       have been `display: none` on every screen. The shell test caught it. */
    const bar = o.bar ? `
<div class="prog"><i style="--pct:${Math.max(0, Math.min(100, o.bar.pct))}%"></i></div>
<div class="progline"><span>${o.bar.left || ''}</span><span>${o.bar.right || ''}</span></div>` : '';

    return `<div class="summary">
<p class="cap">${esc(o.cap)}</p>
<p class="fig${toneClass(o.tone)}">${o.figure}</p>
${o.note ? `<p class="note">${o.note}</p>` : ''}
${parts ? `<div class="split">${parts}</div>` : ''}
${bar}
</div>`;
  }

  // ------------------------------------------------------------------ stats

  /**
   * The tile grid: four numbers big enough to read without stopping.
   *
   * Each tile is a link, because a number nobody can act on is a number that
   * gets ignored. Two columns on a phone, four above it.
   *
   * @param {{n,label,sub,tone,href}[]} tiles
   */
  function stats(tiles) {
    const body = tiles.filter(Boolean).map(t => {
      const inner = `<p class="n${toneClass(t.tone)}">${esc(String(t.n))}</p>
<p class="l">${esc(t.label)}</p>
${t.sub ? `<p class="s">${esc(t.sub)}</p>` : ''}`;
      return t.href
        ? `<a class="stat" href="${t.href}" style="text-decoration:none">${inner}</a>`
        : `<div class="stat">${inner}</div>`;
    }).join('');
    return `<div class="stats">${body}</div>`;
  }

  // --------------------------------------------------------------- sections

  /**
   * A titled list. The heading is the top of the card and the rows sit inside
   * it - joined in the stylesheet, from this markup, on every screen.
   */
  const section = (label, body) =>
    `<div class="blk"><p class="k">${esc(label)}</p></div><div class="wl">${body}</div>`;

  /** The line that reports what just happened, after a write. */
  const flash = m => m
    ? `<div class="tools"><span class="rescount s">${esc(m)}</span><div class="g"></div></div>` : '';

  return { head, summary, stats, section, flash, ageTone, countTone, AGE };
};
