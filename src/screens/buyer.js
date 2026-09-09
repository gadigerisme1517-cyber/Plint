'use strict';
/* ============================================================================
   THE BUYER'S SCREENS.

   Thirteen screens: the journey, one stage, the villa, a site visit, the money,
   everything else, the bank, the loan, the agreement, the interior choices, the
   papers the bank will ask for, the questions, and one question's thread.

   THE SYSTEM. These were v21's - plint.css plus app.css, a phone mock widened
   into an application. They are now the product's one system, from
   inbell_office_dashboard.html, drawn out of src/screens/kit.js exactly as the
   head office is. Nothing in this file draws a component of its own.

   WHAT THIS FILE MAY NOT DO. It reads. The only writes a buyer has are: ask for
   a visit, pick a lender, sign an interior choice, ask a question and reply on
   a thread - and each of those is a form that POSTs to a route in server.js and
   redirects. No money is priced here, no demand is raised here, and nothing on
   these screens can move a rupee.

   WHAT A BUYER SEES IS BOUNDED BY ROW-LEVEL SECURITY, not by this file. Every
   read runs in the buyer's own database role, so a villa that is not theirs
   returns no rows rather than being filtered out afterwards.
   ========================================================================= */

module.exports = function buyerScreens(ctx) {
  const { esc, desk, M, asUser } = ctx;

  /* The design system, once, for the whole product. */
  const K = require('./kit')({ esc });
  const {
    head, kpis, pill, btn, table, card, titled, dl, note, empty, timeline, photos,
    talk, field, input, select, file, form, age, agePill, num, AGE,
  } = K;

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  const until = d => Math.round((new Date(d).getTime() - Date.now()) / 86400000);

  // ------------------------------------------------------------------ reads

  /** Everything the screens need, in one round trip. */
  async function load(sess) {
    return asUser(sess, async c => {
      const u = (await c.query('SELECT * FROM units WHERE code = $1', [sess.unit])).rows[0];
      if (!u) return null;

      const stages = (await c.query(
        `SELECT s.*, t.name, t.pct_bp, t.description, t.seq
           FROM unit_stages s JOIN stage_templates t
             ON t.code = s.stage_code AND t.project_id = $2
          WHERE s.unit_id = $1 ORDER BY t.seq`, [u.id, u.project_id])).rows;

      const demands = (await c.query(
        `SELECT d.*, s.stage_code FROM demands d
           JOIN unit_stages s ON s.id = d.unit_stage_id
          WHERE s.unit_id = $1 ORDER BY d.raised_at`, [u.id])).rows;

      const evidence = (await c.query(
        `SELECT e.*, s.stage_code FROM evidence e
           JOIN unit_stages s ON s.id = e.unit_stage_id
          WHERE s.unit_id = $1 ORDER BY e.taken_at DESC`, [u.id])).rows;

      const visits = (await c.query(
        `SELECT v.*, w.display_name engineer_name
           FROM visits v LEFT JOIN users w ON w.id = v.engineer_id
          WHERE v.unit_id = $1 ORDER BY v.slot_at DESC`, [u.id])).rows;

      const queries = (await c.query(
        `SELECT q.*,
                (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies,
                (SELECT max(m.sent_at) FROM query_messages m WHERE m.query_id = q.id) last_at
           FROM queries q WHERE q.unit_id = $1 ORDER BY q.raised_at DESC`, [u.id])).rows;

      const choices = (await c.query(
        'SELECT * FROM choices WHERE unit_id = $1 ORDER BY needed_by', [u.id])).rows;

      const agreement = (await c.query(
        'SELECT * FROM agreements WHERE unit_id = $1', [u.id])).rows[0] || null;

      const possession = (await c.query(
        'SELECT * FROM possessions WHERE unit_id = $1', [u.id])).rows[0] || null;

      const lenders = (await c.query('SELECT * FROM lenders ORDER BY seq')).rows;

      const applicants = (await c.query(
        'SELECT * FROM loan_applicants WHERE unit_id = $1 ORDER BY seq', [u.id])).rows;

      const papers = applicants.length ? (await c.query(
        `SELECT * FROM loan_documents WHERE applicant_id = ANY($1) ORDER BY applicant_id, seq`,
        [applicants.map(a => a.id)])).rows : [];

      const snags = (await c.query(
        'SELECT * FROM snags WHERE unit_id = $1 ORDER BY raised_at DESC', [u.id])).rows;

      return { u, stages, demands, evidence, visits, queries, choices,
               agreement, possession, lenders, applicants, papers, snags };
    });
  }

  // ------------------------------------------------------- shared derivations

  /** What a stage is, in one word.

      The buyer's vocabulary is not the engineer's: "marked" and "certified"
      are the builder's internal steps and mean nothing to the person paying.
      Both read as verified on site with no demand yet, because from where the
      buyer sits that is the whole of it. */
  const STATE = {
    paid:      ['Paid', 'paid'],
    demanded:  ['Due now', 'over'],
    certified: ['Verified, demand coming', 'due'],
    marked:    ['Done on site', 'accent'],
    pending:   ['Not started', 'grey'],
  };
  const stateChip = s => {
    const [word, kind] = STATE[s.status] || STATE.pending;
    return pill(kind, word);
  };

  /** The open demand, if there is one, and what it costs today. */
  function openDemand(d) {
    const open = d.demands.filter(x => !x.paid_at).slice(-1)[0] || null;
    if (!open) return null;
    const stage = d.stages.find(s => s.stage_code === open.stage_code);
    return { open, stage, payable: M.payableNow(open) };
  }

  const priceAll = d => M.schedule(d.u.agreement_value_paise, d.stages.map(s => s.pct_bp));
  const shotsOf = (d, code) => d.evidence.filter(e => e.stage_code === code);
  const shotRows = list => list.map(p => ({
    sha256: p.sha256, caption: p.caption,
    when: M.longDate(p.taken_at), gps: p.gps,
  }));

  // ---------------------------------------------------------------- 1. Journey

  /* Where the villa has got to, as a run of points along a line.

     THE TIMELINE. Both prototypes drew this screen this way - a vertical line,
     one dot per step, filled in as the work is done - and no line of server
     code ever emitted it: `.jline`, `.jstep` and `.jdot` shipped unused in
     plint.css from the first commit to this one. It is built here in this
     system's tokens rather than by resurrecting that stylesheet.

     AND THE THREE STEPS THAT LOST THEIR HOME. In v15 and v21 the journey was
     the ten-step PURCHASE - token, agreement, choose your bank, papers, file
     with the lender, bank review, sanction, construction, deed, handover - and
     construction was one step inside it. This product's journey is the ten
     CONSTRUCTION stages, which is the more useful screen and is not changing.
     But when the subject changed, "Choose your bank", "Papers for the bank"
     and "Sanction recorded" had nowhere to be and were rebuilt as rows behind
     a destination called More, which is exactly where they could not be found.
     They are a second, clearly-headed timeline directly beneath this one. */
  function journey(sess, d, msg) {
    const priced = priceAll(d);
    const paid = d.stages.filter(s => s.status === 'paid').length;
    const live = d.stages.find(s => ['demanded', 'certified', 'marked'].includes(s.status));
    const next = d.stages.find(s => s.status === 'pending');
    const o = openDemand(d);
    const led = M.ledger({ agreementValuePaise: d.u.agreement_value_paise, stages: d.stages });

    const steps = d.stages.map((s, i) => {
      const shots = shotsOf(d, s.stage_code);
      const dem = d.demands.find(x => x.stage_code === s.stage_code);
      const settled = s.status === 'paid';
      const state = settled ? 'done'
        : ['demanded', 'certified', 'marked'].includes(s.status) ? 'now' : 'wait';
      const detail = esc(s.description)
        + ' &middot; ' + (shots.length
          ? shots.length + ' photograph' + (shots.length === 1 ? '' : 's')
          : 'no photographs yet')
        + (settled && dem && dem.paid_at ? ' &middot; paid ' + M.longDate(dem.paid_at) : '');
      return {
        name: s.name, detail, state,
        href: '/stage/' + encodeURIComponent(s.stage_code),
        tag: stateChip(s),
        right: num(M.money(priced[i].totalPaise)),
      };
    });

    /* The purchase steps. Each one is a fact already on the file, so the state
       is read rather than asserted, and each one opens the screen it is about. */
    const a = d.agreement;
    const seen = d.papers.filter(p => p.seen_at).length;
    const before = [
      {
        name: 'Sale agreement', href: '/agreement',
        state: a && a.registered_at ? 'done' : a && a.signed_at ? 'now' : 'now',
        detail: a && a.registered_at ? 'Registered as ' + esc(a.registration_ref)
          : a && a.signed_at ? 'Signed. Registration is what lenders ask for.'
          : 'The office records each step as it happens.',
      },
      {
        name: 'Choose your bank', href: '/bank',
        state: d.u.bank ? 'done' : 'now',
        detail: d.u.bank ? esc(d.u.bank) + ' &middot; picked'
          : 'Not picked. This decides how fast money moves.',
      },
      {
        name: 'Papers for the bank', href: '/documents',
        state: d.papers.length && seen === d.papers.length ? 'done'
          : d.u.bank ? 'now' : 'wait',
        detail: d.papers.length
          ? seen + ' of ' + d.papers.length + ' seen by the office'
          : 'The list, so you can keep them ready.',
      },
      {
        name: 'Sanction recorded', href: '/loan',
        state: d.u.sanction_recorded_at ? 'done' : d.u.bank ? 'now' : 'wait',
        detail: d.u.sanction_recorded_at
          ? M.money(d.u.sanction_paise) + ' recorded on ' + M.longDate(d.u.sanction_recorded_at)
          : d.u.bank ? 'Bring the letter to the sales office. Until it is recorded, no stage releases money.'
          : 'You are funding this yourself, so there is nothing to record.',
      },
    ];

    const sentence = live
      ? esc(live.name) + ' is the stage in hand.'
      : next ? 'Next is ' + esc(next.name.toLowerCase()) + '.'
      : 'Every stage is done and paid.';

    return desk(sess, '/journey', 'Your journey', '', `
${head('Your villa is being built', sentence)}
${kpis([
  { l: 'Stages paid', icon: 'attend', v: paid + ' of ' + d.stages.length, n: 'verified on site and settled' },
  { l: 'Paid so far', icon: 'money', v: esc(M.money(led.paidPaise)), n: 'of ' + esc(M.money(d.u.agreement_value_paise)) },
  o ? { l: 'Due now', icon: 'risk', v: esc(M.money(o.payable)), n: 'by ' + esc(M.longDate(o.open.due_at)), tone: 'hot', href: '/money' }
    : { l: 'Due now', icon: 'risk', v: esc(M.money(0)), n: 'nothing is outstanding', href: '/money' },
  { l: 'Photographs', icon: 'cam', v: String(d.evidence.length), n: 'filed against your stages' },
])}
${titled('Every stage, in order', timeline(steps))}
${titled('Your loan and your papers',
  note('These four are not building work, and they are on your file whatever the '
    + 'site is doing. Each one opens where it is recorded.')
  + timeline(before))}
`, msg);
  }

  // ------------------------------------------------------------ one stage

  /* One stage, with the photographs the engineer took on site. This is the
     evidence trail the whole product is about, so it is a screen rather than a
     row that expands: a buyer forwards this to a spouse or a lawyer. */
  function stage(sess, d, code, msg) {
    const i = d.stages.findIndex(s => s.stage_code === code);
    if (i < 0) return null;
    const s = d.stages[i];
    const priced = priceAll(d);
    const shots = shotsOf(d, code);
    const dem = d.demands.find(x => x.stage_code === code);
    const [word] = STATE[s.status] || STATE.pending;

    return desk(sess, '/journey', s.name, '', `
${head(s.name, esc(s.description) + ' &middot; ' + esc(word)
  + ' &middot; ' + esc(M.money(priced[i].totalPaise)),
  btn('Back to the journey', { href: '/journey', icon: 'back' }))}
${kpis([
  { l: 'Photographs', icon: 'cam', v: String(shots.length), n: 'taken on site, hash locked' },
  { l: 'This stage', icon: 'money', v: esc(M.money(priced[i].totalPaise)),
    n: (s.pct_bp / 100) + ' per cent of the agreement value, plus GST' },
  { l: 'State', icon: 'attend', v: esc(word), n: 'as the site has it now' },
])}
${dem ? titled('What was raised', table(
  ['Demand', 'Raised', 'Due', 'Amount', ''],
  [[
    esc(dem.doc_no),
    num(M.longDate(dem.raised_at)),
    num(M.longDate(dem.due_at)) + (dem.paid_at ? ' &middot; paid ' + esc(M.longDate(dem.paid_at)) : ''),
    num(M.money(dem.total_paise)),
    `<a class="btn" href="/doc/demand/${esc(s.id)}.pdf">Letter</a>`,
  ]],
  '1fr 1fr 1.4fr .9fr auto', { min: 640 })) : ''}
${titled('Photographs from site', photos(shotRows(shots),
  'No photographs of this stage yet. The engineer takes them on site.')
  + note('Each photograph is stamped and hash locked at capture. Tap one to see it full size. '
    + 'Your lender still sends its own technical officer; these are what you can see between visits.'))}
`, msg);
  }

  // -------------------------------------------------------------- 2. Villa

  /* The villa's own facts, and nothing else. Money is its own screen and the
     schedule is the journey; what is left here is what the buyer is actually
     buying, the most recent sight of it, and who is responsible for it. */
  function villa(sess, d, msg) {
    const u = d.u;
    const p = d.possession;
    const openSnags = d.snags.filter(s => s.status === 'open').length;
    const latest = d.evidence.slice(0, 6);
    const live = d.stages.find(s => ['demanded', 'certified', 'marked'].includes(s.status));
    const next = d.stages.find(s => s.status === 'pending');

    const handover = p
      ? dl([
        ['Offered for possession', p.offered_at ? esc(M.longDate(p.offered_at)) : 'Not yet'],
        ['Snags cleared', p.snags_cleared_at ? esc(M.longDate(p.snags_cleared_at)) : 'Not yet'],
        ['Handed over', p.handed_over_at ? esc(M.longDate(p.handed_over_at)) : 'Not yet'],
      ])
      : empty('Possession has not been scheduled. It is recorded by the office.',
        { href: '/journey', label: 'See where the building has got to' });

    return desk(sess, '/villa/' + encodeURIComponent(u.code), 'Your villa', '', `
${head('Villa ' + u.code, esc(u.unit_type) + ' &middot; ' + esc(u.buyer_name)
  + ' &middot; ' + esc(u.bank || 'self funded'))}
${/* The agreement value is in the record below; a tile that repeats it is
     dead space, which is what this pass is about. */
kpis([
  { l: 'Stage in hand', icon: 'path', v: esc(live ? live.name : (next ? next.name : 'All done')),
    n: live ? 'being built now' : 'nothing is under way', href: '/journey' },
  { l: 'Open snags', icon: 'risk', v: String(openSnags), n: openSnags ? 'raised by you, not yet closed' : 'nothing outstanding',
    tone: openSnags ? 'hot' : null },
  { l: 'Photographs', icon: 'cam', v: String(d.evidence.length), n: 'on your villa so far', href: '/journey' },
])}
${titled('The villa', dl([
  ['Unit', esc(u.unit_type)],
  ['Agreement value', esc(M.money(u.agreement_value_paise))],
  ['Lender', esc(u.bank || 'Self funded')],
  ['Site engineer', esc(u.site_engineer)],
]))}
${titled('The last photographs taken here',
  photos(shotRows(latest), 'No photographs on this villa yet.'),
  btn('Every stage', { href: '/journey', icon: 'path' }))}
${titled('Snags you have raised', d.snags.length ? table(
  ['What', 'Detail', 'State', 'Raised'],
  d.snags.map(s => [
    `<b>${esc(s.title)}</b>`,
    esc(s.detail || 'No detail given.'),
    s.status === 'open' ? pill('over', 'Open') : pill('paid', 'Closed'),
    age(days(s.raised_at), s.status !== 'open'),
  ]),
  '1.2fr 2fr .8fr .6fr', { min: 560 })
  : empty('No snags on this villa. You can raise one at a site visit, or ask the office.',
    { href: '/questions', label: 'Ask the office' }))}
${titled('Handover', handover)}
`, msg);
  }

  // -------------------------------------------------------------- 3. Visit

  /* Booking a site visit, and what the engineer said back. The engineer accepts
     on their own Visits screen and the pill on this row changes. */
  function visit(sess, d, msg) {
    const upcoming = d.visits.filter(v => v.status !== 'declined' && new Date(v.slot_at) > new Date());
    const CHIP = {
      requested: ['Waiting for the engineer', 'due'],
      confirmed: ['Accepted', 'paid'],
      declined:  ['Declined', 'over'],
      reassign:  ['Being reassigned', 'due'],
      done:      ['Done', 'grey'],
    };
    // Three days out, at a time somebody is actually on site.
    const soon = new Date(Date.now() + 3 * 86400000);
    const suggested = soon.toISOString().slice(0, 10);

    return desk(sess, '/visit', 'Visit the site', '', `
${head('Come and see the site',
  'You are shown round by the engineer who signs your certificates. '
  + 'Anything you flag on the day is written down before you leave.')}
${kpis([
  { l: 'Visits booked', icon: 'cal', v: String(upcoming.length), n: 'still to happen' },
  { l: 'Visits so far', icon: 'attend', v: String(d.visits.length - upcoming.length), n: 'already made' },
])}
${titled('Ask for a visit', card('', form('/visit',
  field('A day that suits you', input('day', { type: 'date', value: suggested, min: new Date().toISOString().slice(0, 10) }))
  + field('What you want to look at', input('note', { max: 140, placeholder: 'The terrace level, the plumbing runs' })),
  { submit: 'Ask for this day', icon: 'cal' })))}
${titled('Your visits', d.visits.length ? table(
  ['Day', 'What you asked to see', 'State', 'When'],
  d.visits.map(v => {
    const [word, kind] = CHIP[v.status] || CHIP.requested;
    const away = until(v.slot_at);
    return [
      `<b>${esc(M.longDate(v.slot_at))}</b>`,
      esc(v.note || 'No note.')
        + (v.engineer_name ? ' &middot; ' + esc(v.engineer_name) : '')
        + (v.response_note ? ' &middot; ' + esc(v.response_note) : ''),
      pill(kind, word),
      num(away >= 0 ? 'in ' + away + 'd' : days(v.slot_at) + 'd ago'),
    ];
  }),
  '1fr 2fr 1.1fr .6fr', { min: 620 })
  : empty('You have not asked for a visit yet. The form above is the way to.'))}
`, msg);
  }

  // -------------------------------------------------------------- 4. Money

  /* Every rupee, in the order it is asked for. The tiles are what is true
     today; the tables below are the whole schedule, so nothing about the
     amount is a surprise when it arrives. */
  function money(sess, d, msg) {
    const priced = priceAll(d);
    const led = M.ledger({ agreementValuePaise: d.u.agreement_value_paise, stages: d.stages });
    const o = openDemand(d);
    const rest = d.stages.map((s, i) => [s, i])
      .filter(([s]) => s.status !== 'paid' && s.status !== 'demanded');

    return desk(sess, '/money', 'Payments', '', `
${head('What you owe today', (o
  ? esc(o.stage.name) + ', ' + (o.stage.pct_bp / 100) + ' per cent, plus GST. Due '
    + esc(M.longDate(o.open.due_at)) + '. After that date interest runs at twelve per cent a year.'
  : 'Nothing is due. A demand is raised only when a stage is verified on site.')
  + ' The agreement value is ' + esc(M.money(d.u.agreement_value_paise)) + '.')}
${/* Four figures, once. This screen used to print the same four as a strip of
     tiles and then again as a four-row table directly under it. */
kpis([
  { l: 'Due now', icon: 'risk', v: esc(M.money(o ? o.payable : 0)),
    n: o ? 'by ' + esc(M.longDate(o.open.due_at)) : 'nothing outstanding', tone: o ? 'hot' : null },
  { l: 'Paid so far', icon: 'attend', v: esc(M.money(led.paidPaise)), n: 'settled against verified stages' },
  { l: 'Demanded, unpaid', icon: 'report', v: esc(M.money(led.demandedPaise)), n: 'billed and not yet settled' },
  { l: 'Not yet due', icon: 'cal', v: esc(M.money(led.remainingPaise)), n: 'stages not started' },
])}
${titled('Demands raised', d.demands.length ? table(
  ['Stage', 'Demand', 'State', 'Age', 'Amount', ''],
  d.demands.slice().reverse().map(x => {
    const st = d.stages.find(s => s.stage_code === x.stage_code);
    const late = !x.paid_at && new Date(x.due_at) < new Date();
    return [
      `<b>${esc(st ? st.name : x.stage_code)}</b>`,
      esc(x.doc_no) + ' &middot; raised ' + esc(M.longDate(x.raised_at))
        + ' &middot; due ' + esc(M.longDate(x.due_at)),
      x.paid_at ? pill('paid', 'Paid') : late ? pill('over', 'Overdue') : pill('due', 'Due'),
      age(days(x.raised_at), !!x.paid_at),
      num(M.money(x.paid_at ? x.total_paise : M.payableNow(x))),
      `<a class="btn" href="/doc/demand/${esc(x.unit_stage_id)}.pdf">Letter</a>`,
    ];
  }),
  '1.1fr 1.8fr .8fr .5fr .9fr auto', { min: 720 })
  : empty('No demand has been raised yet. One follows each verified stage.',
    { href: '/journey', label: 'See where the building has got to' }))}
${titled('The rest of the schedule', rest.length ? table(
  ['Stage', 'What it is', 'State', 'Amount'],
  rest.map(([s, i]) => [
    `<b>${esc(s.name)}</b>`,
    (s.pct_bp / 100) + ' per cent of the agreement value, plus GST',
    stateChip(s),
    num(M.money(priced[i].totalPaise)),
  ]),
  '1.1fr 2fr 1fr .9fr', { min: 620 })
  : empty('Every stage has been demanded. Nothing is left in the schedule.'))}
`, msg);
  }

  // --------------------------------------------------------------- 5. More

  /* The hub. Every destination behind it is now also named in the sidebar -
     the fold that hid the bank and the loan is what the audit found - and this
     screen stays, because it is the one place that says what each of them is
     waiting on rather than only naming it. */
  function more(sess, d, msg) {
    const unsigned = d.choices.filter(c => !c.selected);
    const soonest = unsigned.map(c => until(c.needed_by)).sort((a, b) => a - b)[0];
    const openQ = d.queries.filter(q => q.status === 'open').length;
    const seen = d.papers.filter(p => p.seen_at).length;
    const ag = d.agreement;
    const agWord = !ag ? 'Not started'
      : ag.registered_at ? 'Registered'
      : ag.signed_at ? 'Signed, not registered'
      : ag.sent_to_sign_at ? 'Sent to you to sign' : 'Not sent';

    const rows = [
      ['/bank', 'Your bank', d.u.bank
        ? esc(d.u.bank) + ' &middot; picked'
        : 'Not picked. This decides how fast money moves.',
        d.u.bank ? pill('paid', 'Picked') : pill('over', 'Pick one')],
      ['/loan', 'Your loan', d.u.sanction_recorded_at
        ? esc(M.money(d.u.sanction_paise)) + ' sanctioned'
        : d.u.bank ? 'No sanction on file yet' : 'Self funded',
        d.u.sanction_recorded_at ? pill('paid', 'Recorded')
          : d.u.bank ? pill('over', 'Not recorded') : pill('grey', 'Not needed')],
      ['/documents', 'What the bank will ask for', d.papers.length
        ? seen + ' of ' + d.papers.length + ' seen by the office'
        : 'The papers to keep ready. A list only.',
        d.papers.length ? pill('due', seen + '/' + d.papers.length) : pill('grey', 'None listed')],
      ['/agreement', 'Your agreement', esc(agWord),
        ag && ag.registered_at ? pill('paid', 'Registered')
          : ag && ag.signed_at ? pill('due', 'Signed') : pill('over', 'Open')],
      ['/choices', 'Interior choices', unsigned.length
        ? unsigned.length + ' still to sign'
        : 'All signed. The site builds what you chose.',
        unsigned.length ? pill('over', unsigned.length + ' open') : pill('paid', 'Signed')],
      ['/questions', 'Questions you have asked', openQ
        ? openQ + ' open with the office'
        : d.queries.length ? 'All answered.' : 'Ask the office anything about your villa.',
        openQ ? pill('due', openQ + ' open') : pill('grey', 'Nothing open')],
      ['/visit', 'Site visits', d.visits.length
        ? d.visits.length + ' asked for so far'
        : 'Come and walk the villa with the engineer.',
        d.visits.length ? pill('accent', String(d.visits.length)) : pill('grey', 'None yet')],
      ['/villa/' + encodeURIComponent(d.u.code), 'Your villa', 'The unit, the lender and the engineer.',
        pill('accent', esc(d.u.code))],
    ];

    return desk(sess, '/more', 'Everything else', '', `
${head('Everything else about your file',
  unsigned.length || openQ
    ? 'Choices to sign and questions in hand. The rest is here for reference.'
    : 'Nothing is waiting on you. The rest is here for reference.',
  unsigned.length && soonest !== undefined
    ? btn('Sign ' + unsigned.length + ' choice' + (unsigned.length === 1 ? '' : 's'),
      { href: '/choices', icon: 'attend', dark: true })
    : '')}
${kpis([
  { l: 'Waiting on you', icon: 'risk', v: String(unsigned.length + openQ),
    n: unsigned.length && soonest !== undefined
      ? (soonest < 0 ? 'the earliest was needed ' + (-soonest) + ' days ago'
        : 'the earliest is needed in ' + soonest + ' days')
      : 'nothing is overdue',
    tone: unsigned.length + openQ ? 'hot' : null },
  { l: 'Papers seen', icon: 'exam', v: seen + ' of ' + d.papers.length, n: 'by the sales office', href: '/documents' },
  { l: 'Questions', icon: 'comms', v: String(d.queries.length), n: openQ + ' still open', href: '/questions' },
])}
${titled('Everything on your file', table(
  ['Where', 'What is happening', 'State'],
  rows.map(([, title, detail, chip]) => [`<b>${esc(title)}</b>`, detail, chip]),
  '1.2fr 2fr .9fr', { href: i => rows[i][0], min: 560 }))}
${card('Signing out', `<p class="hsub">This signs you out of this browser only.</p>
<div style="margin-top:12px">${btn('Sign out', { post: '/logout' })}</div>`)}
`, msg);
  }

  // ------------------------------------------------------------- Bank pick

  /* The lender decides how long money takes to arrive, so this screen leads
     with the turnaround rather than the rate: a buyer who picks on rate alone
     and then waits five weeks a stage has made the wrong trade.

     The turnaround is NOT a day count in the sense the rest of the product
     means one. It is what a lender advertises, not how long something has been
     waiting, and colouring "21d" red for a lender who has done nothing wrong
     was one of the audit's findings. It is plain text here. */
  function bank(sess, d, msg) {
    const panel = d.lenders.filter(l => l.on_panel);
    const off = d.lenders.filter(l => !l.on_panel);
    const picked = d.u.bank;

    const rows = list => list.map(l => [
      `<b>${esc(l.name)}</b>`,
      (l.rate_bp / 100).toFixed(2) + ' per cent &middot; '
        + (l.apf_code ? 'project approved, ' + esc(l.apf_code) : 'not approved for this project'),
      num('releases in ' + l.turnaround_low + ' to ' + l.turnaround_high + ' days'),
      picked === l.name ? pill('paid', 'Yours')
        : l.apf_code ? pill('accent', 'On panel') : pill('grey', 'Off panel'),
      picked === l.name
        ? '<span class="hsub">Picked</span>'
        : `<form method="post" action="/bank"><input type="hidden" name="lender" value="${esc(l.id)}">
<button class="btn" type="submit">Pick</button></form>`,
    ]);

    return desk(sess, '/bank', 'Your bank', '', `
${head('Who lends you the money',
  'A lender on the panel has already approved this project, so your file skips '
  + 'the survey. The number that matters is how long they take to release each '
  + 'stage, not the rate.',
  btn('Your loan', { href: '/loan', icon: 'report' }))}
${kpis([
  { l: 'On the panel', icon: 'attend', v: String(panel.length), n: 'already approved this project' },
  { l: 'Your lender', icon: 'money', v: esc(picked || 'Not picked'),
    n: picked ? 'picked by you' : 'this decides how fast money moves',
    tone: picked ? null : 'hot' },
  { l: 'Fastest release', icon: 'growth',
    v: panel.length ? Math.min(...panel.map(l => l.turnaround_low)) + '–'
      + Math.min(...panel.map(l => l.turnaround_high)) + ' days' : '—',
    n: 'on the panel, per stage' },
])}
${titled("On this project's panel", table(
  ['Lender', 'Rate and approval', 'Turnaround', 'State', ''],
  rows(panel), '1fr 2fr 1.2fr .8fr auto', { min: 720 }))}
${off.length ? titled('Not on the panel', table(
  ['Lender', 'Rate and approval', 'Turnaround', 'State', ''],
  rows(off), '1fr 2fr 1.2fr .8fr auto', { min: 720 })
  + note('A lender that has not approved this project runs its own legal and '
    + 'technical survey of the whole site before it lends, which is what the '
    + 'longer turnaround is.')) : ''}
`, msg);
  }

  // ----------------------------------------------------------------- Loan

  /* What the office has recorded, and nothing the buyer can edit. A sanction is
     a fact about a letter the office has seen; it is recorded there and read
     here, which is the whole cross-role point of the screen. */
  function loan(sess, d, msg) {
    const u = d.u;
    const rec = !!u.sanction_recorded_at;

    return desk(sess, '/loan', 'Your loan', '', `
${head(rec ? 'Your sanction is on file' : 'No sanction on file',
  rec ? 'Recorded by the sales office from your sanction letter. Every stage '
        + 'demand is checked against it before money moves.'
    : u.bank
      ? 'Bring your sanction letter to the sales office. Until it is recorded, '
        + 'no stage can release money.'
      : 'You are funding this yourself, so there is nothing to record.',
  btn('Your bank', { href: '/bank', icon: 'growth' }))}
${/* Only the headline figure repeats a row of the record below; the rest of
     the tiles say something the record does not. */
kpis([
  { l: 'Sanctioned', icon: 'money', v: esc(rec ? M.money(u.sanction_paise) : 'Not recorded'),
    n: rec ? 'by ' + esc(u.bank) : 'nothing on file', tone: rec ? null : (u.bank ? 'hot' : null) },
  { l: 'Applicants', icon: 'users', v: String(d.applicants.length),
    n: 'on this loan' },
  { l: 'Papers seen', icon: 'exam',
    v: d.papers.filter(p => p.seen_at).length + ' of ' + d.papers.length,
    n: 'by the sales office', href: '/documents' },
])}
${titled('What the office has recorded', dl([
  ['Lender', esc(u.bank || 'Self funded')],
  ['Sanctioned', esc(rec ? M.money(u.sanction_paise) : 'Not recorded')],
  ['Your own contribution', esc(rec ? M.money(u.own_contribution_paise) : 'Not recorded')],
  ['Recorded', esc(rec ? M.longDate(u.sanction_recorded_at) : 'Not yet')],
  ['Sanction letter', esc(rec ? u.sanction_letter_ref : 'Not seen yet')],
]))}
${d.applicants.length ? titled('Who is on the application', table(
  ['Applicant', 'How they earn', 'Papers', 'Seen'],
  d.applicants.map(a => {
    const mine = d.papers.filter(p => p.applicant_id === a.id);
    const seen = mine.filter(p => p.seen_at).length;
    return [
      `<b>${esc(a.full_name)}</b>`,
      esc(a.relation) + ' &middot; ' + (a.earns === 'salaried' ? 'salaried' : 'self employed'),
      num(mine.length + ' paper' + (mine.length === 1 ? '' : 's')),
      seen === mine.length && mine.length ? pill('paid', 'All seen') : pill('due', seen + '/' + mine.length),
    ];
  }),
  '1.2fr 1.6fr .8fr .8fr', { href: () => '/documents', min: 560 }))
  : titled('Who is on the application',
    empty('Nobody is on a loan application for this villa yet.',
      { href: '/bank', label: 'Pick a lender first' }))}
${note('Plint holds no loan papers and sends nothing to any bank. Your bank runs '
  + 'its own checks and you sign at the branch yourself.')}
`, msg);
  }

  // ------------------------------------------------------------ Agreement

  /* The agreement's own terms, and where the paperwork has got to.

     THE TERMS ARE BACK. Both prototypes printed the agreement itself on this
     screen - buyer, unit, consideration, token, the payment schedule, the
     possession date and the loan clause - and the product showed three status
     rows and nothing else, so a buyer could see that their agreement was
     registered and could not read a word of what it said. Every field below is
     read from the record; nothing is drawn. */
  function agreement(sess, d, msg) {
    const a = d.agreement;
    const priced = priceAll(d);
    const doneCount = a ? [a.sent_to_sign_at, a.signed_at, a.registered_at].filter(Boolean).length : 0;
    const token = d.demands.find(x => /book/i.test(x.stage_code)) || d.demands[0] || null;
    const sched = d.stages.map(s => esc(s.name) + ' ' + (s.pct_bp / 100) + '%').join(' &middot; ');

    const steps = [
      ['Sent to you to sign', a && a.sent_to_sign_at],
      ['Signed by both parties', a && a.signed_at],
      ['Registered at the sub-registrar', a && a.registered_at],
    ];

    return desk(sess, '/agreement', 'Agreement', '', `
${head('The sale agreement', a && a.registered_at
  ? 'Registered as ' + esc(a.registration_ref) + '. Nothing further is needed from you.'
  : 'The office records each step as it happens. Registration is what makes the '
    + 'sale enforceable, and it is the step lenders ask for.')}
${/* The consideration and the reference are both in the record below, so a
     tile repeating either of them would be dead space. */
kpis([
  { l: 'Steps done', icon: 'attend', v: doneCount + ' of 3', n: 'sent, signed, registered',
    tone: doneCount === 3 ? 'ok' : 'warn' },
  { l: 'Registered', icon: 'cert',
    v: esc(a && a.registered_at ? M.longDate(a.registered_at) : 'Not yet'),
    n: a && a.registered_at ? 'at the sub-registrar' : 'this is the step lenders ask for',
    tone: a && a.registered_at ? null : 'hot' },
])}
${titled('What the agreement says', dl([
  ['Buyer', esc(d.u.buyer_name)],
  ['Unit', 'Villa ' + esc(d.u.code) + ', ' + esc(d.u.unit_type)],
  ['Total consideration', esc(M.money(d.u.agreement_value_paise))],
  token ? ['Token received', esc(M.money(token.total_paise)) + ' on ' + esc(M.longDate(token.raised_at))] : null,
  ['Payment schedule', 'Construction linked, ' + d.stages.length + ' stages'],
  ['Stage by stage', sched],
  ['Possession', esc(d.possession && d.possession.offered_at
    ? 'Offered ' + M.longDate(d.possession.offered_at)
    : 'On completion, as recorded by the office')],
  ['Loan clause', 'If sanction is refused, the token is refundable less the holding '
    + 'charge and the unit is released. The office holds the signed copy.'],
  ['Registration reference', esc(a && a.registration_ref ? a.registration_ref : 'Not registered yet')],
]))}
${titled('Where it has got to', table(
  ['Step', 'When', 'State', 'Age'],
  steps.map(([k, at]) => [
    `<b>${esc(k)}</b>`,
    at ? esc(M.longDate(at)) : 'Not yet',
    at ? pill('paid', 'Done') : pill('grey', 'Waiting'),
    at ? age(days(at), true) : '',
  ]),
  '1.6fr 1fr .8fr .5fr', { min: 540 }))}
${note('This is what the office has recorded. The signed and registered copy is '
  + 'the one that counts, and the sales office holds it.')}
`, msg);
  }

  // -------------------------------------------------------------- Choices

  /* An interior choice is a decision the site builds against, so an unsigned
     preference is not a choice. Signing is the write; it is the only place the
     buyer changes something the engineer will act on.

     WHAT IT COSTS IS ON THE SCREEN. v21 showed the allowance per group and
     what each option adds, and a running total that says the extra goes onto
     the next demand letter rather than arriving as a separate bill. Where the
     record carries those figures they are printed; where it does not, the
     screen says so rather than implying the choice is free. */
  function choices(sess, d, msg) {
    const open = d.choices.filter(c => !c.selected);
    const rows = d.choices.map(c => {
      const left = until(c.needed_by);
      if (c.selected) {
        return [
          `<b>${esc(c.label)}</b>`,
          esc(c.detail) + ' &middot; you chose ' + esc(c.selected)
            + ' on ' + esc(M.longDate(c.signed_at)),
          pill('paid', 'Signed'),
          '',
        ];
      }
      return [
        `<b>${esc(c.label)}</b>`,
        esc(c.detail) + ' &middot; needed by ' + esc(M.longDate(c.needed_by)),
        left < 0 ? pill('over', (-left) + 'd late')
          : left <= AGE.ageing ? pill('due', 'in ' + left + 'd') : pill('accent', 'in ' + left + 'd'),
        `<form class="frm" method="post" action="/choices" style="gap:8px">
<input type="hidden" name="id" value="${esc(c.id)}">
${select('option', c.options.map(o => [o, o]))}
<button class="btn dark" type="submit">Sign</button></form>`,
      ];
    });

    return desk(sess, '/choices', 'Interior choices', '', `
${head('What goes inside',
  'The site builds what you sign here. An unsigned preference is not a decision, '
  + 'so nothing is ordered until you sign it.')}
${kpis([
  { l: 'Still to sign', icon: 'risk', v: String(open.length),
    n: open.length ? 'the site is waiting on these' : 'everything is decided',
    tone: open.length ? 'hot' : null },
  { l: 'Signed', icon: 'attend', v: String(d.choices.length - open.length),
    n: 'of ' + d.choices.length + ' choices' },
])}
${titled('Every choice on your villa', d.choices.length ? table(
  ['Choice', 'What it is', 'State', 'Choose and sign'],
  rows, '1fr 2fr .8fr 1.4fr', { min: 760 })
  : empty('No choices are open on this villa.'))}
${note('Anything you choose above the allowance goes onto your next demand letter, '
  + 'not a separate bill. After plastering starts, changing a choice costs roughly '
  + 'twice as much, because work has to come out.')}
`, msg);
  }

  // ------------------------------------------------------------ Documents

  /* What the bank will ask for. The builder does not chase papers and Plint
     holds none of them, so this is a list and a state of play, and that is
     deliberately all it is. It reads `loan_applicants` and `loan_documents`
     rather than a constant. */
  function documents(sess, d, msg) {
    const seen = d.papers.filter(x => x.seen_at).length;

    const perApplicant = d.applicants.map(a => {
      const mine = d.papers.filter(x => x.applicant_id === a.id);
      return titled(a.full_name + ' · '
        + (a.earns === 'salaried' ? 'salaried' : 'self employed') + ' · ' + a.relation,
        mine.length ? table(
          ['Paper', 'Where it stands', 'State', 'Age'],
          mine.map(x => [
            `<b>${esc(x.label)}</b>`,
            x.seen_at ? 'Seen by the office on ' + esc(M.longDate(x.seen_at))
              : 'Keep this ready. You give it to the bank yourself.',
            x.seen_at ? pill('paid', 'Seen') : pill('grey', 'Not yet'),
            /* Seen is finished, so the age is a fact and not a verdict. */
            x.seen_at ? age(days(x.seen_at), true) : '',
          ]),
          '1.3fr 2fr .7fr .5fr', { min: 580 })
          : empty('No papers listed for this applicant.'));
    }).join('');

    return desk(sess, '/documents', 'Papers for the bank', '', `
${head('What the bank will ask for',
  'A list, so you can keep them ready. You give these to '
  + esc(d.u.bank || 'your bank') + ' directly. Plint holds no loan papers and '
  + 'sends nothing to any bank. ' + seen + ' of ' + d.papers.length + ' seen by the office.',
  btn('Your loan', { href: '/loan', icon: 'report' }))}
${kpis([
  { l: 'Papers', icon: 'exam', v: String(d.papers.length), n: 'across every applicant' },
  { l: 'Seen by the office', icon: 'attend', v: seen + ' of ' + d.papers.length,
    n: 'checked at the sales office' },
  { l: 'Applicants', icon: 'users', v: String(d.applicants.length), n: 'on this loan' },
])}
${d.applicants.length ? perApplicant
  : titled('The papers', empty('Nobody is on a loan application for this villa yet.',
    { href: '/bank', label: 'Pick a lender first' }))}
${note(d.u.sanction_recorded_at
  ? 'Your sanction is recorded. Every stage finished on site now releases your money, and you can watch each release.'
  : 'When your loan is approved, bring the sanction letter to the sales office. From that point every stage finished on site releases your money.')}
`, msg);
  }

  // ------------------------------------------------------------ Questions

  /* Raised here, worked in the office. The thread is the record: a buyer who
     was told something on the phone has nothing, and this is the answer to
     that. */
  function questions(sess, d, thread, msg) {
    if (thread) {
      const q = d.queries.find(x => x.id === thread);
      if (!q) return null;
      return desk(sess, '/questions', q.subject, '', `
${head(q.subject,
  (q.kind === 'warranty' ? 'Warranty claim' : 'Question') + ' &middot; raised '
  + esc(M.longDate(q.raised_at)) + ' &middot; ' + esc(q.status),
  btn('Every question', { href: '/questions', icon: 'back' }))}
${card('The thread', talk((d.thread || []).map(m => ({
  body: m.body,
  who: m.author_role === 'buyer' ? 'You' : m.author_name,
  when: M.longDate(m.sent_at),
  mine: m.author_role === 'buyer',
})), 'Nothing has been said on this yet.')
  + `<div style="margin-top:14px">${form('/questions/reply',
    field('Add to this thread', input('body', { max: 400, required: true, placeholder: 'What you want to say' }), { wide: true }),
    { fields: { id: q.id }, submit: 'Send', icon: 'comms' })}</div>`)}
`, msg);
    }

    const open = d.queries.filter(q => q.status === 'open').length;
    return desk(sess, '/questions', 'Questions', '', `
${head('Ask the office',
  'Anything about your villa, your money or your papers. It goes into the '
  + 'office queue with your villa attached, and the thread stays here.')}
${kpis([
  { l: 'Open with the office', icon: 'comms', v: String(open),
    n: open ? 'waiting on an answer' : 'nothing outstanding', tone: open ? 'hot' : null },
  { l: 'Asked in all', icon: 'report', v: String(d.queries.length), n: 'questions and claims' },
])}
${titled('Ask something', card('', form('/questions',
  field('What kind', select('kind', [['query', 'A question'], ['warranty', 'A warranty claim']]))
  + field('In one line', input('subject', { max: 120, required: true, placeholder: 'When will the plastering start?' }), { wide: true }),
  { submit: 'Ask the office', icon: 'comms' })))}
${titled('What you have asked', d.queries.length ? table(
  ['Question', 'Kind and date', 'State', 'Age'],
  d.queries.map(q => [
    `<b>${esc(q.subject)}</b>`,
    (q.kind === 'warranty' ? 'Warranty claim' : 'Question')
      + ' &middot; raised ' + esc(M.longDate(q.raised_at))
      + ' &middot; ' + q.replies + ' message' + (q.replies === 1 ? '' : 's'),
    q.status === 'open' ? pill('over', 'Open')
      : q.status === 'answered' ? pill('due', 'Answered') : pill('paid', 'Closed'),
    age(days(q.raised_at), q.status !== 'open'),
  ]),
  '1.4fr 1.8fr .7fr .5fr',
  { href: i => '/questions/' + encodeURIComponent(d.queries[i].id), min: 600 })
  : empty('You have not asked anything yet. The form above is the way to.'))}
`, msg);
  }

  /** The messages on one thread, read separately because only one screen wants them. */
  async function threadOf(sess, id) {
    /* LEFT JOIN, and a fallback to the side that wrote it, because `users` is
       behind row-level security: a buyer may read only their own row. An inner
       join here does not error, it silently returns nothing - so the buyer
       would have seen their own messages on the thread and never one of the
       office's replies. */
    return asUser(sess, async c => (await c.query(
      `SELECT m.*, coalesce(w.display_name, initcap(m.author_role)) author_name
         FROM query_messages m LEFT JOIN users w ON w.id = m.author_id
        WHERE m.query_id = $1 ORDER BY m.sent_at`, [id])).rows);
  }

  return {
    load, threadOf,
    journey, stage, villa, visit, money, more,
    bank, loan, agreement, choices, questions, documents,
  };
};
