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

      /* THE OUTER JOIN KEPT THE ROW AND LOST THE NAME.

         `u_self` gives a buyer exactly one row of `users` - their own - so
         `w.display_name` was NULL on every visit ever rendered to a buyer,
         and the markup prints nothing when it is. This screen's own sentence
         is "You are shown round by the engineer who signs your certificates"
         and it had never once said which one.

         `staff_name()` returns a display name for staff ids and NULL for
         anybody else, so nothing about another buyer can be reached through
         it. See db/migrations/018. */
      const visits = (await c.query(
        `SELECT v.*, staff_name(v.engineer_id) engineer_name
           FROM visits v WHERE v.unit_id = $1 ORDER BY v.slot_at DESC`, [u.id])).rows;

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

      /* The receipts against this villa's demands. No amount is read from
         here and none is held here: a receipt row carries the reference, the
         mode and the day the money was received, and every figure beside it
         on screen comes from the demand it points at. */
      const receipts = (await c.query(
        `SELECT r.* FROM receipts r
           JOIN demands d ON d.id = r.demand_id
           JOIN unit_stages s ON s.id = d.unit_stage_id
          WHERE s.unit_id = $1 ORDER BY r.received_on DESC`, [u.id])).rows;

      /* The buyer's own row in `users`, for the screen that says what Plint
         holds about them. `u_self` lets them read it and nobody else's, and
         the password hash is never selected: this file has no reason to hold
         it and a screen that prints one is a screen that can leak one. */
      const me = (await c.query(
        'SELECT id, email, role, display_name FROM users WHERE id = $1', [sess.id])).rows[0] || null;

      /* WHOSE DATA THIS IS, IN LAW. The builder of this project decides why it
         is collected, so the builder is the Data Fiduciary and Plint is the
         processor. The notice and the Grievance Officer are theirs, named per
         project - a buyer on one project must not be sent to another's. */
      const project = (await c.query(
        `SELECT id, name, phase, location, builder_name, builder_ref,
                grievance_name, grievance_email, grievance_phone, notice_url
           FROM projects WHERE id = $1`, [u.project_id])).rows[0] || null;

      /* How long each kind is kept, and everyone Plint hands it to. Both are
         readable by anybody: a buyer is entitled to know. */
      const retention = (await c.query(
        `SELECT table_name, keep_years, category, basis FROM retention_policy`)).rows;
      const subProcessors = (await c.query(
        `SELECT name, purpose, holds, region, since FROM sub_processors
          WHERE until IS NULL ORDER BY since, name`)).rows;
      /* And whether anything on this villa is frozen. The policy on the table
         shows a buyer a hold that covers their own file and nobody else's. */
      const holds = (await c.query(
        `SELECT kind, reason, reference, placed_at FROM legal_holds
          WHERE released_at IS NULL ORDER BY placed_at DESC`)).rows;

      return { u, stages, demands, evidence, visits, queries, choices, me,
               agreement, possession, lenders, applicants, papers, snags, receipts,
               project, retention, subProcessors, holds };
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
    /* The same pair the payments screen offers. The letter is what was
       billed; the receipt is proof the money was received, and this screen
       was showing one and not the other. */
    ((r => r ? `<a class="btn" href="/receipt/${esc(r.receipt_no)}">Receipt</a> ` : '')
      (d.receipts.find(r => r.demand_id === dem.id)))
      + `<a class="btn" href="/doc/demand/${esc(s.id)}.pdf">Letter</a>`,
  ]],
  '1fr 1fr 1.6fr .9fr auto', { min: 780 })) : ''}
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

    const rcOf = x => d.receipts.find(r => r.demand_id === x.id);

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
      /* A settled demand has a receipt against it, and the receipt is what a
         buyer is actually asked for - by their bank, by their accountant, at
         registration. The letter is what was billed; the receipt is proof
         the money was received. */
      (rcOf(x) ? `<a class="btn" href="/receipt/${esc(rcOf(x).receipt_no)}">Receipt</a> ` : '')
        + `<a class="btn" href="/doc/demand/${esc(x.unit_stage_id)}.pdf">Letter</a>`,
    ];
  }),
  '1.1fr 1.8fr .8fr .5fr .9fr auto', { min: 780 })
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
      /* This hub names every destination behind it, and the newest one was in
         the sidebar and not here. */
      ['/data', 'What Plint holds about you',
        'Every field, by table and column, and a copy you can take away.',
        pill('grey', 'Your data')],
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
      /* A rate Plint does not hold is not printed as one. Off the panel there
         is no quote, and saying "9.00 per cent" because a column needed a
         number is the kind of figure a buyer picks a bank on. */
      (l.rate_bp == null ? 'Rate not quoted here' : (l.rate_bp / 100).toFixed(2) + ' per cent')
        + ' &middot; '
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
    const signed = d.choices.filter(c => c.selected);

    /* AN OPEN CHOICE IS A CARD, NOT A ROW.

       It was a table, and on a phone a table scrolls sideways - which put the
       select and the Sign button, the buyer's only write on this screen, off
       the right-hand edge. A decision gets its own surface, the way a snag
       does on the engineer's screen. */
    const decide = c => {
      const left = until(c.needed_by);
      return titled(c.label,
        card('', `<p class="hsub">${esc(c.detail)} &middot; needed by ${esc(M.longDate(c.needed_by))}</p>
<div style="margin-top:12px">${form('/choices',
  field('Choose', select('option', c.options.map(o => [o, o])), { wide: true }),
  { fields: { id: c.id }, submit: 'Sign this choice', icon: 'attend' })}</div>`),
        left < 0 ? pill('over', (-left) + 'd late')
          : left <= AGE.ageing ? pill('due', 'in ' + left + 'd') : pill('accent', 'in ' + left + 'd'));
    };

    return desk(sess, '/choices', 'Interior choices', '', `
${head('What goes inside',
  'The site builds what you sign here. An unsigned preference is not a decision, '
  + 'so nothing is ordered until you sign it.')}
${kpis([
  { l: 'Still to sign', icon: 'risk', v: String(open.length),
    n: open.length ? 'the site is waiting on these' : 'everything is decided',
    tone: open.length ? 'hot' : null },
  { l: 'Signed', icon: 'attend', v: String(signed.length),
    n: 'of ' + d.choices.length + ' choices' },
])}
${open.length ? open.map(decide).join('')
  : titled('Still to sign', empty('Every choice is signed. The site builds what you chose.'))}
${signed.length ? titled('Already signed', table(
  ['Choice', 'What you chose', 'When', 'State'],
  signed.map(c => [
    `<b>${esc(c.label)}</b>`,
    esc(c.detail) + ' &middot; you chose ' + esc(c.selected),
    esc(M.longDate(c.signed_at)),
    pill('paid', 'Signed'),
  ]), '1.2fr 2fr .9fr .6fr', { min: 620 })) : ''}
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
      `SELECT m.*,
              coalesce(w.display_name, staff_name(m.author_id),
                       initcap(m.author_role)) author_name
         FROM query_messages m LEFT JOIN users w ON w.id = m.author_id
        WHERE m.query_id = $1 ORDER BY m.sent_at`, [id])).rows);
  }

  /* ------------------------------------------------------------ a receipt

     ONE DOCUMENT, DRAWN ENTIRELY FROM THE DEMAND.

     The receipt row supplies four facts - the number, how it was paid, the
     reference and the day the money was received. Every rupee on this screen
     is read from the demand, which is immutable from the moment it was
     issued. There is no second figure anywhere in this feature, so there is
     nothing that can drift. */
  function receipt(sess, d, no) {
    const r = d.receipts.find(x => x.receipt_no === no);
    if (!r) return null;
    const dm = d.demands.find(x => x.id === r.demand_id);
    if (!dm) return null;
    const st = d.stages.find(x => x.stage_code === dm.stage_code);
    const MODE = { neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI',
      cheque: 'Cheque', draft: 'Demand draft', cash: 'Cash' };

    return desk(sess, '/money', 'Receipt', '', `
${head('Receipt ' + r.receipt_no,
  'For ' + esc(M.money(dm.total_paise)) + ' received on '
  + esc(M.longDate(r.received_on)) + '. This is the office’s acknowledgement '
  + 'that the money arrived.',
  btn('Every payment', { href: '/money', icon: 'back' }))}
${kpis([
  { l: 'Received', icon: 'attend', v: esc(M.money(dm.total_paise)),
    n: 'in full settlement of ' + esc(dm.doc_no) },
  { l: 'On', icon: 'cal', v: esc(M.longDate(r.received_on)),
    n: esc(MODE[r.mode] || r.mode) + ' · ' + esc(r.reference) },
])}
${titled('What it is for', dl([
  ['Villa', esc(d.u.code) + ' · ' + esc(d.u.unit_type || '')],
  ['Buyer', esc(d.u.buyer_name || '')],
  ['Stage', esc(st ? st.name : dm.stage_code)],
  ['Demand', esc(dm.doc_no) + ' · raised ' + esc(M.longDate(dm.raised_at))],
  ['Amount before GST', esc(M.money(dm.base_paise))],
  ['GST', esc(M.money(dm.gst_paise))],
  ...(Number(dm.extras_paise) ? [['Extras', esc(M.money(dm.extras_paise))]] : []),
  ['Total received', esc(M.money(dm.total_paise))],
  ['How', esc(MODE[r.mode] || r.mode) + ' · ' + esc(r.reference)],
  ['Received on', esc(M.longDate(r.received_on))],
  ['Settled in Plint', esc(M.longDate(dm.paid_at))],
]))}
${note('Every figure here is read from demand ' + esc(dm.doc_no) + ', which cannot be '
  + 'edited once issued. The receipt holds no amount of its own, so this document and '
  + 'that demand cannot come to disagree.')}
`);
  }

  /* --------------------------------------------- what Plint holds about you

     THE TECHNICAL HALF OF A DPDP ACCESS REQUEST, AND ONLY THAT HALF.

     What is built here is what can be built without guessing at law: an
     inventory of the personal data this product holds about the person
     reading it, named by table and by column, with who else can read each
     part, and the whole of it as a file they can take away. Every row in it
     is read in the buyer's own database role, so this screen cannot show them
     one field more than the policies already allow.

     WHAT IS DELIBERATELY NOT HERE. No erasure button, no retention countdown
     and no consent record. Each of those needs an answer this codebase cannot
     supply - who the Data Fiduciary is, how long a construction and tax
     record must be kept, what a buyer may withdraw while a contract is
     running - and a screen that guessed would be worse than no screen. */
  const HOLDS = d => [
    ['Who you are', 'users', 'email, display_name, role',
      d.me ? 1 : 0, 'You. The office cannot read it - see below.',
      'Given when your login was issued'],
    ['Your villa and your price', 'units',
      'buyer_name, unit_type, agreement_value_paise, bank, sanction_paise, '
      + 'own_contribution_paise, sanction_letter_ref, channel_partner, '
      + 'site_engineer, relationship_manager',
      1, 'You, the office, the engineer', 'From the builder’s sales record'],
    ['What has been billed', 'demands',
      'doc_no, raised_at, due_at, base_paise, gst_paise, total_paise, paid_at',
      d.demands.length, 'You, the office, the engineer',
      'Raised by Plint when a stage is certified'],
    ['What you have paid', 'receipts', 'receipt_no, mode, reference, received_on',
      d.receipts.length, 'You, the office, the engineer',
      'Recorded by the office when the money arrives'],
    ['Your agreement', 'agreements',
      'sent_to_sign_at, signed_at, registered_at, registration_ref',
      d.agreement ? 1 : 0, 'You, the office, the engineer', 'Entered by the office'],
    ['Who is on the loan', 'loan_applicants', 'full_name, earns, relation',
      d.applicants.length, 'You, the office, the engineer', 'Entered by the office'],
    ['Which papers the office has seen', 'loan_documents',
      'label, seen_at, seen_by', d.papers.length, 'You, the office, the engineer',
      'Ticked off by the office. Plint holds no copy of any paper'],
    ['Photographs of your villa', 'evidence',
      'caption, taken_at, gps, sha256', d.evidence.length,
      'You, the office, the engineer, and your lender in the evidence pack',
      'Taken on site by the engineer'],
    ['Site visits you asked for', 'visits',
      'slot_at, note, requested_at, status, response_note', d.visits.length,
      'You, the office, the engineer', 'Written by you and answered by the engineer'],
    ['Questions you have asked', 'queries, query_messages',
      'subject, body, sent_at', d.queries.length,
      'You, the office, the engineer', 'Written by you and by the office'],
    ['Interior choices', 'choices', 'selected, signed_at, signed_by',
      d.choices.length, 'You, the office, the engineer', 'Signed by you'],
    ['Snags you have raised', 'snags', 'title, raised_at, status, fix_sha256',
      d.snags.length, 'You, the office, the engineer', 'Raised by you or by the office'],
    ['Possession', 'possessions', 'offered_at, snags_cleared_at, handed_over_at, keys_to',
      d.possession ? 1 : 0, 'You, the office, the engineer', 'Entered by the office'],
  ];

  function data(sess, d, msg) {
    const rows = HOLDS(d);
    const total = rows.reduce((t, r) => t + r[3], 0);

    /* HOW LONG, PER KIND, READ FROM THE POLICY RATHER THAN WRITTEN HERE. A
       row of the inventory names one or two tables; the period is the longest
       of theirs, because the shortest would be the one that governs if this
       screen said it and it did not. */
    const years = t => {
      const named = String(t).split(',').map(x => x.trim());
      const found = d.retention.filter(r => named.includes(r.table_name));
      if (!found.length) return null;
      if (found.some(r => r.keep_years == null)) return null;
      return Math.max(...found.map(r => r.keep_years));
    };
    const kept = t => {
      const y = years(t);
      return y == null ? 'While your file is live'
        : y + (y === 1 ? ' year' : ' years') + ' after the record is made';
    };
    const held = d.holds.length ? d.holds[0] : null;

    return desk(sess, '/data', 'What Plint holds', '', `
${head('What Plint holds about you',
  'Every field, named. This page is built out of your own records, read in your '
  + 'own account, so it cannot show you anything the rest of Plint would not.',
  btn('Take a copy', { href: '/data.json', icon: 'doc', dark: true }))}
${kpis([
  { l: 'Records about you', icon: 'doc', v: String(total), n: 'across ' + rows.length + ' kinds' },
  { l: 'Photographs', icon: 'cam', v: String(d.evidence.length), n: 'of your villa, not of you' },
  { l: 'Kept', icon: 'cal', v: held ? 'Frozen' : '8 years',
    n: held ? 'this villa is under a legal hold' : 'and longer where the law requires it',
    tone: held ? 'hot' : null },
])}
${held ? note('<b>Your file is under a legal hold.</b> A ' + esc(held.kind)
  + ' is open' + (held.reference ? ' (' + esc(held.reference) + ')' : '')
  + ' and nothing on this villa can be deleted while it runs, whatever the '
  + 'periods below say. The reason recorded is: ' + esc(held.reason) + '.') : ''}
${titled('Every kind, by table and column', table(
  ['What it is', 'Where it is kept', 'Rows', 'How long it is kept', 'Who can read it'],
  rows.map(r => [
    `<b>${esc(r[0])}</b><br><span class="hsub">${esc(r[5])}</span>`,
    `<span class="num" style="font-size:12px">${esc(r[1])}</span>`
      + `<br><span class="hsub">${esc(r[2])}</span>`,
    num(String(r[3])),
    esc(kept(r[1])),
    esc(r[4]),
  ]),
  /* The column list is the longest text on the screen and it was running
     into the row count beside it. */
  '1.1fr 1.9fr .3fr .9fr 1fr', { min: 980 }))}
${titled('Why eight years', card('', `
<p class="hsub">Because it is the longest period that applies, and a record
destroyed on the shortest is not there for the longest. A demand and a receipt
are vouchers under section 128(5) of the Companies Act, which is eight
financial years. Income tax runs six years for an ordinary reassessment and ten
where escaped income is over fifty lakh - which on a villa at three crore is the
ordinary case, not the exception, so an assessment that is actually open is held
rather than counted. GST is seventy-two months from the annual return, which
falls inside the eight.</p>
<p class="hsub" style="margin-top:10px">Nothing is deleted by a timer today. The
period is recorded and a hold overrides it; what acts on either is a separate
decision that has not been taken.</p>`))}
${titled('What Plint does not hold', card('', `
<p class="hsub">No PAN, no Aadhaar number, no bank statement, no salary slip and no
copy of any paper the bank asks you for. The office ticks off that it has SEEN each
one; the papers themselves go from you to your bank and never come here.</p>
<p class="hsub" style="margin-top:10px">No card number, no bank account number, and no
payment instrument of any kind. A receipt records the reference your bank produced -
a UTR, a cheque number - because that is what proves the transfer.</p>
<p class="hsub" style="margin-top:10px">No location of you. The GPS on a photograph is
where the camera stood on your plot, which is your villa and not your movements.</p>`))}
${titled('Who is responsible for it', card('', `
<p class="hsub"><b>${esc((d.project && d.project.builder_name) || 'The builder')}
is the Data Fiduciary.</b> They decide why your data is collected and what is
done with it, and the notice, the consent and the answer to any grievance are
theirs.</p>
<p class="hsub" style="margin-top:10px"><b>Plint is a Data Processor.</b> It
holds and processes your data on
${esc((d.project && d.project.builder_name) || 'the builder')}'s instruction and
for no purpose of its own. It does not sell it, does not use it to sell you
anything, and does not use it for any other project or customer.</p>
${d.project && d.project.grievance_name ? `<p class="hsub" style="margin-top:10px">
<b>The Grievance Officer for ${esc(d.project.name)}</b> is
${esc(d.project.grievance_name)},
<a href="mailto:${esc(d.project.grievance_email)}">${esc(d.project.grievance_email)}</a>${
  d.project.grievance_phone ? ', ' + esc(d.project.grievance_phone) : ''}. That is
who to write to about your data. Plint cannot answer for
${esc(d.project.builder_name || 'the builder')} and will not pretend to.</p>`
  : `<p class="hsub" style="margin-top:10px">This project has not yet recorded a
Grievance Officer with Plint. Ask the sales office for the builder's, and ask
them to give it to Plint so it appears here.</p>`}`))}
${titled('Who else holds it', table(
  ['Who', 'Why', 'What they hold', 'Where'],
  d.subProcessors.map(sp => [
    `<b>${esc(sp.name)}</b><br><span class="hsub">since ${esc(M.longDate(sp.since))}</span>`,
    esc(sp.purpose), esc(sp.holds), esc(sp.region),
  ]),
  '.8fr 1.2fr 1.8fr .9fr',
  { min: 860, empty: 'Nobody. Plint holds it and nothing else does.' })
  + note('These are Plint’s sub-processors: the services it runs on. Plint '
    + 'may not add to this list without '
    + esc((d.project && d.project.builder_name) || 'the builder')
    + '’s authorisation first, so what is in force is written down and dated.'))}
${titled('Two things this page cannot do', card('', `
<p class="hsub"><b>It cannot show you the audit log.</b> Every certification, every
settlement and every correction writes a row naming who did it. The policy on that
table lets the office and the engineer read it and lets nobody edit or delete it,
including them. It is the record that protects you, and it is deliberately not
readable from a buyer session.</p>
<p class="hsub" style="margin-top:10px"><b>It cannot delete anything.</b> A demand, a
receipt, a certificate and a photograph are the evidence a bank released money
against, and they are also a tax record. What may be erased, and when, is a legal
answer the builder has to give - it is not a switch for software to guess at.</p>`))}
${note('If you want a copy of all of this, the button at the top gives you the whole '
  + 'of it as one file. If you want something in it corrected, ask the office - a '
  + 'demand is never edited, so a correction is a credit against it, which leaves both '
  + 'the mistake and the fix on your file.')}
`, msg);
  }

  /* The same inventory as a file. Assembled from the rows this session can
     already read - there is no privileged query behind it - and it names the
     same columns the screen names, so the two cannot come to disagree. */
  function dataFile(sess, d) {
    return {
      what: 'Everything Plint holds about ' + (d.u.buyer_name || 'this buyer'),
      made_at: new Date().toISOString(),
      read_as: { user: sess.id, role: sess.role, villa: d.u.code },
      /* Who is who, in the file as on the screen. */
      data_fiduciary: d.project ? {
        who: d.project.builder_name, project: d.project.name,
        rera: d.project.builder_ref,
        grievance_officer: d.project.grievance_name,
        grievance_email: d.project.grievance_email,
        grievance_phone: d.project.grievance_phone,
      } : null,
      data_processor: {
        who: 'Plint', on_whose_instruction: d.project && d.project.builder_name,
        sub_processors: d.subProcessors,
      },
      how_long_it_is_kept: d.retention,
      legal_holds_in_force: d.holds,
      not_held: [
        'no PAN, Aadhaar, salary slip, bank statement or copy of any loan paper',
        'no card, account number or payment instrument',
        'no location of the buyer; the GPS on a photograph is the plot',
        'the password hash is never read into this file',
      ],
      you: d.me,
      villa: d.u,
      stages: d.stages,
      demands: d.demands,
      receipts: d.receipts,
      agreement: d.agreement,
      loan_applicants: d.applicants,
      loan_documents: d.papers,
      photographs: d.evidence,
      visits: d.visits,
      questions: d.queries,
      choices: d.choices,
      snags: d.snags,
      possession: d.possession,
    };
  }

  return {
    load, threadOf,
    journey, stage, villa, visit, money, more,
    bank, loan, agreement, choices, questions, documents, receipt,
    data, dataFile,
  };
};
