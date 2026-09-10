'use strict';
/* ============================================================================
   THE DESIGN SYSTEM, ONCE, FOR THE WHOLE PRODUCT.

   Plint had two visual systems. The head office was rebuilt on
   inbell_office_dashboard.html - Manrope over Inter, twenty-one tokens, an
   unconditional card - and the buyer and the engineer were left on v21:
   plint.css plus app.css, 1,987 lines producing less structure than the office
   gets from 181. The audit measured why, and every number in it comes back to
   the same four facts:

     - there was no card below 721px. `--card-shadow: none` at the root and a
       redefinition inside a media query meant a phone got hairlines on white.
     - there was no bold. 131 font-weight declarations across those two
       stylesheets, one at 700, none at 800.
     - there was one typeface, so a heading and a sentence differed only by
       size.
     - the body colour was `--ink-2`, a mid slate, and every label was
       `--ink-3` at 3.15:1 on white, which fails contrast at the 12px it was
       used at.

   This file is the office system's markup, extracted from src/screens/office.js
   where it was written, so that all three roles are built from it. Nothing here
   invents a component: where a screen needs something the reference does not
   have - a timeline, a photograph grid, a definition list, a form field - it is
   built out of the reference's own classes and tokens, and the stylesheet rule
   that supports it lives in public/office.css under a marked ADDED block.

   v15 and v21 are archaeology. They are read for WHAT a screen was meant to
   contain and never for how it should look.
   ========================================================================= */

module.exports = function kit({ esc }) {

  // ------------------------------------------------------------------ icons

  /* The reference's own icon set. Nothing new is drawn: each caller picks the
     shape from this set which says what it is. */
  const I = {
    home: '<path d="M3 10l9-7 9 7v10a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z"/>',
    growth: '<path d="M4 19V5M4 19h16M8 15l3-4 3 3 4-6"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0112 0M16 6a3 3 0 010 6M21 20a6 6 0 00-4-5.6"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
    money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    attend: '<path d="M20 6L9 17l-5-5"/>',
    exam: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    comms: '<path d="M4 5h16v11H8l-4 4z"/>',
    report: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    event: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 15h3"/>',
    bell: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0"/>',
    hr: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0114 0"/>',
    cert: '<circle cx="12" cy="9" r="5"/><path d="M9 13l-1.5 7L12 18l4.5 2L15 13"/>',
    hostel: '<path d="M3 21V8l9-5 9 5v13M9 21v-6h6v6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    risk: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    cockpit: '<circle cx="12" cy="12" r="9"/><path d="M12 12l5-3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
    /* Added for the two surfaces this system now also draws. Same stroke, same
       24-box, same vocabulary. */
    cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="12.5" r="3.5"/>',
    path: '<path d="M6 3v8a4 4 0 004 4h4"/><circle cx="6" cy="3" r="1.6"/><circle cx="18" cy="15" r="2.4"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    fwd: '<path d="M9 6l6 6-6 6"/>',
    tick: '<path d="M20 6L9 17l-5-5"/>',
  };
  const ic = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none">${I[n] || I.report}</svg>`;

  // ----------------------------------------------------------------- ageing

  /* How old is too old. The only thresholds in the application: a day count on
     a card and a figure in a header must not disagree about what late means. */
  const AGE = { overdue: 21, ageing: 10 };

  /**
   * A day count that is a verdict, not just a number.
   *
   * WHAT `settled` IS FOR. An age is only a verdict while somebody is still
   * waiting for the thing it counts. The audit found 98d printed in red beside
   * a green "Done" on the agreement, 51d beside "Seen" on the papers, 21d for
   * a lender's advertised release window on the bank list and 175d on a stage
   * that was paid and closed. A finished row passes `settled` and gets the
   * figure in plain ink; nothing else may colour it.
   */
  const age = (n, settled) => {
    if (n == null) return '';
    const cls = settled ? 'a-done' : n >= AGE.overdue ? 'a-late'
      : n >= AGE.ageing ? 'a-warn' : 'a-ok';
    return `<span class="agev ${cls} num">${esc(String(n))}d</span>`;
  };

  /** The same three bands as a pill, where the age is what the row is about. */
  const agePill = (n, words) => {
    const [ok, mid, bad] = words || ['On time', 'Ageing', 'Overdue'];
    if (n == null) return pill('grey', 'No date');
    return n >= AGE.overdue ? pill('over', bad)
      : n >= AGE.ageing ? pill('due', mid) : pill('accent', ok);
  };

  // ---------------------------------------------------------------- helpers

  /** The page's title, its one sentence, and the controls that belong to it. */
  const head = (t, s, acts = '') =>
    `<div class="head"><div><div class="h1">${esc(t)}</div>`
    + `${s ? `<div class="hsub">${s}</div>` : ''}</div>`
    + `${acts ? `<div class="hacts">${acts}</div>` : ''}</div>`;

  /**
   * The reference's KPI strip.
   *
   * NO DEAD SPACE. The reference's `.kpis` is `repeat(4, 1fr)` because its
   * dashboard has four. Twelve of the buyer's thirteen screens opened with a
   * 1170x100 card holding one figure and 800px of white; a screen with two
   * things worth saying now gets two tiles across the full width, and a screen
   * with one thing worth saying gets no strip at all - the figure goes in the
   * sentence under the title, where a single number belongs.
   */
  const kpis = arr => {
    const live = arr.filter(Boolean);
    if (!live.length) return '';
    /* A class, not an inline `grid-template-columns`: an inline style beats a
       media query, so a four-tile strip written inline would stay four across
       at 375 and each tile would be 80px wide. */
    const n = Math.min(live.length, 4);
    return `<div class="kpis k${n}">`
      + live.map(k => {
        const inner = `<div class="kl">${ic(k.icon)} ${esc(k.l)}</div>`
          + `<b class="num${k.tone ? ' t-' + k.tone : ''}">${k.v}</b>`
          + `<div class="kn">${esc(k.n || '')}</div>`;
        return k.href ? `<a class="kpi" href="${k.href}">${inner}</a>`
                      : `<div class="kpi">${inner}</div>`;
      }).join('') + '</div>';
  };

  const P = { paid: 'p-paid', due: 'p-due', over: 'p-over', accent: 'p-accent', grey: 'p-grey' };
  /* What the five pills mean, product-wide, and nothing else may use them:
       paid   - done, disbursed, certified, signed
       due    - waiting on somebody
       over   - late, refused, or a query
       accent - informational
       grey   - not started, not needed                                       */
  const pill = (kind, text) => `<span class="pill ${P[kind] || P.grey}">${esc(text)}</span>`;

  const btn = (label, o = {}) => {
    const inner = (o.icon ? ic(o.icon) : '') + ' ' + esc(label);
    const cls = 'btn' + (o.dark ? ' dark' : '') + (o.cls ? ' ' + o.cls : '');
    if (o.href) return `<a class="${cls}" href="${o.href}">${inner}</a>`;
    if (o.post) {
      return `<form method="post" action="${o.post}">`
        + Object.entries(o.fields || {}).map(([k, v]) =>
          `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('')
        + `<button class="${cls}" type="submit">${inner}</button></form>`;
    }
    return `<button class="${cls}" type="button">${inner}</button>`;
  };

  /** A write on a row: one form, one hidden field per value, one button. */
  const act = (action, fields, label, o = {}) =>
    `<form method="post" action="${action}">`
    + Object.entries(fields).map(([k, v]) =>
      `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('')
    + `<button class="btn${o.plain ? '' : ' dark'}" type="submit">`
    + (o.icon ? ic(o.icon) : '') + ' ' + esc(label) + '</button></form>';

  /**
   * The reference's table. `rows` are arrays of cells already rendered; `tmpl`
   * is the grid template every row carries inline, exactly as there.
   *
   * @param {object} [o] o.href(i) makes the row a link, o.tags(i) lets the
   *                     filter chips above it narrow the list, o.min is the
   *                     width below which the table scrolls sideways instead
   *                     of crushing its middle column.
   */
  /* BELOW 561px A ROW IS A BLOCK AND THE HEADER COMES OFF, so a cell carries
     the name of its own column. Without it the buyer's demand list read
     "22d" and the office register read "5 / 10" with nothing saying what
     either number was - eight of the thirty screenshots this pass showed a
     stacked figure with no name against it. The label is written once here
     and shown only by the phone rule in office.css.

     Not on the first cell, which is the row's own name, and not on a cell
     holding a control: "ACTION Review" reads worse than "Review". */
  const lab = (cols, j, cell) =>
    j > 0 && cols[j] && !/^(action|answer)$/i.test(cols[j]) && !/<(form|button)\b/.test(cell)
      ? ` data-l="${esc(cols[j])}"` : '';

  function table(cols, rows, tmpl, o = {}) {
    const gt = `grid-template-columns:${tmpl}`;
    const min = o.min === 0 ? '' : ` style="--tmin:${o.min || 620}px"`;
    const hd = `<div class="tr hd" style="${gt}">`
      + cols.map(c => `<div>${esc(c)}</div>`).join('') + '</div>';
    if (!rows.length) {
      return `<div class="tbl"${min}>${hd}${empty(o.empty || 'Nothing here.', o.out)}</div>`;
    }
    return `<div class="tbl"${o.id ? ` id="${o.id}"` : ''}${min}>${hd}`
      /* A list filtered down to nothing says what to try instead. Without it
         the header sits over a blank, which reads as a broken screen. */
      + (o.tags ? `<div class="empty filtered-empty" hidden>${esc(o.noneMatch
        || 'Nothing here matches those filters.')}<div style="margin-top:12px">`
        + `<button class="btn" type="button" data-clear="${o.id}">Clear filters</button></div></div>` : '')
      + rows.map((r, i) => {
        const tags = o.tags ? ` data-tags="${esc(o.tags(i))}"` : '';
        const cells = r.map((c, j) => `<div${lab(cols, j, c)}>${c}</div>`).join('');
        return o.href
          ? `<a class="tr click" style="${gt}"${tags} href="${o.href(i)}">${cells}</a>`
          : `<div class="tr" style="${gt}"${tags}>${cells}</div>`;
      }).join('') + '</div>';
  }

  /**
   * One bar of chips, asking one question. A screen may carry several and they
   * combine: a row shows only when every bar either says All or matches it.
   */
  const filters = (scope, opts) =>
    `<div class="filters" data-scope="${scope}">${opts.map((o, i) =>
      `<button class="chip ${i === 0 ? 'on' : ''}" data-filter="${esc(o[1])}" type="button">`
      + `${esc(o[0])}</button>`).join('')}</div>`;

  /* A search box. Only where a list is long enough that scanning it is the
     problem. It reads the row's own text, so it searches what the reader can
     see rather than a field somebody decided was searchable. */
  const search = (scope, hint) =>
    `<input class="chip srch" type="search" data-search="${scope}" placeholder="${esc(hint)}">`;

  /* The count is rendered by the server with the real number in it, so a
     reader with JavaScript off is not shown a line saying "0 villas" over
     forty-eight rows. The browser updates it while filtering. */
  const showing = (scope, what, total) =>
    `<div class="hsub fcount" data-count="${scope}">`
    + `<span><span class="fnum">${total == null ? '' : total}</span> ${esc(what)}</span>`
    + `<button class="chip" type="button" data-clear="${scope}" hidden>Clear filters</button></div>`;

  /**
   * A card, with its heading INSIDE it.
   *
   * The audit's fifth finding: on the buyer's and the engineer's screens a
   * section title was a 12px `--ink-3` whisper floating on the page ground
   * above a borderless list. Here it is `.ch`/`.ct` - Manrope 700, inside the
   * card's own top edge - which is where the office has always put it.
   */
  const card = (title, body, acts = '') =>
    `<div class="card">${title ? `<div class="ch"><div class="ct">${esc(title)}</div>${acts}</div>` : ''}`
    + `<div class="cb">${body}</div></div>`;

  /** A table with its own heading above it, as one object.

      An empty state is wrapped in a surface of its own. It used to be handed
      through bare, so a section with nothing in it - the villa's Handover
      before possession is scheduled - was a sentence floating on the page
      ground under a heading, which is the shape this whole pass exists to end. */
  const titled = (title, body, acts = '') =>
    `<div class="sect">${title ? `<div class="secth"><div class="ct">${esc(title)}</div>`
      + `${acts ? `<div class="hacts">${acts}</div>` : ''}</div>` : ''}`
    + (/^\s*<div class="empty"/.test(body) ? `<div class="card">${body}</div>` : body)
    + `</div>`;

  const row = (icon, title, sub, right = '') =>
    `<div class="row"><div class="rico">${ic(icon)}</div>`
    + `<div class="rt"><b>${esc(title)}</b>${sub ? `<span>${sub}</span>` : ''}</div>`
    + `${right}</div>`;

  /**
   * A definition list: a label and a value, and nothing between them.
   *
   * This replaces the worklist row that was being used for key-and-value work
   * on the villa, the loan and the certificate. That row reserved a 58px first
   * column for a villa code whether or not the row had one, so every one of
   * those screens carried a visible empty gutter down its left edge, and it
   * right-aligned the value into a narrow column with 900px of nothing in the
   * middle. Two cells, declared here, and no ghost column anywhere.
   */
  const dl = pairs => `<div class="dl">${pairs.filter(Boolean).map(([k, v, o]) =>
    `<div class="dlr"><span class="dlk">${esc(k)}</span>`
    + `<span class="dlv${o && o.tone ? ' t-' + o.tone : ''}">${v}</span></div>`).join('')}</div>`;

  const note = t => `<div class="note">${t}</div>`;

  /* An empty list is a real state: it says why it is empty, and what to do
     instead. A screen with nothing on it and no way off it is a dead end
     however true its sentence is. */
  const empty = (t, out) => `<div class="empty">${esc(t)}`
    + (out ? `<div style="margin-top:12px"><a class="btn" href="${out.href}">${esc(out.label)}</a></div>` : '')
    + `</div>`;

  const board = cols => `<div class="board">${cols.map(c =>
    `<div class="col"><div class="colh"><span class="ctt">${esc(c.label)}</span>`
    + `<span class="cnt">${c.cards.length}</span></div>`
    + (c.note ? `<div class="ls" style="padding:0 5px 8px">${c.note}</div>` : '')
    + (c.cards.length ? c.cards.map(k =>
      `<a class="lcard" href="${k.href}"><b>${esc(k.title)}</b>`
      + `<div class="ls">${esc(k.sub)}</div>`
      + (k.tags ? `<div class="lt">${k.tags}</div>` : '') + '</a>').join('')
      : `<div class="ls" style="padding:6px 5px">Nothing here.</div>`)
    + '</div>').join('')}</div>`;

  /* A villa in a table cell. `href` makes the name itself the link, for tables
     whose rows carry an action: a form inside an anchor is not valid HTML and
     the browser will not submit it, so those rows are not links. */
  const initials = n => String(n || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const who = (name, sub, href) =>
    `<div class="cellav"><div class="miniav">${esc(initials(name))}</div>`
    + `<div class="who"><b>${href ? `<a href="${href}">${esc(name)}</a>` : esc(name)}</b>`
    + `${sub ? `<span>${sub}</span>` : ''}</div></div>`;
  const num = t => `<span class="num">${esc(t)}</span>`;
  const tagOf = v => String(v || 'none').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const ageBand = d => (d <= 7 ? 'age-week' : d <= 14 ? 'age-fortnight' : 'age-over');

  // ------------------------------------------------------------- the timeline

  /**
   * A RUN OF POINTS ALONG A LINE, FILLED IN AS THE WORK IS DONE.
   *
   * Both prototypes drew the buyer's journey this way and no line of server
   * code has ever emitted it: `.jline`, `.jstep` and `.jdot` have shipped
   * unused in plint.css since the first commit. This is not a restoration, it
   * is the thing that was always meant to be there, built in this system's
   * tokens rather than by resurrecting that stylesheet.
   *
   * A done step is filled `--green` and carries a white tick, so it reads as
   * done from across a room rather than as a tint. The step in hand is ringed
   * in the accent with a halo, so it is distinct from both done and not-yet.
   * A step not yet reached is a hollow hairline circle at 55% - visibly
   * quieter without being unreadable.
   *
   * @param {{name,detail,state,href,right,tag}[]} steps  state: done|now|wait
   */
  function timeline(steps) {
    const done = steps.filter(s => s.state === 'done').length;
    /* The line fills to the last dot that is done, so the fill ends ON a point
       rather than floating between two. */
    const pct = steps.length < 2 ? 0
      : Math.max(0, Math.min(100, ((done - (done === steps.length ? 0 : 0)) / (steps.length - 1)) * 100));
    const dot = s => `<span class="tld">${s.state === 'done' ? ic('tick') : ''}</span>`;
    return `<div class="tl"><i class="tlfill" style="height:${pct.toFixed(2)}%"></i>`
      + steps.map(s => {
        const inner = dot(s)
          + `<span class="tlb"><span class="tlt">${esc(s.name)}`
          + (s.tag ? ` ${s.tag}` : '') + `</span>`
          + (s.detail ? `<span class="tls-d">${s.detail}</span>` : '') + `</span>`
          + (s.right ? `<span class="tlr">${s.right}</span>` : '')
          + (s.href ? `<span class="tlgo">${ic('fwd')}</span>` : '');
        return s.href
          ? `<a class="tls ${s.state} click" href="${s.href}">${inner}</a>`
          : `<div class="tls ${s.state}">${inner}</div>`;
      }).join('') + '</div>';
  }

  // ---------------------------------------------------------- the photographs

  /**
   * THE PHOTOGRAPHS, AS PHOTOGRAPHS.
   *
   * `grep -rn "<img" src/` returned one hit before this function existed, and
   * it was inside a comment. The evidence route served the real bytes, the
   * isolation was tested, the thumbnail cache was built and the PDF embedded
   * them - and no screen in a product about photographic evidence displayed
   * one. They were rows of text reading "Stage photograph 1 · 12.8391,
   * 77.7724".
   *
   * The tile links to the full image, so tapping one opens it larger with the
   * browser's own viewer and the back button. Both URLs are read through
   * row-level security in the asking session, so the isolation that was true
   * of the text is exactly as true of the image.
   *
   * @param {{sha256,caption,when,gps}[]} shots
   */
  const photos = (shots, whenEmpty) => shots.length
    ? `<div class="phg">${shots.map(s => `<a class="ph" href="/evidence/${esc(s.sha256)}">`
      + `<img src="/evidence/${esc(s.sha256)}/thumb" alt="${esc(s.caption || 'Site photograph')}"`
      + ` loading="lazy" width="320" height="240">`
      + `<span class="phc"><b>${esc(s.caption || 'Site photograph')}</b>`
      + `<span>${esc(s.when || '')}${s.gps ? ' &middot; ' + esc(s.gps) : ''}</span></span></a>`).join('')}</div>`
    : empty(whenEmpty || 'No photographs yet.');

  // ------------------------------------------------------------ a conversation

  /**
   * A thread of messages, as a conversation. The message is the content and
   * everything else is a caption; mine and theirs are told apart by side and
   * by ground rather than by a label.
   *
   * It is NOT a 280px scroll box any more. That height came from the prototype,
   * where the thread lived inside an 830px phone frame; in the product it is a
   * page, and at 375 the box was 280px tall over 345px of content, so the
   * buyer's own first question was scrolled out of sight inside a nested
   * scroller on a page that already scrolled.
   */
  function talk(msgs, whenEmpty) {
    if (!msgs.length) return `<div class="thread"><div class="empty">${esc(whenEmpty)}</div></div>`;
    return `<div class="thread">${msgs.map(m => `
<div class="msg ${m.mine ? 'me' : 'them'}">
<p>${esc(m.body)}</p><span class="msgw">${esc(m.who)}${m.when ? ' &middot; ' + esc(m.when) : ''}</span>
</div>`).join('')}</div>`;
  }

  // --------------------------------------------------------------- the form

  /* THE NATIVE CONTROLS, STYLED.
     A `<select>`, an `<input type="file">` and an `<input type="date">` arrive
     with the browser's own chrome, and the audit found all three sitting among
     custom components - the file input clipped mid-word at "No fil...hosen".
     These wrap them in the reference's `.chip` shape so a form on a buyer
     screen is made of the same objects as the page around it. */
  const field = (label, control, o = {}) =>
    `<label class="fld${o.wide ? ' wide' : ''}">`
    + (label ? `<span class="fll">${esc(label)}</span>` : '') + control + `</label>`;

  const input = (name, o = {}) =>
    `<input class="fi" name="${esc(name)}" type="${o.type || 'text'}"`
    + (o.value != null ? ` value="${esc(String(o.value))}"` : '')
    + (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : '')
    + (o.required ? ' required' : '') + (o.max ? ` maxlength="${o.max}"` : '')
    + (o.min ? ` min="${esc(o.min)}"` : '') + (o.accept ? ` accept="${esc(o.accept)}"` : '')
    + (o.inputmode ? ` inputmode="${esc(o.inputmode)}"` : '') + '>';

  const select = (name, opts, o = {}) =>
    `<span class="fsel"><select class="fi" name="${esc(name)}"${o.required ? ' required' : ''}>`
    + opts.map(([v, l]) => `<option value="${esc(v)}"${o.value === v ? ' selected' : ''}>${esc(l)}</option>`).join('')
    + `</select>${ic('fwd', 'fselgo')}</span>`;

  /* A file input cannot be restyled, so it is hidden behind its own label and
     the label is a button. The file's name is written back by the shell's
     script; with no script the input is still reachable and still submits. */
  const file = (name, o = {}) =>
    `<span class="ffile"><input class="ffi" type="file" name="${esc(name)}" id="${esc(o.id)}"`
    + ` accept="${esc(o.accept || 'image/jpeg,image/png')}"${o.required ? ' required' : ''}>`
    + `<label class="btn" for="${esc(o.id)}">${ic('cam')} ${esc(o.label || 'Choose a photograph')}</label>`
    + `<span class="ffn" data-for="${esc(o.id)}">No file chosen</span></span>`;

  /** A row of fields that posts. The one shape every write on these screens uses. */
  /* `o.q` marks a form the engineer's outbox may hold when the write does not
     reach the office - see public/queue.js. `o.ql` is what the outbox calls
     it on screen, so a queued row says "A-01 · Blockwork" rather than "a
     write". With no script both attributes are inert and the form posts. */
  const form = (action, inner, o = {}) =>
    `<form class="frm" method="post" action="${action}"`
    + (o.q ? ` data-q="${esc(o.q)}" data-ql="${esc(o.ql || '')}"` : '')
    + (o.upload ? ' enctype="multipart/form-data"' : '') + '>'
    + Object.entries(o.fields || {}).map(([k, v]) =>
      `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('')
    + inner + `<button class="btn${o.plain ? '' : ' dark'}" type="submit">`
    + (o.icon ? ic(o.icon) : '') + ' ' + esc(o.submit || 'Save') + '</button></form>';


  /* ---------------------------------------------------------------- notices

     WHAT SOMEBODY ELSE DID THAT THIS PERSON HAS TO KNOW ABOUT.

     `notifications` has existed since migration 012 with a policy, an insert
     path and TWO LIVE WRITERS - the engineer reporting a delay, and the office
     asking a quiet site for a photograph - and no reader anywhere in the
     product. Both of those writers tell the person pressing the button that
     somebody will see it. Neither statement was true.

     One component, drawn in this system, used by all three roles. Severity is
     the pill vocabulary already agreed: `hot` is late or refused, `warn` is
     waiting on somebody, `ok` is informational. */
  const SEV = { hot: ['over', 'Needs you'], warn: ['due', 'Waiting'], ok: ['accent', 'For information'] };

  const notices = (rows, o = {}) => rows.length
    ? `<div class="ntl">${rows.map(n => {
        const [tone, word] = SEV[n.severity] || SEV.ok;
        return `<div class="nt${n.read_at ? ' ntread' : ''}">`
          + `<div class="nthd">${pill(tone, word)}`
          + `<b>${esc(n.title)}</b>`
          + `<span class="hsub">${esc(n.when || '')}</span></div>`
          + (n.detail ? `<p class="hsub ntd">${esc(n.detail)}</p>` : '')
          + (n.href || !n.read_at
            ? `<div class="nta">`
              + (n.href ? `<a class="btn" href="${n.href}">${esc(n.hrefLabel || 'Open it')}</a>` : '')
              + (n.read_at ? '' : act(o.readAt || '#', { id: n.id }, 'Mark it read', { plain: true }))
              + `</div>`
            : '')
          + `</div>`;
      }).join('')}</div>`
    : empty(o.empty || 'Nothing new. This is where you are told what somebody else did.');

  /* The line that reports what the last write did, for a screen that renders
     it in the body rather than as the shell's toast. */
  const flash = m => (m ? `<div class="note flash">${esc(m)}</div>` : '');

  return {
    I, ic, AGE, age, agePill,
    head, kpis, pill, btn, act, table, filters, search, showing,
    card, titled, row, dl, note, empty, board, who, initials, num, tagOf, ageBand,
    timeline, photos, talk, field, input, select, file, form, flash, notices,
  };
};
