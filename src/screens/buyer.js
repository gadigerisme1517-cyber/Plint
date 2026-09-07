'use strict';
/* ============================================================================
   The buyer's five tabs, and the five screens behind More.

   v21 gives this role Journey, Villa, Visit, Money and More, with Bank pick,
   Documents, Agreement, Loan and Choices reached from More. Everything here
   reads and writes the same database the other two roles do: the engineer
   marks a stage and it moves on the Journey; the office records a sanction and
   it appears on Loan; the buyer books a visit and it lands in the engineer's
   Visits list; the buyer asks a question and it lands in the office's queue.

   BUILT ON THE SHARED SHELL FROM THE START, which is the whole reason this
   file exists rather than another long page(). The buyer used to be rendered
   by `page()` into `.scroll`, a different container from the one the other two
   roles use, so every gutter, hero and card fix had to be made twice and the
   second time was always later. `desk()` is the shell all three roles share:
   a sidebar on a monitor, v21's five-slot bottom bar on a phone, `.mhead` for
   the hero and `.mbody` for the gutter. Rows come from ./rows, so a villa and
   a stage are one run of text here exactly as they are on the engineer's side,
   and a day count never appears without the pill that says what it means.

   WHAT THIS FILE MAY NOT DO. It does not price a stage, raise a demand, record
   a sanction or write an audit row. It reads the money layer through `M` and
   writes only the things a buyer is allowed to write - a visit request, a
   question, an interior choice, a lender pick - each of which the database
   checks again under row-level security whatever this file believes.

   Dependencies arrive as a context object rather than by requiring server.js,
   because server.js requires this. Nothing is imported across that line.
   ========================================================================= */

module.exports = function buyerScreens(ctx) {
  const { esc, desk, M, asUser } = ctx;

  const { wrow, empty, ageChip, AGE } = require('./rows')({ esc });
  /* The furniture every dashboard is built from. One platform, three
     dashboards: the header, the summary card and the tile grid are defined
     once in ./ui and composed here. Nothing in this file draws its own. */
  const UI = require('./ui')({ esc });

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  const until = d => Math.round((new Date(d).getTime() - Date.now()) / 86400000);
  const flash = m => m
    ? `<div class="tools"><span class="rescount s">${esc(m)}</span><div class="g"></div></div>` : '';

  /* The five tabs themselves live in `destinations()` in server.js, with the
     other two roles', because the tab bar, the sidebar and the app bar all
     read from that one list and a second copy here would drift from it. */

  /* The hero, in one place. Every tab on every role opens with the same
     shape - a count, a title and a sentence - and it was being retyped per
     screen, which is how the office ended up with two counts a line each. */
  /* Same signature as before, so every screen in this file is unchanged; what
     it draws is the shared header and summary card rather than markup of its
     own. `extra` carries the parts and the bar for the screens that are
     dashboards rather than lists. */
  const hero = (count, unitWord, title, sentence, hot, extra) =>
    UI.head(title, sentence, UI.summary({
      cap: unitWord, figure: esc(String(count)), tone: hot ? 'hot' : null,
      parts: extra && extra.parts, bar: extra && extra.bar,
    }) + (extra && extra.tiles ? extra.tiles : ''));

  // ------------------------------------------------------------------ reads

  /** Everything the five tabs need, in one round trip.

      One read for every screen rather than one per screen: the tabs all count
      the same few things, and a buyer's whole file is small enough that a
      second query costs more than it saves. */
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

      const lenders = (await c.query(
        'SELECT * FROM lenders ORDER BY seq')).rows;

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

  /** What a stage is, in one word, and what colour that word is.

      The buyer's vocabulary is not the engineer's: "marked" and "certified"
      are the builder's internal steps and mean nothing to the person paying.
      Both read as "verified on site, no demand yet", because from where the
      buyer sits that is the whole of it. */
  const STATE = {
    paid:      ['Paid', 'ok'],
    demanded:  ['Due now', 'late'],
    certified: ['Verified, demand coming', 'wait'],
    marked:    ['Done on site', 'wait'],
    pending:   ['Not started', 'idle'],
  };
  const stateChip = s => {
    const [word, cls] = STATE[s.status] || STATE.pending;
    return `<i class="chip ${cls}">${esc(word)}</i>`;
  };

  /** The open demand, if there is one, and what it costs today. */
  function openDemand(d) {
    const open = d.demands.filter(x => !x.paid_at).slice(-1)[0] || null;
    if (!open) return null;
    const stage = d.stages.find(s => s.stage_code === open.stage_code);
    return { open, stage, payable: M.payableNow(open) };
  }

  const priceAll = d => M.schedule(d.u.agreement_value_paise, d.stages.map(s => s.pct_bp));

  // ------------------------------------------------------------ 1. Journey

  /* Where the villa has got to. The engineer marks a stage on site and this is
     where the buyer sees it move - the one screen that has to be true within
     seconds of somebody standing in the building. */
  function journey(sess, d, msg) {
    const priced = priceAll(d);
    const done = d.stages.filter(s => s.status === 'paid').length;
    const live = d.stages.find(s => ['demanded', 'certified', 'marked'].includes(s.status));
    const next = d.stages.find(s => s.status === 'pending');

    const rows = d.stages.map((s, i) => {
      const shots = d.evidence.filter(e => e.stage_code === s.stage_code);
      const last = shots[0] ? days(shots[0].taken_at) : null;
      const dem = d.demands.find(x => x.stage_code === s.stage_code);
      /* A finished stage gets a date, not an age. The number here is how old
         the last photograph is, and on a stage that is paid and behind you
         that measures nothing - it was reddening every settled stage on the
         screen, five in a row saying "173d" in the colour the rest of the
         application uses for late. An age is only a verdict while somebody is
         still waiting for the thing it counts. */
      const settled = s.status === 'paid';
      return wrow({
        href: '/stage/' + encodeURIComponent(s.stage_code),
        code: String(i + 1).padStart(2, '0'),
        title: s.name,
        detail: esc(s.description) +
          (shots.length ? ' &middot; ' + shots.length + ' photograph' + (shots.length === 1 ? '' : 's')
                        : ' &middot; no photographs yet')
          + (settled && dem && dem.paid_at ? ' &middot; paid ' + M.longDate(dem.paid_at) : ''),
        chip: stateChip(s),
        /* And where it is still a verdict, it is coloured on the thresholds the
           whole application uses, because the pill here is busy saying what the
           stage is rather than how old it is. */
        days: settled || last === null ? '' : last + 'd',
        daysAge: settled ? null : last,
        amount: M.money(priced[i].totalPaise),
      });
    }).join('');

    const sentence = live
      ? `${esc(live.name)} is the stage in hand. ${done} of ${d.stages.length} paid.`
      : next
        ? `Next is ${esc(next.name.toLowerCase())}. ${done} of ${d.stages.length} paid.`
        : 'Every stage is done and paid.';

    return desk(sess, '/journey', 'Journey', '', `
${hero(done + ' of ' + d.stages.length, 'stages paid', 'Your villa is being built', sentence, false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Every stage, in order</p></div>
<div class="wl">${rows}</div>
</div>`);
  }

  /* One stage, with the photographs the engineer took on site. This is the
     evidence trail the whole product is about, so it is a screen rather than a
     row that expands: a buyer forwards this to a spouse or a lawyer. */
  function stage(sess, d, code, msg) {
    const i = d.stages.findIndex(s => s.stage_code === code);
    if (i < 0) return null;
    const s = d.stages[i];
    const priced = priceAll(d);
    const shots = d.evidence.filter(e => e.stage_code === code);
    const dem = d.demands.find(x => x.stage_code === code);
    const [word] = STATE[s.status] || STATE.pending;

    return desk(sess, '/journey', s.name, '', `
${hero(shots.length, shots.length === 1 ? 'photograph' : 'photographs', s.name,
  esc(s.description) + ' &middot; ' + esc(word) + ' &middot; ' + M.money(priced[i].totalPaise),
  s.status === 'demanded')}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/journey" style="text-decoration:none">Back</a><div class="g"></div></div>
${dem ? `<div class="blk"><p class="k">What was raised</p></div>
<div class="wl">${wrow({
  title: 'Demand ' + dem.doc_no,
  detail: 'Raised ' + M.longDate(dem.raised_at) + ' &middot; due ' + M.longDate(dem.due_at)
    + (dem.paid_at ? ' &middot; paid ' + M.longDate(dem.paid_at) : ''),
  chip: dem.paid_at ? '<i class="chip ok">Paid</i>' : '<i class="chip late">Unpaid</i>',
  amount: M.money(dem.total_paise),
  action: '<a class="wbtn st" href="/doc/demand/' + esc(s.id) + '.pdf" style="text-decoration:none">Letter</a>',
})}</div><div class="gap"></div>` : ''}
<div class="blk"><p class="k">Photographs from site</p></div>
<div class="wl">${shots.length ? shots.map(p => wrow({
  title: p.caption,
  detail: 'Taken ' + M.longDate(p.taken_at) + ' &middot; ' + esc(p.gps),
  days: days(p.taken_at) + 'd',
  daysAge: days(p.taken_at),
})).join('') : empty('No photographs of this stage yet. The engineer takes them on site.')}</div>
</div>`);
  }

  // -------------------------------------------------------------- 2. Villa

  /* The villa's own facts, and nothing else. Money is its own tab and the
     schedule is the Journey; what is left here is what the buyer is actually
     buying and who is responsible for it. */
  function villa(sess, d, msg) {
    const u = d.u;
    const p = d.possession;
    const openSnags = d.snags.filter(s => s.status === 'open').length;

    const facts = [
      ['Unit', u.unit_type, null],
      ['Agreement value', M.money(u.agreement_value_paise), null],
      ['Lender', u.bank || 'Self funded', null],
      ['Site engineer', u.site_engineer, null],
    ].map(([k, v]) => wrow({ title: k, amount: esc(String(v)) })).join('');

    const handover = p ? [
      ['Offered for possession', p.offered_at],
      ['Snags cleared', p.snags_cleared_at],
      ['Handed over', p.handed_over_at],
    ].map(([k, at]) => wrow({
      title: k,
      detail: at ? 'Recorded by the office' : 'Not yet',
      chip: at ? '<i class="chip ok">Done</i>' : '<i class="chip idle">Waiting</i>',
      days: at ? days(at) + 'd' : '',
      daysAge: at ? days(at) : null,
    })).join('') : empty('Possession has not been scheduled. It is recorded by the office.');

    return desk(sess, '/villa/' + encodeURIComponent(u.code), 'Villa ' + u.code, '', `
${hero(u.code, 'your villa', 'Villa ' + u.code,
  esc(u.unit_type) + ' &middot; ' + esc(u.buyer_name) + ' &middot; '
  + esc(u.bank || 'self funded'), false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">The villa</p></div>
<div class="wl">${facts}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Snags you have raised</p></div>
<div class="wl">${d.snags.length ? d.snags.map(s => wrow({
  title: s.title,
  detail: esc(s.detail || 'No detail given.'),
  chip: s.status === 'open' ? '<i class="chip late">Open</i>' : '<i class="chip ok">Closed</i>',
  days: days(s.raised_at) + 'd',
  daysAge: s.status === 'open' ? days(s.raised_at) : null,
})).join('') : empty('No snags on this villa.')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Handover</p></div>
<div class="wl">${handover}</div>
</div>`);
  }

  // -------------------------------------------------------------- 3. Visit

  /* Booking a site visit, and what the engineer said back. The engineer's
     answer lands here without anything else happening: they accept on the
     Visits tab and the chip on this row changes. */
  function visit(sess, d, msg) {
    const upcoming = d.visits.filter(v => v.status !== 'declined' && new Date(v.slot_at) > new Date());
    const CHIP = {
      requested: ['Waiting for the engineer', 'wait'],
      confirmed: ['Accepted', 'ok'],
      declined:  ['Declined', 'late'],
      reassign:  ['Being reassigned', 'warn'],
      done:      ['Done', 'idle'],
    };

    // Three days out, at a time somebody is actually on site.
    const soon = new Date(Date.now() + 3 * 86400000);
    const suggested = soon.toISOString().slice(0, 10);

    return desk(sess, '/visit', 'Visit', '', `
${hero(upcoming.length, upcoming.length === 1 ? 'visit booked' : 'visits booked', 'Come and see the site',
  'You are shown round by the engineer who signs your certificates. '
  + 'Anything you flag on the day is written down before you leave.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Ask for a visit</p></div>
<div class="wl"><form class="uprow reassign" method="post" action="/visit"
  style="display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--hair);border-radius:12px;background:var(--paper)">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">A day that suits you, and what you want to see</span>
<input class="fi" type="date" name="day" value="${esc(suggested)}" min="${esc(new Date().toISOString().slice(0, 10))}"
  style="margin:0;flex:0 0 170px">
<input class="fi" type="text" name="note" maxlength="140" placeholder="What you want to look at"
  style="margin:0;flex:1 1 220px"></span>
<button class="wbtn solid st" type="submit">Ask</button></form></div>
<div class="gap"></div>
<div class="blk"><p class="k">Your visits</p></div>
<div class="wl">${d.visits.length ? d.visits.map(v => {
  const [word, cls] = CHIP[v.status] || CHIP.requested;
  const away = until(v.slot_at);
  return wrow({
    title: M.longDate(v.slot_at),
    detail: esc(v.note || 'No note.')
      + (v.engineer_name ? ' &middot; ' + esc(v.engineer_name) : '')
      + (v.response_note ? ' &middot; ' + esc(v.response_note) : ''),
    chip: `<i class="chip ${cls}">${esc(word)}</i>`,
    days: away >= 0 ? 'in ' + away + 'd' : days(v.slot_at) + 'd ago',
    daysAge: away >= 0 ? null : days(v.slot_at),
  });
}).join('') : empty('You have not asked for a visit yet.')}</div>
</div>`);
  }

  // -------------------------------------------------------------- 4. Money

  /* Every rupee, in the order it is asked for. The hero is the one figure that
     matters today; the rows below it are the whole schedule so nothing about
     the amount is a surprise when it arrives. */
  function money(sess, d, msg) {
    const priced = priceAll(d);
    const led = M.ledger({ agreementValuePaise: d.u.agreement_value_paise, stages: d.stages });
    const o = openDemand(d);

    const totals = [
      ['Paid so far', led.paidPaise],
      ['Demanded, unpaid', led.demandedPaise],
      ['Not yet due', led.remainingPaise],
      ['Agreement value', d.u.agreement_value_paise],
    ].map(([k, v]) => wrow({ title: k, amount: M.money(v) })).join('');

    const raised = d.demands.slice().reverse().map(x => {
      const st = d.stages.find(s => s.stage_code === x.stage_code);
      const late = !x.paid_at && new Date(x.due_at) < new Date();
      return wrow({
        code: st ? String(d.stages.indexOf(st) + 1).padStart(2, '0') : '',
        title: st ? st.name : x.stage_code,
        detail: 'Demand ' + esc(x.doc_no) + ' &middot; raised ' + M.longDate(x.raised_at)
          + ' &middot; due ' + M.longDate(x.due_at),
        chip: x.paid_at ? '<i class="chip ok">Paid</i>'
          : late ? '<i class="chip late">Overdue</i>' : '<i class="chip wait">Due</i>',
        days: x.paid_at ? '' : days(x.raised_at) + 'd',
        daysAge: x.paid_at ? null : days(x.raised_at),
        amount: M.money(x.paid_at ? x.total_paise : M.payableNow(x)),
        action: '<a class="wbtn st" href="/doc/demand/' + esc(x.unit_stage_id)
          + '.pdf" style="text-decoration:none">Letter</a>',
      });
    }).join('');

    return desk(sess, '/money', 'Money', '', `
${hero(o ? M.money(o.payable) : M.money(0), o ? 'due now' : 'due', 'What you owe today',
  o ? esc(o.stage.name) + ', ' + (o.stage.pct_bp / 100) + ' per cent, plus GST. Due '
      + M.longDate(o.open.due_at) + '. After that date interest runs at twelve per cent a year.'
    : 'Nothing is due. A demand is raised only when a stage is verified on site.',
  !!o)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Where you stand</p></div>
<div class="wl">${totals}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Demands raised</p></div>
<div class="wl">${d.demands.length ? raised
  : empty('No demand has been raised yet. One follows each verified stage.')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">The rest of the schedule</p></div>
<div class="wl">${d.stages.map((s, i) => s.status === 'paid' || s.status === 'demanded' ? '' : wrow({
  code: String(i + 1).padStart(2, '0'),
  title: s.name,
  detail: (s.pct_bp / 100) + ' per cent of the agreement value, plus GST',
  chip: stateChip(s),
  amount: M.money(priced[i].totalPaise),
})).join('')}</div>
</div>`);
  }

  // --------------------------------------------------------------- 5. More

  /* The hub. Everything that is not a daily question lives one tap behind
     here, and each row says what is waiting rather than only naming a screen -
     a list of five labels tells the buyer nothing about which one needs them. */
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
        d.u.bank ? '<i class="chip ok">Picked</i>' : '<i class="chip late">Pick one</i>'],
      ['/loan', 'Your loan', d.u.sanction_recorded_at
        ? M.money(d.u.sanction_paise) + ' sanctioned'
        : d.u.bank ? 'No sanction on file yet' : 'Self funded',
        d.u.sanction_recorded_at ? '<i class="chip ok">Recorded</i>'
          : d.u.bank ? '<i class="chip late">Not recorded</i>' : '<i class="chip idle">Not needed</i>'],
      ['/documents', 'What the bank will ask for', d.papers.length
        ? seen + ' of ' + d.papers.length + ' seen by the office'
        : 'The papers to keep ready. A list only.',
        d.papers.length ? '<i class="chip wait">' + seen + '/' + d.papers.length + '</i>' : ''],
      ['/agreement', 'Your agreement', esc(agWord),
        ag && ag.registered_at ? '<i class="chip ok">Registered</i>'
          : ag && ag.signed_at ? '<i class="chip wait">Signed</i>'
          : '<i class="chip late">Open</i>'],
      ['/choices', 'Interior choices', unsigned.length
        ? unsigned.length + ' still to sign'
        : 'All signed. The site builds what you chose.',
        unsigned.length ? '<i class="chip late">' + unsigned.length + ' open</i>'
          : '<i class="chip ok">Signed</i>'],
      ['/questions', 'Questions you have asked', openQ
        ? openQ + ' open with the office'
        : d.queries.length ? 'All answered.' : 'Ask the office anything about your villa.',
        openQ ? '<i class="chip wait">' + openQ + ' open</i>' : ''],
    ].map(([href, title, detail, chip]) => wrow({ href, title, detail, chip })).join('');

    return desk(sess, '/more', 'More', '', `
${hero(unsigned.length + openQ + (d.u.bank && !d.u.sanction_recorded_at ? 1 : 0), 'need you',
  'Everything else about your file',
  unsigned.length || openQ
    ? 'Choices to sign and questions in hand. The rest is here for reference.'
    : 'Nothing is waiting on you. The rest is here for reference.',
  !!(unsigned.length || openQ))}
<div class="mbody anim">
${flash(msg)}
${unsigned.length && soonest !== undefined ? `<div class="tools"><a class="wbtn solid st" href="/choices"
  style="text-decoration:none">Sign ${unsigned.length} choice${unsigned.length === 1 ? '' : 's'}</a>
<span class="rescount s">${soonest < 0 ? 'The earliest was needed ' + (-soonest) + ' days ago'
  : 'The earliest is needed in ' + soonest + ' days'}</span><div class="g"></div></div>` : ''}
<div class="wl">${rows}</div>
<div class="gap"></div>
<div class="tools"><a class="wbtn st" href="/logout" style="text-decoration:none">Sign out</a><div class="g"></div></div>
</div>`);
  }

  // ------------------------------------------------------------- Bank pick

  /* The lender decides how long money takes to arrive, so this screen leads
     with the turnaround rather than the rate: a buyer who picks on rate alone
     and then waits five weeks per stage has made the wrong trade. */
  function bank(sess, d, msg) {
    const panel = d.lenders.filter(l => l.on_panel);
    const off = d.lenders.filter(l => !l.on_panel);
    const picked = d.u.bank;

    const row = l => wrow({
      cls: picked === l.name ? 'picked' : '',
      title: l.name,
      detail: (l.rate_bp / 100).toFixed(2) + ' per cent &middot; '
        + (l.apf_code ? 'project approved, ' + esc(l.apf_code) : 'not approved for this project')
        + ' &middot; releases in ' + l.turnaround_low + ' to ' + l.turnaround_high + ' days',
      chip: picked === l.name ? '<i class="chip ok">Yours</i>'
        : l.apf_code ? '<i class="chip wait">On panel</i>' : '<i class="chip idle">Off panel</i>',
      days: l.turnaround_high + 'd',
      /* The same thresholds the rest of the application uses for an age, read
         here as a wait: three weeks to release money is late wherever it
         appears, and the reader should not have to score it twice. */
      daysAge: l.turnaround_high,
      action: picked === l.name ? 'Picked'
        : `<form method="post" action="/bank"><input type="hidden" name="lender" value="${esc(l.id)}">
<button class="wbtn st" type="submit">Pick</button></form>`,
      actionIsText: picked === l.name,
    });

    return desk(sess, '/more', 'Your bank', '', `
${hero(panel.length, 'on the panel', 'Who lends you the money',
  'A lender on the panel has already approved this project, so your file skips '
  + 'the survey. The number that matters is how long they take to release each '
  + 'stage, not the rate.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">On this project's panel</p></div>
<div class="wl">${panel.map(row).join('')}</div>
${off.length ? `<div class="gap"></div>
<div class="blk"><p class="k">Not on the panel</p></div>
<div class="wl">${off.map(row).join('')}</div>` : ''}
</div>`);
  }

  // ----------------------------------------------------------------- Loan

  /* What the office has recorded, and nothing the buyer can edit. A sanction
     is a fact about a letter the office has seen; it is recorded there and
     read here, which is the whole cross-role point of the screen. */
  function loan(sess, d, msg) {
    const u = d.u;
    const rec = !!u.sanction_recorded_at;
    const rows = [
      ['Lender', u.bank || 'Self funded'],
      ['Sanctioned', rec ? M.money(u.sanction_paise) : 'Not recorded'],
      ['Your own contribution', rec ? M.money(u.own_contribution_paise) : 'Not recorded'],
      ['Recorded', rec ? M.longDate(u.sanction_recorded_at) : 'Not yet'],
    ].map(([k, v]) => wrow({ title: k, amount: esc(String(v)) })).join('');

    const applicants = d.applicants.map(a => {
      const mine = d.papers.filter(p => p.applicant_id === a.id);
      const seen = mine.filter(p => p.seen_at).length;
      return wrow({
        href: '/documents',
        title: a.full_name,
        detail: esc(a.relation) + ' &middot; ' + (a.earns === 'salaried' ? 'salaried' : 'self employed')
          + ' &middot; ' + mine.length + ' paper' + (mine.length === 1 ? '' : 's'),
        chip: seen === mine.length && mine.length
          ? '<i class="chip ok">All seen</i>' : `<i class="chip wait">${seen}/${mine.length}</i>`,
      });
    }).join('');

    return desk(sess, '/more', 'Your loan', '', `
${hero(rec ? M.money(u.sanction_paise) : 'None', rec ? 'sanctioned' : 'recorded',
  rec ? 'Your sanction is on file' : 'No sanction on file',
  rec ? 'Recorded by the sales office from your sanction letter. Every stage '
        + 'demand is checked against it before money moves.'
      : u.bank
        ? 'Bring your sanction letter to the sales office. Until it is recorded, '
          + 'no stage can release money.'
        : 'You are funding this yourself, so there is nothing to record.',
  !rec && !!u.bank)}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">What the office has recorded</p></div>
<div class="wl">${rows}</div>
${d.applicants.length ? `<div class="gap"></div>
<div class="blk"><p class="k">Who is on the application</p></div>
<div class="wl">${applicants}</div>` : ''}
</div>`);
  }

  // ------------------------------------------------------------ Agreement

  function agreement(sess, d, msg) {
    const a = d.agreement;
    const steps = [
      ['Sent to you to sign', a && a.sent_to_sign_at],
      ['Signed', a && a.signed_at],
      ['Registered', a && a.registered_at],
    ].map(([k, at]) => wrow({
      title: k,
      detail: at ? M.longDate(at) : 'Not yet',
      chip: at ? '<i class="chip ok">Done</i>' : '<i class="chip idle">Waiting</i>',
      days: at ? days(at) + 'd' : '',
      daysAge: at ? days(at) : null,
    })).join('');

    const doneCount = a ? [a.sent_to_sign_at, a.signed_at, a.registered_at].filter(Boolean).length : 0;

    return desk(sess, '/more', 'Your agreement', '', `
${hero(doneCount + ' of 3', 'steps done', 'The sale agreement',
  a && a.registered_at
    ? 'Registered as ' + esc(a.registration_ref) + '. Nothing further is needed from you.'
    : 'The office records each step as it happens. Registration is what makes the '
      + 'sale enforceable, and it is the step lenders ask for.',
  !(a && a.registered_at))}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">Where it has got to</p></div>
<div class="wl">${steps}</div>
</div>`);
  }

  // -------------------------------------------------------------- Choices

  /* An interior choice is a decision the site builds against, so an unsigned
     preference is not a choice. Signing is the write; it is the only place the
     buyer changes something the engineer will act on. */
  function choices(sess, d, msg) {
    const rows = d.choices.map(c => {
      const left = until(c.needed_by);
      if (c.selected) {
        return wrow({
          title: c.label,
          detail: esc(c.detail) + ' &middot; you chose ' + esc(c.selected)
            + ' on ' + M.longDate(c.signed_at),
          chip: '<i class="chip ok">Signed</i>',
        });
      }
      return wrow({
        cls: 'choice',
        title: c.label,
        detail: esc(c.detail) + ' &middot; needed by ' + M.longDate(c.needed_by),
        chip: left < 0 ? '<i class="chip late">Overdue</i>'
          : left <= AGE.ageing ? '<i class="chip warn">Due soon</i>' : '<i class="chip wait">Open</i>',
        days: left < 0 ? (-left) + 'd late' : 'in ' + left + 'd',
        daysAge: left < 0 ? AGE.overdue : left <= AGE.ageing ? AGE.ageing : 0,
        actionWide: true,
        action: `<form class="uprow reassign" method="post" action="/choices"
  style="display:flex;gap:10px;align-items:center;width:100%">
<input type="hidden" name="id" value="${esc(c.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Choose and sign</span>
<select class="fi" name="option" style="margin:0;flex:0 0 200px">${
  c.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></span>
<button class="wbtn solid st" type="submit">Sign</button></form>`,
      });
    }).join('');

    const open = d.choices.filter(c => !c.selected).length;

    return desk(sess, '/more', 'Interior choices', '', `
${hero(open, open === 1 ? 'to sign' : 'to sign', 'What goes inside',
  'The site builds what you sign here. An unsigned preference is not a decision, '
  + 'so nothing is ordered until you sign it.', open > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="wl">${d.choices.length ? rows : empty('No choices are open on this villa.')}</div>
</div>`);
  }

  // ------------------------------------------------------------ Documents

  /* What the bank will ask for. v21's loan model: the builder does not chase
     papers and Plint holds none of them, so this is a list and a state of
     play, and that is deliberately all it is.

     It reads `loan_applicants` and `loan_documents` rather than a constant.
     The screen used to invent two applicants and count a hard-coded list to
     reach v21's fourteen, which meant the number was right and everything
     under it was a drawing: the office ticks a paper as seen and nothing here
     moved, because there was nothing here to move. */
  function documents(sess, d, msg) {
    const seen = d.papers.filter(x => x.seen_at).length;

    const perApplicant = d.applicants.map(a => {
      const mine = d.papers.filter(x => x.applicant_id === a.id);
      return `<div class="blk"><p class="k">${esc(a.full_name)} &middot; ${
        esc(a.earns === 'salaried' ? 'salaried' : 'self employed')} &middot; ${esc(a.relation)}</p></div>
<div class="wl">${mine.length ? mine.map(x => wrow({
  title: x.label,
  detail: x.seen_at ? 'Seen by the office on ' + M.longDate(x.seen_at)
                    : 'Keep this ready. You give it to the bank yourself.',
  chip: x.seen_at ? '<i class="chip ok">Seen</i>' : '<i class="chip idle">Not yet</i>',
  days: x.seen_at ? days(x.seen_at) + 'd' : '',
  daysAge: x.seen_at ? days(x.seen_at) : null,
})).join('') : empty('No papers listed for this applicant.')}</div><div class="gap"></div>`;
    }).join('');

    return desk(sess, '/more', 'Papers', '', `
${hero(d.papers.length, d.papers.length === 1 ? 'paper' : 'papers', 'What the bank will ask for',
  'A list, so you can keep them ready. You give these to '
  + esc(d.u.bank || 'your bank') + ' directly. Plint holds no loan papers and '
  + 'sends nothing to any bank.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a>
<span class="rescount s">${seen} of ${d.papers.length} seen by the office</span><div class="g"></div></div>
${d.applicants.length ? perApplicant
  : `<div class="wl">${empty('Nobody is on a loan application for this villa yet.')}</div>`}
<div class="blk"><p class="s">${d.u.sanction_recorded_at
  ? 'Your sanction is recorded. Every stage finished on site now releases your money, and you can watch each release.'
  : 'When your loan is approved, bring the sanction letter to the sales office. From that point every stage finished on site releases your money.'}</p></div>
</div>`);
  }

  // ------------------------------------------------------------ Questions

  /* Raised here, worked in the office. The thread is the record: a buyer who
     was told something on the phone has nothing, and this is the answer to
     that. */
  function questions(sess, d, thread, msg) {
    if (thread) {
      const q = d.queries.find(x => x.id === thread);
      if (!q) return null;
      return desk(sess, '/more', q.subject, '', `
${hero(q.replies, q.replies === 1 ? 'message' : 'messages', q.subject,
  (q.kind === 'warranty' ? 'Warranty claim' : 'Question') + ' &middot; raised '
  + M.longDate(q.raised_at) + ' &middot; ' + esc(q.status), q.status === 'open')}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/questions" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">The thread</p></div>
<div class="wl" id="thread">${(d.thread || []).length ? d.thread.map(m => wrow({
  title: m.author_role === 'buyer' ? 'You' : m.author_name,
  detail: esc(m.body),
  days: days(m.sent_at) + 'd',
  daysAge: null,
  chip: `<i class="chip ${m.author_role === 'buyer' ? 'idle' : 'wait'}">${esc(m.author_role)}</i>`,
})).join('') : empty('Nothing has been said on this yet.')}</div>
<div class="gap"></div>
<div class="wl"><form class="uprow reassign" method="post" action="/questions/reply"
  style="display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--hair);border-radius:12px;background:var(--paper)">
<input type="hidden" name="id" value="${esc(q.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Add to this thread</span>
<input class="fi" type="text" name="body" maxlength="400" required placeholder="What you want to say"
  style="margin:0;flex:1 1 220px"></span>
<button class="wbtn solid st" type="submit">Send</button></form></div>
</div>`);
    }

    const open = d.queries.filter(q => q.status === 'open').length;
    return desk(sess, '/more', 'Questions', '', `
${hero(open, open === 1 ? 'open' : 'open', 'Ask the office',
  'Anything about your villa, your money or your papers. It goes into the '
  + 'office queue with your villa attached, and the thread stays here.', open > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/more" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">Ask something</p></div>
<div class="wl"><form class="uprow reassign" method="post" action="/questions"
  style="display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--hair);border-radius:12px;background:var(--paper)">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">What do you want to ask?</span>
<select class="fi" name="kind" style="margin:0;flex:0 0 150px">
<option value="query">A question</option><option value="warranty">A warranty claim</option></select>
<input class="fi" type="text" name="subject" maxlength="120" required placeholder="In one line"
  style="margin:0;flex:1 1 200px"></span>
<button class="wbtn solid st" type="submit">Ask</button></form></div>
<div class="gap"></div>
<div class="blk"><p class="k">What you have asked</p></div>
<div class="wl">${d.queries.length ? d.queries.map(q => wrow({
  href: '/questions/' + encodeURIComponent(q.id),
  title: q.subject,
  detail: (q.kind === 'warranty' ? 'Warranty claim' : 'Question')
    + ' &middot; raised ' + M.longDate(q.raised_at)
    + ' &middot; ' + q.replies + ' message' + (q.replies === 1 ? '' : 's'),
  chip: q.status === 'open' ? '<i class="chip late">Open</i>'
    : q.status === 'answered' ? '<i class="chip wait">Answered</i>' : '<i class="chip ok">Closed</i>',
  days: days(q.raised_at) + 'd',
  daysAge: q.status === 'open' ? days(q.raised_at) : null,
})).join('') : empty('You have not asked anything yet.')}</div>
</div>`);
  }

  /** The messages on one thread, read separately because only one screen wants them. */
  async function threadOf(sess, id) {
    /* LEFT JOIN, and a fallback to the side that wrote it, because `users` is
       behind row-level security: a buyer may read only their own row. An inner
       join here does not error, it silently returns nothing - so the buyer
       would have seen their own messages on the thread and never one of the
       office's replies. The table holds password hashes, so widening the
       policy to put a name on a message is not the trade. */
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
