'use strict';
/* ============================================================================
   The head office: fifteen destinations in nine groups, and the buyer file.

   The groups and their order are v21's, verbatim from its `groups` array. They
   are not a menu somebody arranged by feel: each one names who is being waited
   on, and the sequence walks a file from the moment sales let go of it to the
   moment the last account is transferred after possession. "Waiting on you" is
   above "Waiting on the bank" because one of those is the office's own delay
   and the other is not.

   FIFTEEN IS WHY THIS ROLE HAS A MENU AND THE OTHER TWO HAVE A BAR. v21's
   `.nav five` is a shape that holds five; the buyer and the engineer have
   exactly five and keep the bar. Fifteen is not a bar at any width, so the
   office gets a button that opens the same nine groups the sidebar draws on a
   monitor. One list, in `destinations()`, rendered three ways.

   WHAT THIS FILE MAY NOT DO. It does not price a stage, raise a demand, or
   record a sanction: those go through the money layer and `record_sanction`,
   which are the only paths that touch money and the only ones that write an
   audit row. Reassignment goes through `assign_engineer`. Everything here
   either reads, or writes a row whose whole content is "somebody in this
   office dealt with this".

   Dependencies arrive as a context object rather than by requiring server.js,
   because server.js requires this. Nothing is imported across that line.
   ========================================================================= */

module.exports = function officeScreens(ctx) {
  const { esc, desk, M, asUser, schedules, stageTotal } = ctx;

  const { wrow, whead, empty, ageChip, AGE } = require('./rows')({ esc });

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  const until = d => Math.round((new Date(d).getTime() - Date.now()) / 86400000);
  const flash = m => m
    ? `<div class="tools"><span class="rescount s">${esc(m)}</span><div class="g"></div></div>` : '';

  /* v21's nine groups and fifteen destinations, in v21's order. The first
     group has no heading because Today and Owner view are not a category -
     they are where you start and where you stand back. */
  const GROUPS = [
    ['', [
      ['today',      'Today'],
      ['owner',      'Owner view'],
    ]],
    ['New from sales', [
      ['handoff',    'Waiting for pickup'],
    ]],
    ['Waiting on you', [
      ['packs',      'Ready to send'],
      ['query',      'Lender asked a question'],
    ]],
    ['Buyer loans', [
      ['chase',      'Sanction not recorded'],
    ]],
    ['Chasing your team', [
      ['signoff',    'Sign-off and evidence'],
      ['silent',     'Site gone quiet'],
    ]],
    ['Waiting on the bank', [
      ['wait',       'Sent, not yet paid'],
    ]],
    ['Your own money', [
      ['escrow',     'Escrow drawdown'],
    ]],
    ['Buyer decisions', [
      ['choices',    'Choices not made'],
      ['warranty',   'Warranty claims'],
    ]],
    ['Compliance', [
      ['evidence',   'Evidence certificates'],
      ['qpr',        'Quarterly RERA filing'],
      ['possession', 'After possession'],
    ]],
  ];

  /* One icon per destination, in v21's stroke style: 24x24, 1.6 stroke, round
     caps. A menu of fifteen labels is a wall of text - the icon is what lets
     somebody find "Escrow drawdown" without reading the eight words above it,
     and it is the thing the row is recognised by after the second week. */
  const ICON = {
    today:      'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
    owner:      'M4 19V5m0 14h16M8 16V9m4 7v-4m4 4V7',
    handoff:    'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4Z',
    packs:      'M4 8 12 4l8 4v8l-8 4-8-4Zm0 0 8 4m0 0 8-4m-8 4v8',
    query:      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 13v.5M9.6 9.2A2.4 2.4 0 1 1 12 12v1.2',
    chase:      'M6 3h8l4 4v14H6Zm8 0v4h4M12 11v3m0 3v.5',
    signoff:    'M4.5 12.5 9 17l10.5-11',
    silent:     'M3 3l18 18M9.5 5h5l1.5 2H20v9M4 7h1.5M4 7v11h12',
    wait:       'M7 3h10M7 21h10M17 3v4l-5 5 5 5v4M7 3v4l5 5-5 5v4',
    escrow:     'M3 9 12 4l9 5M5 9v9m4-9v9m6-9v9m4-9v9M3 20h18',
    choices:    'M4 7h10M4 12h10M4 17h6M17 15l2 2 3.5-4',
    warranty:   'M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6Z',
    evidence:   'M4 8h3l1.5-2h7L17 8h3v11H4Zm8 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
    qpr:        'M6 3h8l4 4v14H6Zm8 0v4h4M9 13h6M9 17h4',
    possession: 'M14.5 4a4.5 4.5 0 1 1-3.2 7.7L4 19v2h3v-2h2v-2h2l1.3-1.3A4.5 4.5 0 0 1 14.5 4Zm1.5 3.5v.01',
  };
  const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;

  /** Every key, flat, so a route can decide in one lookup whether it is ours. */
  const KEYS = new Set(GROUPS.flatMap(([, items]) => items.map(([k]) => k)));

  /** v21's own headline and subtitle for each screen, kept as it wrote them. */
  const HEAD = {
    today:      ['Today', 'What is on this office now'],
    owner:      ['Owner view', 'The position, not the worklist'],
    handoff:    ['New from sales', 'Buyers who have paid a token and have no owner yet'],
    packs:      ['Ready to send', 'Stage verified. Pack generated. Not yet with the lender'],
    query:      ['Lender questions', 'Open queries holding a disbursement'],
    chase:      ['Sanction not recorded', 'Buyers with no sanction letter on file yet. '
                 + 'Nothing can be disbursed against a stage until this is marked.'],
    signoff:    ['Sign-off and evidence', 'Stages marked done on site, not yet certified'],
    silent:     ['Site quiet', 'No photograph in three weeks'],
    wait:       ['Sent, not paid', 'With the lender over fourteen days'],
    escrow:     ['Escrow drawdown', 'What may be withdrawn from the designated account'],
    choices:    ['Buyer choices', 'Selections not yet made'],
    warranty:   ['Warranty claims', 'Open snags within the twelve-month period'],
    evidence:   ['Evidence certificates', 'Section 63 certificate, hash and signatures'],
    qpr:        ['RERA filing', 'Quarterly progress report'],
    possession: ['After possession', 'Khata, meters, corpus and accounts still to transfer'],
  };

  const href = k => k === 'today' ? '/office' : '/office/' + k;

  /* Fourteen days with a lender is v21's threshold for chasing a pack, and it
     is not the same number as the twenty-one days that make a site quiet. Both
     are here rather than typed into the queries that use them. */
  const PACK_LATE_DAYS = 14;

  const hero = (count, unitWord, title, sentence, hot) => `
<div class="mhead"><div class="hstrip">
<div class="g"><h1 class="pgt">${esc(title)}</h1>
<p class="s" style="margin-top:2px">${sentence}</p></div>
<div class="kpi"><span class="kpin ${hot ? 'hot' : ''}">${esc(String(count))}</span>
<span class="k">${esc(unitWord)}</span></div>
</div></div>`;

  // ------------------------------------------------------------------ counts

  /* One query for all fifteen counts, because the sidebar draws every one of
     them on every screen. Fifteen separate round trips to render a menu would
     be fifteen round trips on every page in the role. */
  async function counts(c) {
    const r = (await c.query(`
      SELECT
        (SELECT count(*) FROM handoffs WHERE picked_up_at IS NULL)                       handoff,
        (SELECT count(*) FROM pack_deliveries WHERE state = 'queued')                    packs,
        (SELECT count(*) FROM pack_queries WHERE answered_at IS NULL)                    query,
        (SELECT count(*) FROM units
          WHERE bank IS NOT NULL AND sanction_recorded_at IS NULL)                       chase,
        (SELECT count(*) FROM unit_stages WHERE status = 'marked')                       signoff,
        (SELECT count(*) FROM units u WHERE NOT EXISTS (
            SELECT 1 FROM evidence e JOIN unit_stages s ON s.id = e.unit_stage_id
             WHERE s.unit_id = u.id AND e.taken_at > now() - ($1 || ' days')::interval))  silent,
        (SELECT count(*) FROM pack_deliveries d
           JOIN unit_stages s ON s.id = d.unit_stage_id
           JOIN demands dm ON dm.unit_stage_id = s.id
          WHERE d.state = 'delivered' AND dm.paid_at IS NULL
            AND d.delivered_at < now() - ($2 || ' days')::interval)                      wait,
        (SELECT count(*) FROM choices WHERE selected IS NULL)                            choices,
        (SELECT count(*) FROM queries WHERE kind = 'warranty' AND status <> 'closed')    warranty,
        (SELECT count(*) FROM qpr_filings WHERE filed_at IS NULL)                        qpr,
        (SELECT count(*) FROM possessions WHERE handed_over_at IS NOT NULL)              possession,
        (SELECT count(*) FROM queries WHERE kind = 'query' AND status = 'open')          questions
      `, [String(AGE.overdue), String(PACK_LATE_DAYS)])).rows[0];
    for (const k of Object.keys(r)) r[k] = Number(r[k]);
    /* Owner view, escrow and evidence carry no count in v21 - they are a
       position rather than a queue, and a number beside them would read as
       work outstanding. `null` is what the sidebar renders as nothing. */
    r.today = null; r.owner = null; r.escrow = null; r.evidence = null;
    return r;
  }

  // -------------------------------------------------------------- the sidebar

  /* Rendered by `desk()` for the other two roles from `destinations()`. The
     office cannot use that: fifteen flat links are a list, and the nine
     headings are what make it navigation. So this role draws its own, in the
     same `.side` markup v21 uses, and `desk()` is handed it. */
  function sidebar(current, n) {
    return GROUPS.map(([g, items]) =>
      (g ? `<p class="k grp">${esc(g)}</p>` : '') +
      items.map(([k, label]) => {
        const c = n[k];
        /* `aria-current` as well as v21's `aria-selected`: the first is what a
           screen reader announces for the page you are on, and it is what the
           shell test looks for across all three roles. */
        return `<a class="sbtn st" href="${href(k)}" aria-selected="${current === k}"${
          current === k ? ' aria-current="page"' : ''}
 style="text-decoration:none;display:flex;align-items:center;gap:8px">${esc(label)}${
   c === null || c === undefined ? ''
     : `<span class="c${c === 0 ? ' zero' : ''}">${c}</span>`}</a>`;
      }).join('')).join('');
  }

  /* The same nine groups as a drawer over whatever you were looking at.

     It was a screen: you tapped Menu, the page navigated, and you arrived
     somewhere that looked like every other screen in the role. That reads as
     the menu not having opened - which is how it was reported. A menu is a
     layer, not a destination: the thing you were reading stays behind it,
     dimmed, so it is obvious both that something opened and what it is over.

     No JavaScript. The button is a link to `#menu` and the panel is shown by
     `:target`, which also means the back button closes it and the browser's
     own history does the work. With no CSS at all it degrades to a list of
     fifteen links at the foot of the document, which is the correct fallback.

     `overflow-y: auto` on the panel is the one place in the application an
     inner scroller is right: it is a fixed-height layer over the page, not a
     pane inside it. */
  function drawer(current, n) {
    const body = GROUPS.map(([g, items]) =>
      (g ? `<p class="dgrp">${esc(g)}</p>` : '') +
      items.map(([k, label]) => {
        const c = n[k];
        const num = c === null || c === undefined ? ''
          : `<span class="dn${c === 0 ? ' zero' : k === 'chase' || k === 'silent' ? ' due' : ''}">${c}</span>`;
        return `<a href="${href(k)}"${current === k ? ' aria-current="page"' : ''}>${
          icon(k)}<span class="dl">${esc(label)}</span>${num}</a>`;
      }).join('')).join('');

    return `<div class="drawer" id="menu">
<a class="dscrim" href="#" aria-label="Close the menu"></a>
<nav class="dpanel" aria-label="All destinations">
<div class="dhead"><p class="dname">Plint</p><p class="dorg">NVT Eterna &middot; Phase 1</p></div>
${body}
<div class="dfoot"><a class="wbtn st" href="#" style="text-decoration:none">Close</a></div>
</nav></div>`;
  }

  // ---------------------------------------------------------------- the reads

  /** The counts every screen needs, plus the rows the asked-for screen needs. */
  async function load(sess, which) {
    return asUser(sess, async c => {
      const n = await counts(c);
      const byProject = await schedules(c);
      const rows = await forScreen(c, which);
      return { n, byProject, rows };
    });
  }

  /* One query per destination, written where the screen that reads it is.
     Everything is a plain read except the aggregates on Owner view. */
  async function forScreen(c, k) {
    switch (k) {

      case 'today': return {
        blockers: (await c.query(
          `SELECT u.id unit_id, u.code, u.buyer_name, u.bank, u.agreement_value_paise,
                  u.project_id, u.assigned_engineer_id,
                  t.name stage_name, t.pct_bp, t.seq, s.status,
                  b.holder, b.holder_role, b.reason, b.since, (CURRENT_DATE - b.since) age
             FROM blockers b
             JOIN unit_stages s ON s.id = b.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            ORDER BY (CURRENT_DATE - b.since) DESC`)).rows,
      /* LEFT JOIN, and a fallback, because `users` is behind row-level
         security: a buyer may read only their own row, and the office may read
         only engineer and office rows - the table holds password hashes, so
         widening that to name somebody is not the trade. An inner join here
         does not error, it silently returns nothing, which is how the office's
         whole buyer-question queue came out empty and how the buyer would
         never have seen a single reply from the office. */
        questions: (await c.query(
          `SELECT q.*, u.code, coalesce(w.display_name, u.buyer_name) asker,
                  (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies
             FROM queries q JOIN units u ON u.id = q.unit_id
             LEFT JOIN users w ON w.id = q.raised_by
            WHERE q.kind = 'query' AND q.status = 'open'
            ORDER BY q.raised_at`)).rows,
      };

      case 'owner': return {
        money: (await c.query(
          `SELECT coalesce(sum(total_paise) FILTER (WHERE paid_at IS NOT NULL), 0)  collected,
                  coalesce(sum(total_paise) FILTER (WHERE paid_at IS NULL), 0)      outstanding,
                  count(*) FILTER (WHERE paid_at IS NULL)                           unpaid
             FROM demands`)).rows[0],
        escrow: (await c.query(
          `SELECT coalesce(sum(amount_paise) FILTER (WHERE direction = 'in'), 0)  inn,
                  coalesce(sum(amount_paise) FILTER (WHERE direction = 'out'), 0) out
             FROM escrow_movements`)).rows[0],
        stages: (await c.query(
          `SELECT status, count(*)::int n FROM unit_stages GROUP BY status`)).rows,
        villas: (await c.query(
          `SELECT count(*)::int n,
                  count(*) FILTER (WHERE sanction_recorded_at IS NOT NULL)::int sanctioned,
                  count(*) FILTER (WHERE bank IS NULL)::int self_funded,
                  coalesce(sum(agreement_value_paise), 0) value
             FROM units`)).rows[0],
        ageing: (await c.query(
          `SELECT (CURRENT_DATE - since) age FROM blockers`)).rows,
      };

      case 'handoff': return {
        list: (await c.query(
          `SELECT h.*, u.code, u.buyer_name, u.unit_type, u.agreement_value_paise
             FROM handoffs h JOIN units u ON u.id = h.unit_id
            ORDER BY h.picked_up_at NULLS FIRST, h.created_at`)).rows,
      };

      case 'packs': case 'wait': return {
        list: (await c.query(
          `SELECT d.*, u.code, u.buyer_name, u.bank, u.agreement_value_paise, u.project_id,
                  t.name stage_name, t.seq, dm.doc_no, dm.due_at, dm.paid_at, dm.total_paise
             FROM pack_deliveries d
             JOIN unit_stages s ON s.id = d.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            ORDER BY d.queued_at`)).rows,
      };

      case 'query': return {
        list: (await c.query(
          `SELECT q.*, u.code, u.buyer_name, u.bank, t.name stage_name
             FROM pack_queries q
             JOIN unit_stages s ON s.id = q.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            ORDER BY q.answered_at NULLS FIRST, q.asked_at`)).rows,
      };

      case 'chase': return {
        list: (await c.query(
          `SELECT u.id unit_id, u.code, u.buyer_name, u.bank, u.agreement_value_paise,
                  u.lender_chosen_at, u.sanction_recorded_at, u.sanction_paise,
                  u.own_contribution_paise
             FROM units u
            WHERE u.bank IS NOT NULL AND u.sanction_recorded_at IS NULL
            ORDER BY u.lender_chosen_at NULLS LAST, u.code`)).rows,
      };

      case 'signoff': return {
        list: (await c.query(
          `SELECT s.id, s.marked_at, s.marked_by, u.id unit_id, u.code, u.buyer_name,
                  u.agreement_value_paise, u.project_id, u.assigned_engineer_id,
                  t.name stage_name, t.seq, t.pct_bp,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            WHERE s.status = 'marked'
            ORDER BY s.marked_at`)).rows,
        engineers: (await c.query(
          `SELECT id, display_name, engineer_reg FROM users
            WHERE role = 'engineer' ORDER BY display_name`)).rows,
      };

      case 'silent': return {
        list: (await c.query(
          `SELECT u.id unit_id, u.code, u.buyer_name, u.assigned_engineer_id,
                  w.display_name engineer_name,
                  (SELECT max(e.taken_at) FROM evidence e
                     JOIN unit_stages s ON s.id = e.unit_stage_id
                    WHERE s.unit_id = u.id) last_shot,
                  (SELECT t.name FROM unit_stages s
                     JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
                    WHERE s.unit_id = u.id AND s.status = 'pending'
                    ORDER BY t.seq LIMIT 1) next_stage
             FROM units u LEFT JOIN users w ON w.id = u.assigned_engineer_id
            ORDER BY u.code`)).rows,
        engineers: (await c.query(
          `SELECT id, display_name, engineer_reg FROM users
            WHERE role = 'engineer' ORDER BY display_name`)).rows,
      };

      case 'escrow': return {
        list: (await c.query(
          `SELECT e.*, u.code FROM escrow_movements e
             LEFT JOIN units u ON u.id = e.unit_id
            ORDER BY e.occurred_at DESC LIMIT 60`)).rows,
        totals: (await c.query(
          `SELECT coalesce(sum(amount_paise) FILTER (WHERE direction = 'in'), 0)  inn,
                  coalesce(sum(amount_paise) FILTER (WHERE direction = 'out'), 0) out
             FROM escrow_movements`)).rows[0],
      };

      case 'choices': return {
        list: (await c.query(
          `SELECT ch.*, u.code, u.buyer_name FROM choices ch
             JOIN units u ON u.id = ch.unit_id
            WHERE ch.selected IS NULL ORDER BY ch.needed_by`)).rows,
      };

      case 'warranty': return {
        list: (await c.query(
          `SELECT q.*, u.code, u.buyer_name, coalesce(w.display_name, u.buyer_name) asker,
                  (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies
             FROM queries q JOIN units u ON u.id = q.unit_id
             LEFT JOIN users w ON w.id = q.raised_by
            WHERE q.kind = 'warranty' ORDER BY q.status, q.raised_at`)).rows,
        snags: (await c.query(
          `SELECT sn.*, u.code FROM snags sn JOIN units u ON u.id = sn.unit_id
            WHERE sn.status = 'open' ORDER BY sn.raised_at`)).rows,
      };

      case 'evidence': return {
        list: (await c.query(
          `SELECT e.sha256, e.caption, e.taken_at, e.gps, u.code, t.name stage_name,
                  s.status, s.certified_at, s.certified_by
             FROM evidence e
             JOIN unit_stages s ON s.id = e.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            ORDER BY e.taken_at DESC LIMIT 40`)).rows,
        totals: (await c.query(
          `SELECT count(*)::int shots, count(DISTINCT sha256)::int distinct_hashes
             FROM evidence`)).rows[0],
      };

      case 'qpr': return {
        list: (await c.query(
          `SELECT * FROM qpr_filings ORDER BY due_on DESC`)).rows,
      };

      case 'possession': return {
        list: (await c.query(
          `SELECT p.*, u.code, u.buyer_name FROM possessions p
             JOIN units u ON u.id = p.unit_id
            ORDER BY p.handed_over_at NULLS LAST, u.code`)).rows,
      };

      default: return {};
    }
  }

  // ------------------------------------------------------------- the screens

  /** Wraps a screen in the shell, with the office's own sidebar. */
  const screen = (sess, k, n, main) =>
    desk(sess, k, HEAD[k][0], '', main, sidebar(k, n), drawer(k, n));

  /* Stuck money, grouped by who is holding it up rather than by stage.

     Which is also how the fifteen destinations are grouped: the engineer's
     share is "Sign-off and evidence", the lender's is "Sent, not yet paid",
     the buyer's is "Sanction not recorded". The heading here is the sentence
     that says which of those to open, and it carries the money with it,
     because "six villas" and "two crore" are different sizes of problem. */
  const HOLDER = {
    engineer: 'Waiting on the certifying engineer',
    lender:   'Waiting on the lender',
    office:   'Waiting on head office',
    buyer:    'Waiting on the buyer',
  };

  function stuckByHolder(rows) {
    if (!rows.length) return '';
    const by = {};
    for (const x of rows) (by[x.holder_role] ||= []).push(x);
    return ['engineer', 'lender', 'office', 'buyer'].filter(k => by[k]).map(k => {
      const g = by[k].sort((a, b) => b.age - a.age);
      const sum = g.reduce((n, x) => n + x.value, 0);
      return `<div class="tools"><span class="rescount s">${esc(HOLDER[k])} &middot;
${g.length} villa${g.length === 1 ? '' : 's'} &middot; ${M.crore(sum)}</span><div class="g"></div></div>
<div class="wl">${g.map(x => wrow({
  href: '/office/buyer/' + encodeURIComponent(x.code),
  code: x.code,
  title: x.stage_name,
  detail: esc(x.reason) + ' &middot; sitting with ' + esc(x.holder),
  days: x.age + 'd',
  daysAge: x.age,
  chip: ageChip(x.age, ['Open', 'Ageing', 'Overdue']),
  amount: M.crore(x.value),
})).join('')}</div><div class="gap"></div>`;
    }).join('');
  }

  function today(sess, d, msg) {
    const { n } = d;
    const b = d.rows.blockers || [];
    for (const x of b) x.value = stageTotal(d.byProject, x);
    const stuck = b.reduce((a, x) => a + x.value, 0);
    const onYou = n.handoff + n.packs + n.query + n.chase + n.questions;

    /* What this office can do something about today, before what it is only
       waiting on. Each row is a link to the destination that holds it, so the
       count and the screen it counts are never two different truths. */
    const yours = [
      ['handoff', n.handoff, 'files from sales with no owner yet'],
      ['packs', n.packs, 'packs verified and not sent'],
      ['query', n.query, 'lender questions holding a disbursement'],
      ['chase', n.chase, 'buyers with no sanction letter on file'],
    ].filter(([, c]) => c > 0).map(([k, c, what]) => wrow({
      href: href(k),
      title: HEAD[k][0],
      detail: c + ' ' + what,
      chip: `<i class="chip ${k === 'chase' ? 'late' : 'wait'}">${c}</i>`,
    })).join('');

    const questions = (d.rows.questions || []).map(q => wrow({
      href: '/office/question/' + encodeURIComponent(q.id),
      code: q.code,
      title: q.subject,
      detail: esc(q.asker) + ' &middot; ' + q.replies + ' message' + (q.replies === 1 ? '' : 's'),
      chip: '<i class="chip late">Open</i>',
      days: days(q.raised_at) + 'd',
      daysAge: days(q.raised_at),
    })).join('');

    const oldest = b.length ? Math.max(...b.map(x => x.age)) : 0;

    return screen(sess, 'today', n, `
${hero(onYou, 'on this office', 'Today',
  onYou ? 'Work this office can move today. What it is only waiting on is under '
          + '&ldquo;Chasing your team&rdquo; and &ldquo;Waiting on the bank&rdquo;.'
        : 'Nothing is sitting with this office. ' + M.crore(stuck) + ' is stuck elsewhere, '
          + 'and the oldest has been waiting ' + oldest + ' days.',
  onYou > 0)}
<div class="mbody anim">
${flash(msg)}
${yours ? `<div class="blk"><p class="k">Waiting on you</p></div>
<div class="wl">${yours}</div><div class="gap"></div>` : ''}
${questions ? `<div class="blk"><p class="k">Buyers have asked you something</p></div>
<div class="wl">${questions}</div><div class="gap"></div>` : ''}
${stuckByHolder(b) || `<div class="blk"><p class="k">Stuck money</p></div>
<div class="wl">${empty('No stage is blocked anywhere on the project.')}</div>`}
</div>`);
  }

  function owner(sess, d, msg) {
    const { n } = d;
    const r = d.rows;
    const escrowHeld = Number(r.escrow.inn) - Number(r.escrow.out);
    const byStatus = Object.fromEntries(r.stages.map(s => [s.status, s.n]));
    const done = (byStatus.paid || 0);
    const total = r.stages.reduce((a, s) => a + s.n, 0);

    const money = [
      ['Collected', M.money(Number(r.money.collected))],
      ['Demanded, unpaid', M.money(Number(r.money.outstanding))],
      ['Held in escrow', M.money(escrowHeld)],
      ['Agreement value, all villas', M.money(Number(r.villas.value))],
    ].map(([k, v]) => wrow({ title: k, amount: v })).join('');

    const book = [
      ['Villas', String(r.villas.n)],
      ['Sanction recorded', r.villas.sanctioned + ' of ' + (r.villas.n - r.villas.self_funded)],
      ['Self funded', String(r.villas.self_funded)],
      ['Stages paid', done + ' of ' + total],
    ].map(([k, v]) => wrow({ title: k, amount: v })).join('');

    const buckets = [[0, 9], [10, AGE.overdue - 1], [AGE.overdue, 34], [35, 9999]];
    const ages = r.ageing.map(x => Number(x.age));
    const cts = buckets.map(([lo, hi]) => ages.filter(a => a >= lo && a <= hi).length);
    const most = Math.max(1, ...cts);
    const bars = `<div class="agebars">${cts.map((c, i) =>
      `<span class="agebar ${i >= 2 ? 'hot' : ''}" style="--h:${Math.max(2, c / most * 88)}px"
 title="${buckets[i][0]} to ${buckets[i][1] === 9999 ? 'more' : buckets[i][1]} days: ${c}"></span>`).join('')}</div>`;

    return screen(sess, 'owner', n, `
${hero(M.crore(Number(r.money.collected)), 'collected', 'Owner view',
  'The position, not the worklist. ' + r.villas.n + ' villas, '
  + M.crore(Number(r.money.outstanding)) + ' demanded and unpaid, '
  + M.crore(escrowHeld) + ' held in escrow.' , false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Money</p></div>
<div class="wl">${money}</div>
<div class="gap"></div>
<div class="blk"><p class="k">The book</p></div>
<div class="wl">${book}</div>
<div class="gap"></div>
<div class="blk"><p class="k">How long things have been blocked</p></div>
<div class="blk">${bars}</div>
</div>`);
  }

  function handoff(sess, d, msg) {
    const { n } = d;
    const waiting = d.rows.list.filter(h => !h.picked_up_at);
    const row = h => wrow({
      href: '/office/buyer/' + encodeURIComponent(h.code),
      code: h.code,
      title: h.buyer_name,
      detail: esc(h.unit_type) + ' &middot; token ' + M.money(Number(h.token_paise))
        + ' &middot; sold by ' + esc(h.salesperson)
        + (h.note ? ' &middot; ' + esc(h.note) : ''),
      chip: h.picked_up_at ? '<i class="chip ok">Picked up</i>' : '<i class="chip late">No owner</i>',
      days: days(h.created_at) + 'd',
      daysAge: h.picked_up_at ? null : days(h.created_at),
      amount: M.money(Number(h.agreement_value_paise)),
      action: h.picked_up_at ? 'Yours'
        : `<form method="post" action="/office/handoff"><input type="hidden" name="id" value="${esc(h.id)}">
<button class="wbtn solid st" type="submit">Pick up</button></form>`,
      actionIsText: !!h.picked_up_at,
    });

    return screen(sess, 'handoff', n, `
${hero(waiting.length, 'with no owner', HEAD.handoff[0], esc(HEAD.handoff[1])
  + '. Until somebody in this office picks a file up, nobody is chasing its sanction.',
  waiting.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(row).join('')
  : empty('Sales have handed nothing over.')}</div>
</div>`);
  }

  function packs(sess, d, msg) {
    const { n } = d;
    const queued = d.rows.list.filter(x => x.state === 'queued');
    return screen(sess, 'packs', n, `
${hero(queued.length, 'to send', HEAD.packs[0], esc(HEAD.packs[1])
  + '. Each one is a stage the buyer has already been billed for.', queued.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${queued.length ? queued.map(x => wrow({
  href: '/office/buyer/' + encodeURIComponent(x.code),
  code: x.code,
  title: x.stage_name,
  detail: esc(x.buyer_name) + ' &middot; ' + esc(x.lender || 'self funded')
    + (x.doc_no ? ' &middot; demand ' + esc(x.doc_no) : ''),
  chip: '<i class="chip wait">Queued</i>',
  days: days(x.queued_at) + 'd',
  daysAge: days(x.queued_at),
  amount: x.total_paise ? M.money(Number(x.total_paise)) : '',
})).join('') : empty('Every verified pack is with its lender.')}</div>
</div>`);
  }

  function waitScreen(sess, d, msg) {
    const { n } = d;
    const late = d.rows.list.filter(x =>
      x.state === 'delivered' && !x.paid_at && x.delivered_at
      && days(x.delivered_at) > PACK_LATE_DAYS);
    return screen(sess, 'wait', n, `
${hero(late.length, 'past ' + PACK_LATE_DAYS + ' days', HEAD.wait[0], esc(HEAD.wait[1])
  + '. The pack went, the lender acknowledged it, and the money has not arrived.',
  late.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${late.length ? late.map(x => wrow({
  href: '/office/buyer/' + encodeURIComponent(x.code),
  code: x.code,
  title: x.stage_name,
  detail: esc(x.buyer_name) + ' &middot; ' + esc(x.lender || 'self funded')
    + ' &middot; sent ' + M.longDate(x.delivered_at)
    + (x.due_at ? ' &middot; due ' + M.longDate(x.due_at) : ''),
  chip: ageChip(days(x.delivered_at), ['With the lender', 'Ageing', 'Overdue']),
  days: days(x.delivered_at) + 'd',
  daysAge: days(x.delivered_at),
  amount: x.total_paise ? M.money(Number(x.total_paise)) : '',
})).join('') : empty('Nothing has been with a lender longer than ' + PACK_LATE_DAYS + ' days.')}</div>
</div>`);
  }

  function query(sess, d, msg) {
    const { n } = d;
    const open = d.rows.list.filter(q => !q.answered_at);
    return screen(sess, 'query', n, `
${hero(open.length, 'unanswered', HEAD.query[0], esc(HEAD.query[1])
  + '. Every day one of these sits open is a day the disbursement does not move.',
  open.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(q => wrow({
  code: q.code,
  title: q.stage_name,
  detail: esc(q.question)
    + (q.answered_at ? ' &middot; answered: ' + esc(q.answer) : ''),
  chip: q.answered_at ? '<i class="chip ok">Answered</i>' : '<i class="chip late">Open</i>',
  days: days(q.asked_at) + 'd',
  daysAge: q.answered_at ? null : days(q.asked_at),
  actionWide: !q.answered_at,
  action: q.answered_at ? '' : `<form class="uprow reassign" method="post" action="/office/query"
  style="display:flex;gap:10px;align-items:center;width:100%">
<input type="hidden" name="id" value="${esc(q.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Answer ${esc(q.bank || 'the lender')}</span>
<input class="fi" type="text" name="answer" maxlength="300" required
  placeholder="What you told them" style="margin:0;flex:1 1 200px"></span>
<button class="wbtn solid st" type="submit">Answer</button></form>`,
})).join('') : empty('No lender has asked anything.')}</div>
</div>`);
  }

  function chase(sess, d, msg) {
    const { n } = d;
    return screen(sess, 'chase', n, `
${hero(d.rows.list.length, 'files', HEAD.chase[0], esc(HEAD.chase[1]),
  d.rows.list.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(u => wrow({
  code: u.code,
  title: u.buyer_name,
  detail: esc(u.bank) + (u.lender_chosen_at
    ? ' &middot; chosen ' + M.longDate(u.lender_chosen_at) : ' &middot; no date on the pick'),
  chip: '<i class="chip late">no sanction</i>',
  days: u.lender_chosen_at ? days(u.lender_chosen_at) + 'd' : '',
  daysAge: u.lender_chosen_at ? days(u.lender_chosen_at) : null,
  amount: M.money(Number(u.agreement_value_paise)),
  actionWide: true,
  action: `<form class="uprow" method="post" action="/office/sanction"
  style="display:flex;gap:8px;flex-wrap:wrap;width:100%">
<input type="hidden" name="unit" value="${esc(u.unit_id)}">
<input class="fi" type="number" name="sanction" min="1" required placeholder="Sanctioned amount, in rupees">
<input class="fi" type="number" name="own" min="1" required placeholder="Own contribution, in rupees">
<input class="fi" type="text" name="letter" maxlength="60" required placeholder="Sanction letter reference">
<button class="wbtn solid st" type="submit">Record sanction</button></form>`,
})).join('') : empty('Every buyer with a lender has a sanction on file.')}</div>
</div>`);
  }

  function signoff(sess, d, msg) {
    const { n } = d;
    for (const x of d.rows.list) x.value = stageTotal(d.byProject, x);
    return screen(sess, 'signoff', n, `
${hero(d.rows.list.length, 'to certify', HEAD.signoff[0], esc(HEAD.signoff[1])
  + '. This office cannot sign one; it can move it to an engineer who will.',
  d.rows.list.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(x => wrow({
  href: '/office/buyer/' + encodeURIComponent(x.code),
  code: x.code,
  title: x.stage_name,
  detail: esc(x.buyer_name) + ' &middot; marked by ' + esc(x.marked_by)
    + ' &middot; ' + x.shots + ' photograph' + (x.shots === 1 ? '' : 's'),
  chip: x.shots >= 2 ? '<i class="chip wait">ready</i>'
    : `<i class="chip warn">${x.shots} photo${x.shots === 1 ? '' : 's'}</i>`,
  days: days(x.marked_at) + 'd',
  daysAge: days(x.marked_at),
  amount: M.money(x.value),
}) + reassignForm(x, d.rows.engineers, 'signoff')).join('') : empty('Nothing is waiting on a certificate.')}</div>
</div>`);
  }

  /* The one control this office has over the site: move the work to somebody
     else. It goes through `assign_engineer`, which is SECURITY DEFINER and
     takes the actor from the transaction. */
  function reassignForm(x, engineers, from) {
    const others = engineers.filter(e => e.id !== x.assigned_engineer_id);
    if (!others.length) return '';
    return `<form method="post" action="/office/assign" class="uprow reassign"
  style="display:flex;gap:10px;align-items:center;padding:8px 26px 14px;border-bottom:1px solid var(--hair)">
<input type="hidden" name="unit" value="${esc(x.unit_id)}">
<input type="hidden" name="from" value="${esc(from)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Move it to</span>
<select class="fi" name="engineer" style="margin:0;flex:0 0 220px;padding:7px 10px">
${others.map(e => `<option value="${esc(e.id)}">${esc(e.display_name)}${
  e.engineer_reg ? '' : ' (cannot certify)'}</option>`).join('')}
</select></span>
<button class="wbtn st" type="submit">Reassign</button></form>`;
  }

  function silent(sess, d, msg) {
    const { n } = d;
    const quiet = d.rows.list.filter(v =>
      !v.last_shot || days(v.last_shot) >= AGE.overdue);
    return screen(sess, 'silent', n, `
${hero(quiet.length, 'villas', HEAD.silent[0], esc(HEAD.silent[1])
  + '. Three weeks with no photograph is not proof that nothing happened, which '
  + 'is exactly the problem.', quiet.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${quiet.length ? quiet.map(v => wrow({
  href: '/office/buyer/' + encodeURIComponent(v.code),
  code: v.code,
  title: v.next_stage || 'All stages done',
  detail: esc(v.buyer_name) + ' &middot; ' + esc(v.engineer_name || 'nobody assigned'),
  chip: v.last_shot ? ageChip(days(v.last_shot)) : '<i class="chip late">never</i>',
  days: v.last_shot ? days(v.last_shot) + 'd' : '',
  daysAge: v.last_shot ? days(v.last_shot) : null,
}) + reassignForm(v, d.rows.engineers, 'silent')).join('')
  : empty('Every villa has a photograph from the last three weeks.')}</div>
</div>`);
  }

  function escrow(sess, d, msg) {
    const { n } = d;
    const held = Number(d.rows.totals.inn) - Number(d.rows.totals.out);
    return screen(sess, 'escrow', n, `
${hero(M.crore(held), 'held', HEAD.escrow[0],
  esc(HEAD.escrow[1]) + '. Seventy per cent of what buyers pay stays here until '
  + 'the stage it was collected for is built.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">The account</p></div>
<div class="wl">${[
  ['Paid in', M.money(Number(d.rows.totals.inn))],
  ['Drawn down', M.money(Number(d.rows.totals.out))],
  ['Held now', M.money(held)],
].map(([k, v]) => wrow({ title: k, amount: v })).join('')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Movements</p></div>
<div class="wl">${d.rows.list.length ? d.rows.list.map(m => wrow({
  code: m.code || '',
  title: m.direction === 'in' ? 'Paid in' : 'Drawn down',
  detail: esc(m.reference) + ' &middot; ' + M.longDate(m.occurred_at),
  chip: m.direction === 'in' ? '<i class="chip ok">in</i>' : '<i class="chip wait">out</i>',
  amount: M.money(Number(m.amount_paise)),
})).join('') : empty('No movement has been recorded on the escrow account.')}</div>
</div>`);
  }

  function choices(sess, d, msg) {
    const { n } = d;
    return screen(sess, 'choices', n, `
${hero(d.rows.list.length, 'not made', HEAD.choices[0], esc(HEAD.choices[1])
  + '. The site cannot order against a preference nobody signed.',
  d.rows.list.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(ch => {
  const left = until(ch.needed_by);
  return wrow({
    href: '/office/buyer/' + encodeURIComponent(ch.code),
    code: ch.code,
    title: ch.label,
    detail: esc(ch.buyer_name) + ' &middot; ' + esc(ch.detail)
      + ' &middot; needed by ' + M.longDate(ch.needed_by),
    chip: left < 0 ? '<i class="chip late">overdue</i>'
      : left <= AGE.ageing ? '<i class="chip warn">due soon</i>' : '<i class="chip wait">open</i>',
    days: left < 0 ? (-left) + 'd late' : 'in ' + left + 'd',
    daysAge: left < 0 ? AGE.overdue : left <= AGE.ageing ? AGE.ageing : 0,
  });
}).join('') : empty('Every interior choice on the project is signed.')}</div>
</div>`);
  }

  function warranty(sess, d, msg) {
    const { n } = d;
    const open = d.rows.list.filter(q => q.status !== 'closed');
    return screen(sess, 'warranty', n, `
${hero(open.length, 'open', HEAD.warranty[0], esc(HEAD.warranty[1])
  + '. A claim and a snag are the same complaint reaching this office two ways.',
  open.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Claims from buyers</p></div>
<div class="wl">${d.rows.list.length ? d.rows.list.map(q => wrow({
  href: '/office/question/' + encodeURIComponent(q.id),
  code: q.code,
  title: q.subject,
  detail: esc(q.asker) + ' &middot; ' + q.replies + ' message' + (q.replies === 1 ? '' : 's'),
  chip: q.status === 'open' ? '<i class="chip late">Open</i>'
    : q.status === 'answered' ? '<i class="chip wait">Answered</i>' : '<i class="chip ok">Closed</i>',
  days: days(q.raised_at) + 'd',
  daysAge: q.status === 'closed' ? null : days(q.raised_at),
})).join('') : empty('No warranty claim has been raised.')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Snags still open on site</p></div>
<div class="wl">${d.rows.snags.length ? d.rows.snags.map(s => wrow({
  code: s.code,
  title: s.title,
  detail: esc(s.detail || 'No detail given.'),
  chip: '<i class="chip late">Open</i>',
  days: days(s.raised_at) + 'd',
  daysAge: days(s.raised_at),
})).join('') : empty('No snag is open anywhere on the project.')}</div>
</div>`);
  }

  function evidence(sess, d, msg) {
    const { n } = d;
    const t = d.rows.totals;
    return screen(sess, 'evidence', n, `
${hero(t.shots, 'photographs', HEAD.evidence[0], esc(HEAD.evidence[1])
  + '. Each is content addressed, so the same photograph filed twice is one '
  + 'row and a substituted one is a different hash.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="blk"><p class="k">Integrity</p></div>
<div class="wl">${[
  ['Photographs on file', String(t.shots)],
  ['Distinct hashes', String(t.distinct_hashes)],
].map(([k, v]) => wrow({ title: k, amount: v })).join('')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Most recent</p></div>
<div class="wl">${d.rows.list.length ? d.rows.list.map(e => wrow({
  code: e.code,
  title: e.stage_name,
  detail: esc(e.caption) + ' &middot; ' + esc(e.gps)
    + ' &middot; ' + esc(e.sha256.slice(0, 12)) + '&hellip;',
  chip: e.certified_at ? '<i class="chip ok">certified</i>' : '<i class="chip wait">on file</i>',
  days: days(e.taken_at) + 'd',
  daysAge: null,
})).join('') : empty('No photograph has been filed.')}</div>
</div>`);
  }

  function qpr(sess, d, msg) {
    const { n } = d;
    const due = d.rows.list.filter(f => !f.filed_at);
    return screen(sess, 'qpr', n, `
${hero(due.length, 'not filed', HEAD.qpr[0], esc(HEAD.qpr[1])
  + '. A quarter filed late is a compliance matter whatever the site did.',
  due.length > 0)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(f => {
  const left = until(f.due_on);
  return wrow({
    title: f.quarter,
    detail: f.filed_at
      ? 'Filed ' + M.longDate(f.filed_at) + ' &middot; ' + esc(f.reference)
      : 'Due ' + M.longDate(f.due_on),
    chip: f.filed_at ? '<i class="chip ok">Filed</i>'
      : left < 0 ? '<i class="chip late">Overdue</i>' : '<i class="chip wait">Open</i>',
    days: f.filed_at ? '' : left < 0 ? (-left) + 'd late' : 'in ' + left + 'd',
    daysAge: f.filed_at ? null : left < 0 ? AGE.overdue : left <= AGE.ageing ? AGE.ageing : 0,
    actionWide: !f.filed_at,
    action: f.filed_at ? '' : `<form class="uprow reassign" method="post" action="/office/qpr"
  style="display:flex;gap:10px;align-items:center;width:100%">
<input type="hidden" name="id" value="${esc(f.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Filed with K-RERA as</span>
<input class="fi" type="text" name="reference" maxlength="60" required
  placeholder="Acknowledgement reference" style="margin:0;flex:1 1 180px"></span>
<button class="wbtn solid st" type="submit">Mark filed</button></form>`,
  });
}).join('') : empty('No quarter has been opened for filing.')}</div>
</div>`);
  }

  function possession(sess, d, msg) {
    const { n } = d;
    const handed = d.rows.list.filter(p => p.handed_over_at);
    return screen(sess, 'possession', n, `
${hero(handed.length, 'handed over', HEAD.possession[0], esc(HEAD.possession[1])
  + '. Handing over the keys is not the end of the file.', false)}
<div class="mbody anim">
${flash(msg)}
<div class="wl">${d.rows.list.length ? d.rows.list.map(p => wrow({
  href: '/office/buyer/' + encodeURIComponent(p.code),
  code: p.code,
  title: p.buyer_name,
  detail: (p.offered_at ? 'Offered ' + M.longDate(p.offered_at) : 'Not offered')
    + (p.snags_cleared_at ? ' &middot; snags cleared ' + M.longDate(p.snags_cleared_at) : '')
    + (p.handed_over_at ? ' &middot; keys to ' + esc(p.keys_to || 'the buyer') : ''),
  chip: p.handed_over_at ? '<i class="chip ok">Handed over</i>'
    : p.snags_cleared_at ? '<i class="chip wait">Ready</i>'
    : p.offered_at ? '<i class="chip warn">Snags open</i>' : '<i class="chip idle">Not offered</i>',
  days: p.handed_over_at ? days(p.handed_over_at) + 'd' : '',
  daysAge: null,
})).join('') : empty('No villa has reached possession.')}</div>
</div>`);
  }

  const SCREENS = {
    today, owner, handoff, packs, query, chase, signoff, silent,
    wait: waitScreen, escrow, choices, warranty, evidence, qpr, possession,
  };

  // ------------------------------------------------------------- buyer file

  /* One villa, whole: the position this office would read out on the phone if
     the buyer rang. Not a destination in the sidebar - it is where every row
     in every other screen goes when you tap it. */
  async function buyerFile(sess, code, n) {
    const d = await asUser(sess, async c => {
      const u = (await c.query('SELECT * FROM units WHERE code = $1', [code])).rows[0];
      if (!u) return null;
      return {
        u,
        stages: (await c.query(
          `SELECT s.*, t.name, t.pct_bp, t.seq FROM unit_stages s
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = $2
            WHERE s.unit_id = $1 ORDER BY t.seq`, [u.id, u.project_id])).rows,
        demands: (await c.query(
          `SELECT d.*, s.stage_code FROM demands d JOIN unit_stages s ON s.id = d.unit_stage_id
            WHERE s.unit_id = $1 ORDER BY d.raised_at`, [u.id])).rows,
        choices: (await c.query(
          'SELECT * FROM choices WHERE unit_id = $1 ORDER BY needed_by', [u.id])).rows,
        queries: (await c.query(
          `SELECT * FROM queries WHERE unit_id = $1 ORDER BY raised_at DESC`, [u.id])).rows,
        visits: (await c.query(
          `SELECT * FROM visits WHERE unit_id = $1 ORDER BY slot_at DESC LIMIT 6`, [u.id])).rows,
        agreement: (await c.query(
          'SELECT * FROM agreements WHERE unit_id = $1', [u.id])).rows[0] || null,
        possession: (await c.query(
          'SELECT * FROM possessions WHERE unit_id = $1', [u.id])).rows[0] || null,
        engineer: (await c.query(
          `SELECT display_name FROM users WHERE id = $1`, [u.assigned_engineer_id])).rows[0] || null,
      };
    });
    if (!d) return null;

    const u = d.u;
    const led = M.ledger({ agreementValuePaise: u.agreement_value_paise, stages: d.stages });
    const openChoices = d.choices.filter(c => !c.selected).length;
    const openQ = d.queries.filter(q => q.status === 'open').length;

    const facts = [
      ['Buyer', u.buyer_name],
      ['Unit', u.unit_type],
      ['Agreement value', M.money(u.agreement_value_paise)],
      ['Collected', M.money(led.paidPaise)],
      ['Demanded, unpaid', M.money(led.demandedPaise)],
      ['Lender', u.bank || 'Self funded'],
      ['Sanction', u.sanction_recorded_at ? M.money(u.sanction_paise) : 'Not recorded'],
      ['Site engineer', d.engineer ? d.engineer.display_name : 'Nobody assigned'],
    ].map(([k, v]) => wrow({ title: k, amount: esc(String(v)) })).join('');

    return desk(sess, null, 'Villa ' + u.code, '', `
${hero(u.code, 'buyer file', 'Villa ' + u.code,
  esc(u.buyer_name) + ' &middot; ' + esc(u.unit_type) + ' &middot; '
  + esc(u.bank || 'self funded'), false)}
<div class="mbody anim">
<div class="tools"><a class="wbtn st" href="/office" style="text-decoration:none">Back</a><div class="g"></div></div>
<div class="blk"><p class="k">Where this file stands</p></div>
<div class="wl">${facts}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Stages</p></div>
<div class="wl">${d.stages.map((s, i) => wrow({
  code: String(i + 1).padStart(2, '0'),
  title: s.name,
  detail: (s.marked_at ? 'marked ' + M.longDate(s.marked_at) + ' by ' + esc(s.marked_by || '') : 'not marked')
    + (s.certified_at ? ' &middot; certified ' + M.longDate(s.certified_at) : ''),
  chip: `<i class="chip ${s.status === 'paid' ? 'ok' : s.status === 'demanded' ? 'late'
    : s.status === 'pending' ? 'idle' : 'wait'}">${esc(s.status)}</i>`,
})).join('')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Open with the buyer</p></div>
<div class="wl">${
  (openChoices ? wrow({ href: '/office/choices', title: 'Interior choices',
    detail: openChoices + ' not signed', chip: '<i class="chip late">' + openChoices + '</i>' }) : '')
+ (openQ ? d.queries.filter(q => q.status === 'open').map(q => wrow({
    href: '/office/question/' + encodeURIComponent(q.id),
    title: q.subject,
    detail: (q.kind === 'warranty' ? 'Warranty claim' : 'Question')
      + ' &middot; raised ' + M.longDate(q.raised_at),
    chip: '<i class="chip late">Open</i>',
    days: days(q.raised_at) + 'd', daysAge: days(q.raised_at),
  })).join('') : '')
+ (!openChoices && !openQ ? empty('Nothing is open with this buyer.') : '')}</div>
</div>`, sidebar(null, n), drawer(null, n));
  }

  // ------------------------------------------------------- one question thread

  async function questionThread(sess, id, n, msg) {
    const d = await asUser(sess, async c => {
      const q = (await c.query(
        `SELECT q.*, u.code, u.buyer_name, coalesce(w.display_name, u.buyer_name) asker
           FROM queries q JOIN units u ON u.id = q.unit_id
           LEFT JOIN users w ON w.id = q.raised_by WHERE q.id = $1`, [id])).rows[0];
      if (!q) return null;
      return { q, msgs: (await c.query(
        `SELECT m.*, coalesce(w.display_name, initcap(m.author_role)) author_name
           FROM query_messages m
           LEFT JOIN users w ON w.id = m.author_id
          WHERE m.query_id = $1 ORDER BY m.sent_at`, [id])).rows };
    });
    if (!d) return null;
    const { q, msgs } = d;

    return desk(sess, null, q.subject, '', `
${hero(msgs.length, msgs.length === 1 ? 'message' : 'messages', q.subject,
  esc(q.code) + ' &middot; ' + esc(q.asker) + ' &middot; '
  + (q.kind === 'warranty' ? 'warranty claim' : 'question')
  + ' &middot; raised ' + M.longDate(q.raised_at), q.status === 'open')}
<div class="mbody anim">
${flash(msg)}
<div class="tools"><a class="wbtn st" href="/office" style="text-decoration:none">Back</a>
<a class="wbtn st" href="/office/buyer/${esc(q.code)}" style="text-decoration:none">Buyer file</a>
<div class="g"></div></div>
<div class="blk"><p class="k">The thread</p></div>
<div class="wl">${msgs.length ? msgs.map(m => wrow({
  title: m.author_role === 'office' ? 'You' : m.author_name,
  detail: esc(m.body),
  chip: `<i class="chip ${m.author_role === 'office' ? 'idle' : 'wait'}">${esc(m.author_role)}</i>`,
  days: days(m.sent_at) + 'd',
  daysAge: null,
})).join('') : empty('The buyer has said nothing beyond the subject line.')}</div>
<div class="gap"></div>
<div class="wl"><form class="uprow reassign" method="post" action="/office/answer"
  style="display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--hair);border-radius:12px;background:var(--paper)">
<input type="hidden" name="id" value="${esc(q.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<span class="s">Answer the buyer</span>
<input class="fi" type="text" name="body" maxlength="400" required placeholder="What you want to tell them"
  style="margin:0;flex:1 1 220px"></span>
<button class="wbtn solid st" type="submit">Send</button></form></div>
${q.status !== 'closed' ? `<div class="gap"></div>
<div class="tools"><form method="post" action="/office/close">
<input type="hidden" name="id" value="${esc(q.id)}">
<button class="wbtn st" type="submit">Close this</button></form><div class="g"></div></div>` : ''}
</div>`, sidebar(null, n), drawer(null, n));
  }

  return { GROUPS, KEYS, HEAD, href, SCREENS, load, counts, sidebar, drawer,
           buyerFile, questionThread, PACK_LATE_DAYS };
};
