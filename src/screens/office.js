'use strict';
/* ============================================================================
   The head office console.

   The visual system is inbell_office_dashboard.html's, value for value, and
   public/office.css is that file's stylesheet copied verbatim. This module
   emits the same markup shapes: `.head`/`.h1`/`.hsub`/`.hacts`, `.hero` with
   its `.big` and its `.bar`, `.kpis`, `.card`/`.ch`/`.cb`/`.row`/`.rico`,
   `.tbl`/`.tr`/`.tr.hd`, `.pill`, `.board`/`.col`/`.lcard`, `.btn`, `.note`,
   `.empty` and the toast. Where this console needs something the reference
   does not have, it is built out of those classes rather than invented.

   WHAT IS DIFFERENT FROM THE REFERENCE, AND WHY. The reference is a prototype:
   it navigates with `onclick` on a div, its screens are functions over arrays
   held in the page, and every button ends in `toast('… (demo)')`. This is an
   application over a database with row-level security. So:

     - a nav item is an anchor with a real URL, and the browser's back button,
       middle-click and no-JS all work;
     - a button that changes something is a form that POSTs and redirects, and
       the redirect carries what happened in `?m=`, which the shell renders as
       the reference's own `.toast.on`;
     - every figure on every screen is read from the database in the session's
       own role, so what the office cannot see, the office is not shown.

   THE GROUND TRUTH THIS CONSOLE MUST NOT CONTRADICT.

     - The lender always sends its own technical officer. Nothing here may say
       or imply the photographs replace that visit; they are what the office
       and the buyer can see between visits, and what the pack carries.
     - Five documents per stage. Four generate from the record. Only the
       engineer's completion certificate carries an external qualified
       signature, and only a qualified engineer may sign it.
     - Bookings and receipts come from the builder's ERP. This console reads
       them and writes nothing back to it.
   ========================================================================= */

module.exports = function office(ctx) {
  const { esc, officePage, M, asUser, schedules, stageTotal } = ctx;

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  const until = d => Math.round((new Date(d).getTime() - Date.now()) / 86400000);

  /* A pack that has been with a lender longer than this is the thing the
     office chases. It is the same fourteen days the sidebar counts. */
  const PACK_LATE_DAYS = 14;
  /* Three weeks with no photograph is a villa that has gone quiet. */
  const QUIET_DAYS = 21;
  /* How long a stage may sit blocked before the wait is worth a colour. The
     same two thresholds the day counts elsewhere in this product use. */
  const AGE_OVERDUE = 21, AGE_AGEING = 10;

  // ------------------------------------------------------------------ icons

  /* The reference's own icon set. Nothing new is drawn: each item below picks
     the shape from that set which says what it is. */
  /* The design system, once, for the whole product: the reference's icons,
     its head, its KPI strip, its card, its table, its pills, its buttons and
     its board. They were written here, and the buyer's and the engineer's
     screens are drawn from the same kit now rather than from a second one. */
  const K = require('./kit')({ esc });
  const { I, ic, head, kpis, pill, btn, act, table, filters, search, showing,
          card, titled, row, dl, note, empty, board, who, initials, num, tagOf, ageBand,
          field, input, select, file, form } = K;

  // -------------------------------------------------------------------- nav

  /* The reference's shape exactly: a flat list of `{item}` and `{grp}`. */
  const NAV = [
    { item: { id: 'dashboard', label: 'Dashboard', icon: 'home' } },
    { grp: 'Money stuck' },
    { item: { id: 'packs', label: 'Ready to send', icon: 'report', count: 'packs' } },
    { item: { id: 'wait', label: 'At the lender', icon: 'money', count: 'wait' } },
    { item: { id: 'query', label: 'Lender queries', icon: 'comms', count: 'query' } },
    { item: { id: 'chase', label: 'Sanction not recorded', icon: 'risk' } },
    { grp: 'The site' },
    { item: { id: 'stages', label: 'Stages', icon: 'growth' } },
    { item: { id: 'evidence', label: 'Evidence certificates', icon: 'cert' } },
    { item: { id: 'silent', label: 'Site gone quiet', icon: 'bell', count: 'silent' } },
    { item: { id: 'signoff', label: 'Sign-off queue', icon: 'attend' } },
    { grp: 'Buyers' },
    { item: { id: 'villas', label: 'Villas', icon: 'hostel' } },
    { item: { id: 'documents', label: 'Documents', icon: 'report' } },
    { item: { id: 'choices', label: 'Choices', icon: 'exam', count: 'choices' } },
    { item: { id: 'visits', label: 'Visits', icon: 'cal' } },
    { item: { id: 'warranty', label: 'Warranty', icon: 'risk', count: 'warranty' } },
    { grp: 'Compliance' },
    { item: { id: 'rera', label: 'RERA filing', icon: 'cert' } },
    { item: { id: 'escrow', label: 'Escrow drawdown', icon: 'money' } },
    { item: { id: 'possession', label: 'After possession', icon: 'home' } },
    { grp: 'Setup' },
    { item: { id: 'setup', label: 'Projects', icon: 'hostel' } },
    { item: { id: 'schedule', label: 'Payment schedule', icon: 'cal' } },
    { item: { id: 'lenders', label: 'Lenders', icon: 'money' } },
    { item: { id: 'logins', label: 'Logins', icon: 'users' } },
    { item: { id: 'settings', label: 'Settings', icon: 'settings' } },
    { item: { id: 'help', label: 'Help', icon: 'bolt' } },
  ];

  const KEYS = new Set(NAV.filter(e => e.item).map(e => e.item.id));
  const href = id => (id === 'dashboard' ? '/office' : '/office/' + id);

  function nav(current, n) {
    return NAV.map(e => {
      if (e.grp) return `<div class="grp">${esc(e.grp)}</div>`;
      const it = e.item;
      const badge = it.count && n[it.count] ? `<span class="badge">${n[it.count]}</span>` : '';
      return `<a class="item ${it.id === current ? 'on' : ''}" href="${href(it.id)}"`
        + `${it.id === current ? ' aria-current="page"' : ''}>${ic(it.icon)}`
        + `<span class="lbl">${esc(it.label)}</span>${badge}</a>`;
    }).join('');
  }

  /* A snag is raised as a sentence, not against a trade, so the trade is read
     out of what was written. It is a filter, not a record: what it cannot
     place goes under "other" rather than being guessed at. */
  const TRADES = [['plumb', 'Plumbing'], ['elec', 'Electrical'], ['paint', 'Painting'],
                  ['tile', 'Tiling and flooring'], ['carp', 'Joinery'],
                  ['water', 'Water and damp'], ['civil', 'Civil and plaster'],
                  ['other', 'Anything else']];
  const TRADE_WORDS = {
    plumb: /plumb|tap|drain|sanitary|wc|basin|pipe/i,
    elec: /electric|wiring|socket|switch|light|meter|db /i,
    paint: /paint|putty|primer|emulsion/i,
    tile: /tile|floor|marble|granite|skirting/i,
    carp: /door|window|joinery|shutter|wardrobe|frame/i,
    water: /leak|damp|seep|water|moist|patch/i,
    civil: /crack|plaster|masonry|block|concrete|render/i,
  };
  const tradeOf = title => {
    for (const [k, re] of Object.entries(TRADE_WORDS)) if (re.test(title || '')) return k;
    return 'other';
  };

  /* WHO IS HOLDING IT UP.

     The four parties a stage can be waiting on, in the order the office works
     them: its own people first, then the outside ones, then the buyer. Every
     blocked stage carries exactly one `holder_role`, so every villa lands in
     exactly one column and the four columns sum to the project.

     This grouping was in the product, was dropped when the console was rebuilt
     on the reference, and is restored here as the primary view. It answers
     "who do I chase today", which is the question this desk actually opens
     with; the pack-state board answers "what state is this pack in", which is
     the question you ask second. */
  const HOLDER = [
    ['engineer', 'The engineer'],
    ['office', 'This office'],
    ['lender', 'The lender'],
    ['buyer', 'The buyer'],
  ];

  /* Where a villa lives in this console. The only helper this file still
     owns, because it is a route rather than a component. */
  /* "1 days ago" was on three screens. A day count written as prose agrees
     with itself about the plural. */
  const ago = at => {
    const n = days(at);
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago';
  };

  const villaHref = code => '/office/villa/' + encodeURIComponent(code);

  /* The lenders on a set of rows, so a filter offers the ones that are there
     rather than a fixed list that goes stale. */
  const lendersIn = rows => [...new Set(rows.map(r => r.bank).filter(Boolean))].sort();

  // ----------------------------------------------------------------- counts

  /* One query for every badge in the sidebar, because the sidebar is on every
     screen in this role and twenty-two reads to draw it would be twenty-two
     reads on every page. */
  async function counts(c) {
    const r = (await c.query(`
      SELECT
        (SELECT count(*) FROM pack_deliveries WHERE state = 'queued')                   packs,
        (SELECT count(*) FROM pack_queries WHERE answered_at IS NULL)                   query,
        (SELECT count(*) FROM pack_deliveries d
           JOIN unit_stages s ON s.id = d.unit_stage_id
           JOIN demands dm ON dm.unit_stage_id = s.id
          WHERE d.state = 'delivered' AND dm.paid_at IS NULL
            AND d.delivered_at < now() - ($1 || ' days')::interval)                     wait,
        (SELECT count(*) FROM units u WHERE NOT EXISTS (
            SELECT 1 FROM evidence e JOIN unit_stages s ON s.id = e.unit_stage_id
             WHERE s.unit_id = u.id AND e.taken_at > now() - ($2 || ' days')::interval)) silent,
        (SELECT count(*) FROM choices
          WHERE selected IS NULL AND needed_by < CURRENT_DATE)                          choices,
        (SELECT count(*) FROM snags WHERE status = 'open')                              warranty
      `, [String(PACK_LATE_DAYS), String(QUIET_DAYS)])).rows[0];
    for (const k of Object.keys(r)) r[k] = Number(r[k]);
    return r;
  }

  async function load(sess, which) {
    return asUser(sess, async c => ({
      n: await counts(c),
      byProject: await schedules(c),
      rows: await forScreen(c, which),
    }));
  }

  // ------------------------------------------------------------------- data

  /* One read per destination, written beside the screen that consumes it. */
  async function forScreen(c, k) {
    switch (k) {

      /* Every project this office runs, with what each one has so far. */
      case 'setup': return {
        projects: (await c.query(
          `SELECT p.*,
                  (SELECT count(*)::int FROM stage_templates t WHERE t.project_id = p.id) stages,
                  (SELECT count(*)::int FROM units u WHERE u.project_id = p.id) villas,
                  (SELECT count(*)::int FROM units u
                    WHERE u.project_id = p.id AND u.buyer_user_id IS NOT NULL) buyers
             FROM projects p ORDER BY p.created_at NULLS FIRST, p.name`)).rows,
      };

      case 'dashboard': return {
        money: (await c.query(
          `SELECT coalesce(sum(total_paise) FILTER (WHERE paid_at IS NOT NULL), 0) collected,
                  coalesce(sum(total_paise) FILTER (WHERE paid_at IS NULL), 0)     outstanding,
                  coalesce(sum(total_paise), 0)                                    billed
             FROM demands`)).rows[0],
        stages: (await c.query(
          `SELECT count(*) FILTER (WHERE status = 'certified' OR status = 'demanded'
                                      OR status = 'paid')                     certified,
                  count(*) FILTER (WHERE status = 'marked')                   marked,
                  count(*) FILTER (WHERE status <> 'pending')                 due,
                  count(*)                                                    all_stages,
                  count(*) FILTER (WHERE status = 'certified' AND certified_at
                                     >= date_trunc('month', now()))           this_month
             FROM unit_stages`)).rows[0],
        villas: Number((await c.query(`SELECT count(*) n FROM units`)).rows[0].n),
        projects: Number((await c.query(`SELECT count(*) n FROM projects`)).rows[0].n),
        /* Delivered and NOT yet paid. Counting every delivery ever made put
           195 on the dashboard while the screen behind it said nothing was
           sitting with a lender - both were true and they contradicted each
           other, because one counted history and the other counted work. */
        atLender: Number((await c.query(
          `SELECT count(*) n FROM pack_deliveries d
             JOIN unit_stages s ON s.id = d.unit_stage_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            WHERE d.state IN ('sending','delivered') AND dm.paid_at IS NULL`)).rows[0].n),
        /* Per lender, not one SQL total. This figure is the same quantity the
           Lenders screen puts above its own rows, and that one is summed from
           what those rows print - so summing it any other way here makes two
           screens disagree about what the lenders owe. They differed by a lakh
           for exactly one build. */
        receivable: (await c.query(
          `SELECT coalesce(sum(dm.total_paise), 0) v FROM demands dm
             JOIN unit_stages s ON s.id = dm.unit_stage_id
             JOIN units u ON u.id = s.unit_id
            WHERE dm.paid_at IS NULL AND u.bank IS NOT NULL
            GROUP BY u.bank`)).rows.map(r => r.v),
        /* The money the office is waiting on evidence for: stages the engineer
           has marked but nobody has certified, so no pack and no demand. */
        waiting: (await c.query(
          `SELECT s.id, u.code, u.buyer_name, u.agreement_value_paise, u.project_id,
                  t.name stage_name, t.seq, s.marked_at
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            WHERE s.status = 'marked' ORDER BY s.marked_at`)).rows,
        queued: (await c.query(
          `SELECT d.id, u.code, u.buyer_name, u.bank, t.name stage_name, d.queued_at,
                  dm.total_paise
             FROM pack_deliveries d
             JOIN unit_stages s ON s.id = d.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            WHERE d.state = 'queued' ORDER BY d.queued_at LIMIT 5`)).rows,
        quiet: (await c.query(
          `SELECT u.code, u.buyer_name,
                  (SELECT max(e.taken_at) FROM evidence e
                     JOIN unit_stages s ON s.id = e.unit_stage_id
                    WHERE s.unit_id = u.id) last_shot
             FROM units u
            WHERE NOT EXISTS (
              SELECT 1 FROM evidence e JOIN unit_stages s ON s.id = e.unit_stage_id
               WHERE s.unit_id = u.id AND e.taken_at > now() - ($1 || ' days')::interval)
            ORDER BY 3 NULLS FIRST LIMIT 5`, [String(QUIET_DAYS)])).rows,
        worklist: (await c.query(
          `SELECT s.id, s.status, s.marked_at, s.certified_at,
                  u.code, u.buyer_name, u.bank, u.agreement_value_paise, u.project_id,
                  t.name stage_name, t.seq,
                  dm.due_at, dm.paid_at, dm.total_paise,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            WHERE s.status <> 'pending'
            ORDER BY (s.status = 'marked') DESC, coalesce(dm.due_at, s.marked_at)
            LIMIT 12`)).rows,
        /* LEFT JOIN, and a fallback name, because `users` is behind row-level
           security: the office may read engineer and office rows only, so an
           inner join here would silently return nothing and the whole queue
           would come out empty. It did, once. */
        questions: (await c.query(
          `SELECT q.id, q.subject, q.raised_at, u.code,
                  coalesce(w.display_name, u.buyer_name) asker,
                  (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies
             FROM queries q JOIN units u ON u.id = q.unit_id
             LEFT JOIN users w ON w.id = q.raised_by
            WHERE q.kind = 'query' AND q.status = 'open'
            ORDER BY q.raised_at LIMIT 6`)).rows,
        /* What an engineer has reported as stopping the work. It is money that
           has stopped, so it belongs at the top of this screen and not behind
           a destination of its own. */
        /* EVERY blocker, not the longest-blocked eight: the holder board is
           the primary view of this screen and it has to account for all
           forty-eight villas. The pricing columns come along so a column can
           say what it is holding up in rupees. */
        blockers: (await c.query(
          `SELECT b.reason, b.holder, b.holder_role, b.since, u.code, u.buyer_name,
                  u.agreement_value_paise, u.project_id,
                  t.name stage_name, t.seq, t.pct_bp,
                  (CURRENT_DATE - b.since) age
             FROM blockers b
             JOIN unit_stages s ON s.id = b.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            ORDER BY (CURRENT_DATE - b.since) DESC`)).rows,
        pipeline: (await c.query(
          `SELECT d.state, d.queued_at, d.delivered_at, u.code, u.buyer_name, u.bank,
                  t.name stage_name, dm.total_paise, dm.paid_at,
                  (SELECT count(*)::int FROM pack_queries q
                    WHERE q.unit_stage_id = s.id AND q.answered_at IS NULL) open_q
             FROM pack_deliveries d
             JOIN unit_stages s ON s.id = d.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            ORDER BY d.queued_at`)).rows,
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
                  u.lender_chosen_at, u.sanction_recorded_at, u.sanction_paise
             FROM units u
            WHERE u.bank IS NOT NULL AND u.sanction_recorded_at IS NULL
            ORDER BY u.lender_chosen_at NULLS LAST, u.code`)).rows,
      };

      case 'stages': return {
        /* The blocker comes with the stage. A stage that has stopped has to
           say what stopped it on the row itself - the engineer types the
           reason once, and this is where the office reads it. */
        list: (await c.query(
          `SELECT s.id, s.status, s.marked_at, s.certified_at,
                  u.code, u.buyer_name, u.agreement_value_paise, u.project_id,
                  t.name stage_name, t.seq, dm.due_at, dm.paid_at, dm.total_paise,
                  b.reason blocked_reason, b.holder blocked_with,
                  (CURRENT_DATE - b.since) blocked_age,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
             LEFT JOIN blockers b ON b.unit_stage_id = s.id
            ORDER BY (b.since IS NOT NULL) DESC, u.code, t.seq`)).rows,
      };

      case 'evidence': return {
        list: (await c.query(
          `SELECT e.sha256, e.caption, e.taken_at, e.gps, u.code, t.name stage_name,
                  s.status, s.certified_at, s.certificate_hash
             FROM evidence e
             JOIN unit_stages s ON s.id = e.unit_stage_id
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            ORDER BY e.taken_at DESC LIMIT 40`)).rows,
        totals: (await c.query(
          `SELECT count(*)::int shots, count(DISTINCT sha256)::int distinct_hashes
             FROM evidence`)).rows[0],
        certs: Number((await c.query(
          `SELECT count(*) n FROM unit_stages WHERE certificate_hash IS NOT NULL`)).rows[0].n),
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
                    ORDER BY t.seq LIMIT 1) next_stage,
                  (SELECT max(l.logged_at) FROM site_log l
                    WHERE l.unit_id = u.id AND l.kind = 'photo')            asked_at,
                  (SELECT w2.display_name FROM site_log l
                     LEFT JOIN users w2 ON w2.id = l.logged_by
                    WHERE l.unit_id = u.id AND l.kind = 'photo'
                    ORDER BY l.logged_at DESC LIMIT 1)                      asked_by
             FROM units u LEFT JOIN users w ON w.id = u.assigned_engineer_id
            ORDER BY u.code`)).rows,
        engineers: (await c.query(
          `SELECT id, display_name FROM users WHERE role = 'engineer' ORDER BY display_name`)).rows,
      };

      case 'signoff': return {
        list: (await c.query(
          `SELECT s.id, s.marked_at, u.id unit_id, u.code, u.buyer_name,
                  u.agreement_value_paise, u.project_id, u.assigned_engineer_id,
                  w.display_name engineer_name,
                  t.name stage_name, t.seq,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             LEFT JOIN users w ON w.id = u.assigned_engineer_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            WHERE s.status = 'marked'
            ORDER BY s.marked_at`)).rows,
        engineers: (await c.query(
          `SELECT id, display_name FROM users WHERE role = 'engineer' ORDER BY display_name`)).rows,
      };

      case 'villas': return {
        list: (await c.query(
          `SELECT u.id unit_id, u.code, u.buyer_name, u.unit_type, u.bank,
                  u.agreement_value_paise, u.sanction_recorded_at,
                  w.display_name engineer_name,
                  pr.name || ' · ' || pr.phase project_name,
                  (SELECT count(*)::int FROM unit_stages s
                    WHERE s.unit_id = u.id AND s.status = 'paid')            paid,
                  (SELECT count(*)::int FROM unit_stages s WHERE s.unit_id = u.id) stages,
                  /* The stage in hand, which is what a reader filters this
                     register by: "show me everything at plastering". */
                  (SELECT t.name FROM unit_stages s
                     JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
                    WHERE s.unit_id = u.id AND s.status <> 'paid'
                    ORDER BY t.seq LIMIT 1)                                  next_stage,
                  /* Money that has STOPPED, which is not the same as money not
                     yet paid: every villa has an unpaid demand inside its due
                     window, so counting those tagged all forty-eight and the
                     filter told a reader nothing. Stopped is past its due date,
                     or sitting with a lender past a fortnight, or a lender
                     chosen with no sanction letter on record. */
                  ((SELECT count(*)::int FROM unit_stages s
                      JOIN demands dm ON dm.unit_stage_id = s.id
                     WHERE s.unit_id = u.id AND dm.paid_at IS NULL
                       AND dm.due_at < CURRENT_DATE)
                   + (SELECT count(*)::int FROM unit_stages s
                        JOIN pack_deliveries pd ON pd.unit_stage_id = s.id
                        JOIN demands dm ON dm.unit_stage_id = s.id
                       WHERE s.unit_id = u.id AND pd.state = 'delivered'
                         AND dm.paid_at IS NULL
                         AND pd.delivered_at < now() - ($1 || ' days')::interval)
                   + CASE WHEN u.bank IS NOT NULL AND u.sanction_recorded_at IS NULL
                          THEN 1 ELSE 0 END)                                 stuck
             FROM units u JOIN projects pr ON pr.id = u.project_id LEFT JOIN users w ON w.id = u.assigned_engineer_id
            ORDER BY u.code`, [String(PACK_LATE_DAYS)])).rows,
        handoffs: (await c.query(
          `SELECT h.id, h.token_paise, h.salesperson, h.note, h.created_at, h.picked_up_at,
                  u.code, u.buyer_name
             FROM handoffs h JOIN units u ON u.id = h.unit_id
            WHERE h.picked_up_at IS NULL ORDER BY h.created_at`)).rows,
      };

      case 'documents': return {
        stages: (await c.query(
          `SELECT s.id, s.status, s.certificate_hash, s.certified_at,
                  u.code, u.buyer_name, t.name stage_name, dm.doc_no,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s
             JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
             LEFT JOIN demands dm ON dm.unit_stage_id = s.id
            WHERE s.status IN ('certified','demanded','paid')
            ORDER BY s.certified_at DESC NULLS LAST LIMIT 30`)).rows,
        loans: (await c.query(
          `SELECT a.full_name, a.relation, u.code,
                  count(d.*)::int asked,
                  count(d.seen_at)::int seen
             FROM loan_applicants a
             JOIN units u ON u.id = a.unit_id
             LEFT JOIN loan_documents d ON d.applicant_id = a.id
            GROUP BY a.id, a.full_name, a.relation, u.code, a.seq
            ORDER BY u.code, a.seq LIMIT 20`)).rows,
      };

      case 'choices': return {
        list: (await c.query(
          `SELECT ch.*, u.code, u.buyer_name FROM choices ch
             JOIN units u ON u.id = ch.unit_id
            ORDER BY ch.selected NULLS FIRST, ch.needed_by`)).rows,
      };

      case 'visits': return {
        list: (await c.query(
          `SELECT v.*, u.code, u.buyer_name, w.display_name engineer_name
             FROM visits v JOIN units u ON u.id = v.unit_id
             LEFT JOIN users w ON w.id = v.engineer_id
            ORDER BY v.slot_at DESC LIMIT 40`)).rows,
      };

      case 'warranty': return {
        snags: (await c.query(
          `SELECT sn.*, u.code, u.buyer_name FROM snags sn JOIN units u ON u.id = sn.unit_id
            ORDER BY sn.status, sn.raised_at DESC LIMIT 40`)).rows,
        claims: (await c.query(
          `SELECT q.*, u.code, coalesce(w.display_name, u.buyer_name) asker,
                  (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies
             FROM queries q JOIN units u ON u.id = q.unit_id
             LEFT JOIN users w ON w.id = q.raised_by
            WHERE q.kind = 'warranty' ORDER BY q.status, q.raised_at`)).rows,
      };

      case 'rera': return {
        list: (await c.query(`SELECT * FROM qpr_filings ORDER BY due_on DESC`)).rows,
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

      case 'possession': return {
        list: (await c.query(
          `SELECT p.*, u.code, u.buyer_name FROM possessions p
             JOIN units u ON u.id = p.unit_id
            ORDER BY p.handed_over_at NULLS LAST, u.code`)).rows,
      };

      case 'schedule': return {
        list: (await c.query(
          `SELECT t.*, pr.name project_name, pr.phase,
                  (SELECT count(*)::int FROM unit_stages s
                    WHERE s.stage_code = t.code AND s.status = 'paid')      paid,
                  (SELECT count(*)::int FROM unit_stages s
                    WHERE s.stage_code = t.code)                            total
             FROM stage_templates t JOIN projects pr ON pr.id = t.project_id
            ORDER BY t.project_id, t.seq`)).rows,
        avg: (await c.query(
          `SELECT coalesce(avg(agreement_value_paise), 0) v FROM units`)).rows[0].v,
      };

      case 'lenders': return {
        list: (await c.query(
          `SELECT l.*,
                  (SELECT count(*)::int FROM units u WHERE u.bank = l.name)  villas,
                  (SELECT coalesce(sum(dm.total_paise), 0) FROM demands dm
                     JOIN unit_stages s ON s.id = dm.unit_stage_id
                     JOIN units u ON u.id = s.unit_id
                    WHERE u.bank = l.name AND dm.paid_at IS NULL)            owed
             FROM lenders l ORDER BY l.seq`)).rows,
      };

      /* No join to `sessions`. The application role has no read on that table
         at all - it is the session store, and a console that can list live
         sessions is a console that can be read for tokens. So this screen says
         who may sign in, not who is signed in, and the difference is the
         point. */
      case 'logins': return {
        list: (await c.query(
          `SELECT u.id, u.email, u.role, u.display_name, u.engineer_qual, u.engineer_reg
             FROM users u ORDER BY u.role, u.display_name`)).rows,
        buyers: Number((await c.query(
          `SELECT count(*) n FROM units WHERE buyer_user_id IS NOT NULL`)).rows[0].n),
      };

      case 'settings': return {
        project: (await c.query(`SELECT * FROM projects LIMIT 1`)).rows[0],
        villas: Number((await c.query(`SELECT count(*) n FROM units`)).rows[0].n),
        stages: Number((await c.query(`SELECT count(*) n FROM stage_templates`)).rows[0].n),
        lenders: Number((await c.query(`SELECT count(*) n FROM lenders WHERE on_panel`)).rows[0].n),
        audit: Number((await c.query(`SELECT count(*) n FROM audit_log`)).rows[0].n),
      };

      default: return {};
    }
  }

  // ------------------------------------------------------------ the screens

  const SCREENS = {};

  /* ------------------------------------------------------------- dashboard */
  SCREENS.dashboard = (sess, d, msg, view) => {
    const packView = view === 'packs';
    const s = d.rows.stages, m = d.rows.money;
    const waitingValue = d.rows.waiting.reduce((t, r) => t + stageTotal(d.byProject, r), 0);
    const certified = Number(s.certified), due = Number(s.due) || 1;
    const pct = Math.round((certified / due) * 100);

    /* THE PRIMARY VIEW. Every blocked villa, in the column of whoever is
       holding it up, longest wait first.

       ONE CARD PER VILLA, not one per blocked stage. `blockers` is keyed by
       unit_stage, so a villa with two stages blocked appears twice - and if
       the two are held by different parties, in two columns at once. The seed
       on this machine happens to be one blocker per villa and hid it; the test
       database has a villa with two, and the columns summed to 49 against a
       register of 48.

       The rows arrive oldest first, so the first one seen for a villa is the
       one that has waited longest, which is the one worth chasing. The others
       are counted on the card and their value added, never dropped. */
    const byVilla = new Map();
    for (const b of d.rows.blockers) {
      const v = stageTotal(d.byProject, b);
      const seen = byVilla.get(b.code);
      if (seen) { seen.also++; seen.value += v; continue; }
      byVilla.set(b.code, { ...b, value: v, also: 0 });
    }
    const blocked = [...byVilla.values()];
    const holderCols = HOLDER.map(([k, label]) => {
      const g = blocked.filter(b => b.holder_role === k)
        .sort((a, b2) => Number(b2.age) - Number(a.age));
      const sum = g.reduce((t, x) => t + x.value, 0);
      return {
        label,
        note: g.length
          ? esc(M.crore(sum)) + ' &middot; oldest ' + g[0].age + ' days'
          : 'nothing waiting here',
        cards: g.map(b => ({
          title: b.code + ' \u00B7 ' + b.stage_name,
          sub: b.reason + ' \u00B7 with ' + (b.holder || label.toLowerCase())
            + (b.also ? ' \u00B7 and ' + b.also + ' more stage'
              + (b.also === 1 ? '' : 's') + ' on this villa' : ''),
          href: villaHref(b.code),
          tags: (Number(b.age) >= AGE_OVERDUE ? pill('over', b.age + ' days')
            : Number(b.age) >= AGE_AGEING ? pill('due', b.age + ' days')
              : pill('accent', b.age + ' days'))
            + ' ' + pill('grey', M.crore(b.value)),
        })),
      };
    });

    const cols = [
      { label: 'Certified, pack not sent', state: r => r.state === 'queued' },
      { label: 'With the lender', state: r => r.state === 'sending' || (r.state === 'delivered' && !r.paid_at && !r.open_q) },
      { label: 'Lender has asked', state: r => r.open_q > 0 && !r.paid_at },
      { label: 'Disbursed', state: r => !!r.paid_at },
    ].map(c => ({
      label: c.label,
      cards: d.rows.pipeline.filter(c.state).slice(0, 6).map(r => ({
        title: r.code + ' · ' + r.stage_name,
        sub: (r.bank || 'self funded') + ' · ' + (r.total_paise ? M.crore(r.total_paise) : 'not priced'),
        href: villaHref(r.code),
        tags: r.paid_at ? pill('paid', 'Disbursed')
          : r.open_q ? pill('over', 'Query open')
            : r.state === 'queued' ? pill('due', 'Ready to send')
              : pill('accent', 'At the lender'),
      })),
    }));

    return head('Office dashboard',
      'What the money is waiting on today, and who is holding it.',
      btn('Ready to send', { icon: 'report', href: '/office/packs' })
      + btn('Sign-off queue', { icon: 'attend', dark: true, href: '/office/signoff' }))
      + `<div class="hero">
  <div><div class="eyebrow">Waiting on evidence</div>
    <div class="big num">${esc(M.crore(waitingValue))}</div>
    <div class="bigsub">${d.rows.waiting.length} stage${d.rows.waiting.length === 1 ? '' : 's'} marked on site and not yet certified. Nothing can be billed until an engineer signs.</div></div>
  <div>
    <div class="mini-r">
      <div><div class="eyebrow">Certified</div><div class="mini-v g num">${certified}</div></div>
      <div style="text-align:right"><div class="eyebrow">Still to certify</div><div class="mini-v num">${Number(s.due) - certified}</div></div>
    </div>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="barcap"><span><b>${pct}%</b> of stages under way are certified</span><span style="color:var(--faint)">${Number(s.all_stages)} stages in the book</span></div>
  </div>
</div>`
      + kpis([
        { l: 'Villas sold', icon: 'hostel', v: String(d.rows.villas),
          n: d.rows.projects === 1 ? 'on one project'
            : 'across ' + d.rows.projects + ' projects', href: '/office/setup' },
        { l: 'Certified this month', icon: 'cert', v: String(Number(s.this_month)), n: 'stages signed off' },
        { l: 'Packs at the lender', icon: 'money', v: String(d.rows.atLender), n: 'sent, awaiting disbursement' },
        { l: 'Receivable from lenders', icon: 'growth',
          v: esc(M.crore(M.sumAsShown(d.rows.receivable))), n: 'billed and unpaid' },
      ])
      + `<div class="g2">`
      + card('Packs ready to send',
        d.rows.queued.length
          ? d.rows.queued.map(r => row('report', r.code + ' · ' + r.stage_name,
            (r.bank || 'self funded') + ' · queued ' + days(r.queued_at) + 'd ago',
            `<div class="rr">${esc(r.total_paise ? M.crore(r.total_paise) : '—')}</div>`)).join('')
          : empty('Every certified stage has gone out.',
            { label: 'See what is with a lender', href: '/office/wait' }),
        btn('All packs', { href: '/office/packs' }))
      + card('Villas gone quiet',
        d.rows.quiet.length
          ? d.rows.quiet.map(r => row('bell', r.code + ' · ' + r.buyer_name,
            r.last_shot ? 'last photograph ' + ago(r.last_shot) : 'no photograph yet',
            pill('over', r.last_shot ? days(r.last_shot) + 'd' : 'none'))).join('')
          : empty('Every villa has been photographed inside three weeks.',
            { label: 'See the evidence', href: '/office/evidence' }),
        btn('All quiet villas', { href: '/office/silent' }))
      + `</div>`
      + `<div class="g2" style="margin-top:12px">`
      + card('Buyers have asked you something',
        d.rows.questions.length
          ? d.rows.questions.map(q => `<a class="row" href="/office/question/${encodeURIComponent(q.id)}">
<div class="rico">${ic('comms')}</div><div class="rt"><b>${esc(q.subject)}</b>
<span>${esc(q.code)} · ${esc(q.asker)} · ${q.replies} message${q.replies === 1 ? '' : 's'}</span></div>
${pill('over', days(q.raised_at) + 'd')}</a>`).join('')
          : empty('No buyer is waiting on an answer.',
            { label: 'See the warranty claims', href: '/office/warranty' }),
        btn('Warranty', { href: '/office/warranty' }))
      /* THE OLDEST EIGHT, AND IT SAYS SO.

         This card printed every blocked stage - fifty of them - inside one
         half of a two-column grid, so the right-hand column ran for four
         thousand pixels while the left ended after four rows, and the holder
         board underneath was pushed off the bottom of the screen. The oldest
         eight is what a dashboard card is for; the line under it names the
         rest and links to them, which is not the same thing as a silent
         truncation. */
      + card('Reported as stopping the work',
        d.rows.blockers.length
          ? d.rows.blockers.slice(0, 8).map(b => `<a class="row" href="${villaHref(b.code)}">
<div class="rico">${ic('risk')}</div><div class="rt"><b>${esc(b.reason)}</b>
<span>${esc(b.code)} · ${esc(b.stage_name)} · with ${esc(b.holder || b.holder_role)}</span></div>
${pill('over', b.age + 'd')}</a>`).join('')
            + (d.rows.blockers.length > 8
              ? `<div class="ls" style="padding:10px 0 2px">The oldest eight of `
                + d.rows.blockers.length + `. <a href="/office/stages">See every stage</a>,`
                + ` or the board below groups all of them by who is holding it up.</div>`
              : '')
          : empty('Nothing has been reported as blocked.',
            { label: 'See every stage', href: '/office/stages' }),
        btn('Stages', { href: '/office/stages' }))
      + `</div>`
      + `<div class="ct" style="margin:18px 0 12px">The stage worklist</div>`
      + table(['Villa', 'Stage', 'Evidence', 'Status', 'Value'],
        d.rows.worklist.map(r => [
          who(r.code, r.buyer_name),
          esc(r.stage_name),
          num(r.shots + ' photo' + (r.shots === 1 ? '' : 's')),
          statusPill(r),
          `<span class="num" style="font-weight:700">${esc(r.total_paise ? M.crore(r.total_paise) : M.crore(stageTotal(d.byProject, r)))}</span>`,
        ]),
        '1.6fr 1.3fr .9fr 1.1fr .9fr',
        { href: i => villaHref(d.rows.worklist[i].code), empty: 'No stage is under way.' })
      /* Two views of the same forty-eight villas, and the toggle is two links
         rather than a script: the back button works, the choice survives a
         reload, and it needs no JavaScript. `.chip` is the reference's own
         control for exactly this. */
      + `<div class="ct" style="margin:18px 0 12px">`
      + (packView ? 'Packs, from certified to disbursed' : 'Stuck money, by who is holding it up')
      + `</div>`
      + `<div class="filters" style="margin-bottom:14px">`
      + `<a class="chip ${packView ? '' : 'on'}" href="/office">Who is holding it up</a>`
      + `<a class="chip ${packView ? 'on' : ''}" href="/office?view=packs">What state the pack is in</a>`
      + `</div>`
      + (packView ? board(cols) : board(holderCols))
      + (packView ? '' : `<div class="hsub" style="margin-top:10px">`
        + `${blocked.length} of ${d.rows.villas} villas have a stage blocked, `
        + `each in exactly one column: `
        + HOLDER.map(([k, l]) => esc(l) + ' ' + blocked.filter(b => b.holder_role === k).length)
          .join(' &middot; ') + `</div>`);
  };

  /* The one place a stage's state becomes a pill, so no two screens disagree
     about what "waiting" means. */
  function statusPill(r) {
    if (r.paid_at) return pill('paid', 'Disbursed');
    if (r.status === 'marked') return pill('due', 'Waiting to certify');
    if (r.due_at && until(r.due_at) < 0) return pill('over', days(r.due_at) + 'd overdue');
    if (r.status === 'demanded') return pill('due', 'Billed');
    if (r.status === 'certified') return pill('paid', 'Certified');
    if (r.status === 'paid') return pill('paid', 'Paid');
    return pill('grey', 'Not started');
  }

  // ================================================================ SETTING UP

  /* PUTTING A CUSTOMER ON PLINT.

     Everything else in this console reads a project that db/seed.js wrote.
     These screens are how a project gets here instead: create it, give it a
     payment schedule, load its villas from a file, and issue a login to the
     person who bought each one.

     The order is not a preference. A villa cannot exist without a schedule,
     because a villa's stages are created from it; a buyer cannot exist without
     a villa; and a schedule cannot be changed once villas exist, because every
     stage row and every priced demand hangs off those percentages. The screen
     says so at each step rather than letting the database say it afterwards. */

  const projHref = id => '/office/setup/' + encodeURIComponent(id);

  SCREENS.setup = (sess, d, msg) => {
    const list = d.rows.projects;
    return head('Projects',
      'Every project this office runs, and the way to add one. A project needs '
      + 'a payment schedule before it can hold villas, and a villa before it can '
      + 'hold a buyer.')
      + kpis([
        { l: 'Projects', icon: 'hostel', v: String(list.length), n: 'on this console' },
        { l: 'Villas', icon: 'home', v: String(list.reduce((t, p) => t + p.villas, 0)),
          n: 'across all of them' },
        { l: 'Buyers signed up', icon: 'users',
          v: String(list.reduce((t, p) => t + p.buyers, 0)),
          n: 'villas with a login issued' },
      ])
      + titled('Every project', table(
        ['Project', 'Where', 'Builder', 'Schedule', 'Villas', 'Buyers'],
        list.map(p => [
          `<a href="${projHref(p.id)}"><b>${esc(p.name)}</b></a><br>`
            + `<span class="hsub">${esc(p.phase)}</span>`,
          esc(p.location || 'not recorded'),
          esc(p.builder_name || 'not recorded'),
          p.stages ? pill('paid', p.stages + ' stages') : pill('over', 'not set'),
          /* Self-describing on purpose: below 560 a row becomes a block and the
             column headings come off, and "48" over "2 of 48" says nothing. */
          num(p.villas + (p.villas === 1 ? ' villa' : ' villas')),
          num(p.buyers + ' of ' + p.villas + ' signed up'),
        ]),
        '1.6fr 1.2fr 1.4fr .8fr .5fr .7fr',
        { min: 780, empty: 'No project on this console yet. The form below makes one.' }))
      + titled('Add a project', card('', form('/office/project',
        field('Project id', input('id', { required: true, max: 40, placeholder: 'eterna-p2' }))
        + field('Name', input('name', { required: true, max: 80, placeholder: 'NVT Eterna' }))
        + field('Phase', input('phase', { required: true, max: 40, placeholder: 'Phase 2' }))
        + field('Location', input('location', { required: true, max: 80, placeholder: 'Devanahalli, Bengaluru' }))
        + field('Builder', input('builder', { required: true, max: 80, placeholder: 'NVT Quality Lifestyle' }))
        + field('Builder RERA or CIN', input('builder_ref', { max: 80, placeholder: 'PRM/KA/RERA/...' })),
        { submit: 'Create the project', icon: 'plus' })
        + `<p class="hsub" style="margin-top:10px">The id goes in every URL and in
        every villa's identifier, so it is lower case letters, digits and hyphens,
        and it cannot be changed afterwards.</p>`))
      + note('Nothing on this screen deletes. A project, a villa or a buyer with '
        + 'stages, evidence and demands behind it is not something a form should be '
        + 'able to remove, and this product does not delete money.');
  };

  /* ------------------------------------------------------------ one project */

  async function projectFile(sess, id, n) {
    return asUser(sess, async c => {
      const p = (await c.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
      if (!p) return null;
      const stages = (await c.query(
        'SELECT * FROM stage_templates WHERE project_id = $1 ORDER BY seq', [id])).rows;
      /* No join to `users`. The policy `u_self` lets staff read staff rows and
         nobody else's, because that table holds password hashes - so a buyer's
         email cannot be read back here even by the office that issued it. The
         screen says whether a login exists, which is what this office can
         truthfully know. */
      const units = (await c.query(
        `SELECT u.id, u.code, u.unit_type, u.buyer_name, u.agreement_value_paise,
                u.bank, u.buyer_user_id
           FROM units u WHERE u.project_id = $1 ORDER BY u.code`, [id])).rows;
      return { n, main: projectScreen(p, stages, units) };
    });
  }

  function projectScreen(p, stages, units) {
    const withBuyer = units.filter(u => u.buyer_user_id).length;
    const bp = stages.reduce((t, s) => t + s.pct_bp, 0);
    const free = units.filter(u => !u.buyer_user_id);

    return head(p.name + ' · ' + p.phase,
      esc(p.location || 'no location recorded') + ' &middot; built by '
      + esc(p.builder_name || 'not recorded')
      + (p.builder_ref ? ' &middot; ' + esc(p.builder_ref) : ''),
      btn('Every project', { href: '/office/setup', icon: 'back' }))
      + kpis([
        { l: 'Schedule', icon: 'cal', v: stages.length ? stages.length + ' stages' : 'Not set',
          n: stages.length ? (bp / 100).toFixed(2) + ' per cent in total' : 'set it before loading villas',
          tone: stages.length ? null : 'hot' },
        { l: 'Villas', icon: 'hostel', v: String(units.length),
          n: stages.length ? 'each with ' + stages.length + ' stages' : 'none can be loaded yet' },
        { l: 'Buyers signed up', icon: 'users', v: withBuyer + ' of ' + units.length,
          n: 'villas with a login issued',
          tone: units.length && withBuyer < units.length ? 'warn' : null },
      ])

      + titled('The payment schedule', stages.length
        ? table(['Stage', 'Code', 'Per cent', 'What it is'],
          stages.map(s => [
            `<b>${esc(s.name)}</b>`, num(s.code), num((s.pct_bp / 100).toFixed(2) + '%'),
            esc(s.description),
          ]), '1.2fr .7fr .6fr 2fr', { min: 620 })
        : card('', form('/office/schedule',
          field('The stages, one per line: name, per cent',
            '<textarea class="fi" name="stages" rows="10" required placeholder="'
            + 'Booking, 10&#10;Agreement and registration, 15&#10;Foundation, 10'
            + '"></textarea>', { wide: true }),
          { fields: { project: p.id }, submit: 'Set the schedule', icon: 'cal' })
          + `<p class="hsub" style="margin-top:10px">One stage a line: its name, then its
          share of the agreement value. They must add to a hundred. A code is made from
          the name, and a third field on the line becomes its description.</p>`),
        stages.length && units.length ? pill('grey', 'fixed: this project has villas')
          : stages.length ? pill('accent', 'set') : '')
      + (stages.length && units.length
        ? note('The schedule is fixed now, because every stage row and every priced '
          + 'demand on this project hangs off these percentages.')
        : '')

      + titled('The villas', units.length
        ? table(['Villa', 'Type', 'Agreement value', 'Lender', 'Buyer', 'Sign-in'],
          units.map(u => [
            `<b>${esc(u.code)}</b>`,
            esc(u.unit_type),
            num(M.money(u.agreement_value_paise)),
            esc(u.bank || 'self funded'),
            esc(u.buyer_name),
            u.buyer_user_id ? pill('paid', 'issued') : pill('over', 'not issued'),
          ]), '.6fr 1fr 1fr .9fr 1.1fr 1.4fr', { min: 860 })
        : empty(stages.length
          ? 'No villas on this project yet. The file below is how they get here.'
          : 'Set the payment schedule first. A villa’s stages are created from it.'))

      + (stages.length ? '<span id="load"></span>' + titled('Load villas from a file',
        card('', form('/office/villas/preview',
          '<span class="ffile">'
          + file('csv', { id: 'villafile', label: 'Choose a CSV', accept: '.csv,text/csv,text/plain' })
          + '</span>'
          + field('Or paste it here',
            '<textarea class="fi" name="pasted" rows="6" placeholder="'
            + 'code,unit_type,agreement_value,buyer_name,bank,site_engineer&#10;'
            + 'D-01,4 BHK 3200 sq ft,32000000,R. Iyer,SBI,S. Kumar'
            + '"></textarea>', { wide: true }),
          { fields: { project: p.id }, upload: true,
            submit: 'Show me what this would do', icon: 'report' })
          + `<p class="hsub" style="margin-top:10px">The first line may be a header.
          Columns: <b>code, unit_type, agreement_value, buyer_name</b>, and optionally
          <b>bank, site_engineer, channel_partner, relationship_manager</b>. The
          agreement value is in rupees. Nothing is written until you have seen what
          this would create and what it would skip.</p>`)) : '')

      + (free.length ? titled('Issue a buyer sign-in',
        card('', form('/office/buyer',
          field('Villa', select('unit', free.map(u => [u.id, u.code + ' · ' + u.buyer_name])))
          + field('Their name', input('name', { required: true, max: 80, placeholder: 'R. Iyer' }))
          + field('Their email', input('email', { required: true, type: 'email', max: 120, placeholder: 'r.iyer@example.in' })),
          { fields: { project: p.id }, submit: 'Create the login', icon: 'users' })
          + `<p class="hsub" style="margin-top:10px">A password is generated and shown
          once, here, when the login is made. Plint does not email it: you hand it over.
          A villa takes one buyer. The address is not readable back from this desk -
          a buyer's own row is theirs alone, because that table holds password
          hashes - so this screen says whether a login exists, not what it is.</p>`))
        : (units.length ? titled('Issue a buyer sign-in',
          empty('Every villa on this project has a login.')) : ''))

      + note('Bookings and receipts still come from the builder’s ERP and are read, '
        + 'never written back. This screen creates the file a villa needs to exist here: '
        + 'the schedule it is priced against, the villa itself, and the login of the '
        + 'person who bought it.');
  }

  /* --------------------------------------------------- the import, previewed */

  /* WHAT WOULD HAPPEN, BEFORE ANYTHING HAPPENS.

     The text is parsed here and shown back: every row that would be created,
     every row that would be skipped and why. The same text is carried in a
     hidden field to the write, which parses it again - so what is confirmed is
     exactly what was shown, and the preview holds no server-side state that
     could go stale between the two. */
  function importPreview(p, parsed, existing) {
    const ok = parsed.rows.filter(r => !r.why);
    const bad = parsed.rows.filter(r => r.why);
    return head('Load villas into ' + p.name,
      ok.length + ' would be created, ' + bad.length + ' skipped. Nothing has been written yet.',
      btn('Back to the project', { href: projHref(p.id), icon: 'back' }))
      + kpis([
        { l: 'Would be created', icon: 'plus', v: String(ok.length), n: 'villas, with their stages',
          tone: ok.length ? 'ok' : null },
        { l: 'Would be skipped', icon: 'risk', v: String(bad.length), n: 'named below, with the reason',
          tone: bad.length ? 'warn' : null },
        { l: 'Already on the project', icon: 'hostel', v: String(existing), n: 'untouched by this' },
      ])
      + titled('These would be created', ok.length
        ? table(['Villa', 'Type', 'Agreement value', 'Buyer', 'Lender'],
          ok.map(r => [
            `<b>${esc(r.code)}</b>`, esc(r.unit_type), num(M.money(r.agreement_value_paise)),
            esc(r.buyer_name), esc(r.bank || 'self funded'),
          ]), '.7fr 1.2fr 1fr 1.1fr .9fr', { min: 720 })
        : empty('Nothing in this file can be created.'))
      + (bad.length ? titled('These would be skipped', table(
        ['Line', 'Villa', 'Why'],
        bad.map(r => [num('line ' + r.line), `<b>${esc(r.code || '(blank)')}</b>`, esc(r.why)]),
        '.6fr .8fr 2.4fr', { min: 520 })) : '')
      + card('', (ok.length
        ? form('/office/villas/import',
          `<input type="hidden" name="csv" value="${esc(parsed.text)}">`,
          { fields: { project: p.id },
            submit: 'Create these ' + ok.length + ' villa' + (ok.length === 1 ? '' : 's'),
            icon: 'attend' })
        : '<p class="hsub">There is nothing here to create. Fix the file and try again.</p>')
        + `<p class="hsub" style="margin-top:10px">The same text is read again when you
        confirm, so what is written is what is listed above. A row is created whole -
        the villa and every one of its stages - or not at all.</p>`);
  }

  /* ---------------------------------------------------------------- packs */
  SCREENS.packs = (sess, d) => {
    const queued = d.rows.list.filter(r => r.state === 'queued');
    /* Summed from what the rows print, not from the record, so the headline
       cannot drift a lakh away from the column beneath it - the fault that
       put Rs 20.39 Cr on one screen and Rs 20.38 Cr on the next. */
    const value = M.sumAsShown(queued.map(r => r.total_paise));
    return head('Ready to send',
      'Stage verified, pack generated, not yet with the lender. Each one is a stage the buyer has already been billed for.',
      btn('At the lender', { icon: 'money', href: '/office/wait' }))
      + kpis([
        { l: 'Packs waiting', icon: 'report', v: String(queued.length), n: 'made, not sent' },
        { l: 'Value in them', icon: 'money', v: esc(M.crore(value)), n: 'billed and undelivered' },
        { l: 'Oldest', icon: 'risk', v: queued.length ? days(queued[0].queued_at) + 'd' : '—', n: 'since the pack was made' },
        { l: 'Lenders involved', icon: 'growth', v: String(new Set(queued.map(r => r.bank).filter(Boolean)).size), n: 'on these packs' },
      ])
      + note('A pack is five documents. Four of them generate from the record. '
        + 'The fifth is the engineer’s completion certificate, which carries an external '
        + 'qualified signature. The lender still sends its own technical officer — '
        + 'the pack does not stand in for that visit.')
      + filters('packlist', [['Every lender', '*'], ...lendersIn(queued).map(b => [b, tagOf(b)]),
        ['Self funded', 'self']])
      + filters('packlist', [['Any age', '*'], ['Under a week', 'age-week'],
        ['One to two weeks', 'age-fortnight'], ['Over a fortnight', 'age-over']])
      + showing('packlist', 'packs waiting to go out', queued.length)
      + table(['Villa', 'Stage', 'Lender', 'Queued', 'Amount', ''],
        queued.map(r => [
          who(r.code, r.buyer_name, villaHref(r.code)),
          esc(r.stage_name),
          esc(r.bank || 'self funded'),
          num(days(r.queued_at) + 'd ago'),
          `<span class="num" style="font-weight:700">${esc(r.total_paise ? M.crore(r.total_paise) : '—')}</span>`,
          act('/office/send', { id: r.id }, 'Send', { icon: 'report' }),
        ]),
        '1.5fr 1.2fr 1fr .7fr .8fr auto',
        {
          id: 'packlist',
          tags: i => (queued[i].bank ? tagOf(queued[i].bank) : 'self')
            + ' ' + ageBand(days(queued[i].queued_at)),
          empty: 'Every certified stage has gone out.',
          out: { label: 'See what is with a lender', href: '/office/wait' },
          noneMatch: 'No pack is waiting on that lender at that age.',
        });
  };

  /* ----------------------------------------------------------------- wait */
  SCREENS.wait = (sess, d) => {
    const out = d.rows.list.filter(r => r.state === 'delivered' && !r.paid_at);
    const late = out.filter(r => days(r.delivered_at) > PACK_LATE_DAYS);
    const value = M.sumAsShown(out.map(r => r.total_paise));   // as above: sum what shows
    return head('At the lender',
      'Sent, and not yet paid. After ' + PACK_LATE_DAYS + ' days it is worth a phone call.',
      btn('Lender queries', { icon: 'comms', href: '/office/query' }))
      + kpis([
        { l: 'Packs out', icon: 'money', v: String(out.length), n: 'with a lender now' },
        { l: 'Past ' + PACK_LATE_DAYS + ' days', icon: 'risk', v: String(late.length), n: 'worth chasing' },
        { l: 'Money out there', icon: 'growth', v: esc(M.crore(value)), n: 'sent and unpaid' },
        { l: 'Oldest', icon: 'cockpit', v: out.length ? Math.max(...out.map(r => days(r.delivered_at))) + 'd' : '—', n: 'since delivery' },
      ])
      + filters('waitlist', [['Every lender', '*'], ...lendersIn(out).map(b => [b, tagOf(b)]),
        ['Self funded', 'self']])
      + filters('waitlist', [['Any age', '*'], ['Past ' + PACK_LATE_DAYS + ' days', 'late'],
        ['Inside ' + PACK_LATE_DAYS, 'ok'], ['Never chased', 'unchased']])
      + showing('waitlist', 'packs with a lender', out.length)
      + table(['Villa', 'Stage', 'Lender', 'With them', 'Chased', 'Amount', ''],
        out.map(r => [
          who(r.code, r.buyer_name, villaHref(r.code)),
          esc(r.stage_name),
          esc(r.bank || 'self funded'),
          days(r.delivered_at) > PACK_LATE_DAYS
            ? pill('over', days(r.delivered_at) + ' days')
            : pill('due', days(r.delivered_at) + ' days'),
          /* One attempt is the delivery itself, so a pack that has been chased
             has more than one. Saying "chased 3 times, last on Tuesday" is the
             difference between chasing and chasing again. */
          r.attempts > 1
            ? num((r.attempts - 1) + '× · ' + M.longDate(r.last_attempt_at))
            : `<span style="color:var(--faint)">not yet</span>`,
          `<span class="num" style="font-weight:700">${esc(r.total_paise ? M.crore(r.total_paise) : '—')}</span>`,
          act('/office/chase-pack', { id: r.id }, 'Chase', { icon: 'comms' }),
        ]),
        '1.4fr 1.1fr .9fr .9fr 1.1fr .8fr auto',
        {
          id: 'waitlist',
          tags: i => (out[i].bank ? tagOf(out[i].bank) : 'self')
            + ' ' + (days(out[i].delivered_at) > PACK_LATE_DAYS ? 'late' : 'ok')
            + (out[i].attempts > 1 ? '' : ' unchased'),
          empty: 'Nothing is sitting with a lender.',
          out: { label: 'See the packs ready to send', href: '/office/packs' },
          noneMatch: 'No pack with that lender is at that age.',
        });
  };

  /* ---------------------------------------------------------------- query */
  SCREENS.query = (sess, d) => {
    const open = d.rows.list.filter(r => !r.answered_at);
    const done = d.rows.list.filter(r => r.answered_at);
    return head('Lender queries',
      'A lender has asked something before it will release. Until it is answered, that stage is not moving.')
      + kpis([
        { l: 'Open', icon: 'comms', v: String(open.length), n: 'waiting on this office' },
        { l: 'Answered', icon: 'attend', v: String(done.length), n: 'sent back' },
        { l: 'Oldest open', icon: 'risk', v: open.length ? days(open[0].asked_at) + 'd' : '—', n: 'since they asked' },
        { l: 'Villas affected', icon: 'hostel', v: String(new Set(open.map(r => r.code)).size), n: 'with a query open' },
      ])
      + (open.length ? filters('querylist', [['Every lender', '*'],
        ...lendersIn(open).map(b => [b, tagOf(b)])])
        + filters('querylist', [['Any age', '*'], ['Asked this week', 'age-week'],
          ['One to two weeks', 'age-fortnight'], ['Open over a fortnight', 'age-over']])
        + showing('querylist', 'queries open', open.length)
        + `<div id="querylist">` : '')
      + (open.length ? open.map(q => `<div class="card" data-tags="${esc(tagOf(q.bank))} ${ageBand(days(q.asked_at))}" style="margin-bottom:12px">
<div class="ch"><div class="ct">${esc(q.code)} · ${esc(q.stage_name)}</div>${pill('over', esc(q.bank || 'lender'))}</div>
<div class="cb">
<div class="row"><div class="rico">${ic('comms')}</div><div class="rt"><b>${esc(q.question)}</b>
<span>asked ${esc(M.longDate(q.asked_at))} · ${ago(q.asked_at)}</span></div></div>
<form method="post" action="/office/query" style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
<input type="hidden" name="id" value="${esc(q.id)}">
<input class="chip" name="answer" required maxlength="400" placeholder="What you are sending back"
 style="flex:1 1 260px;min-width:0;cursor:text;font-family:var(--body)">
<button class="btn dark" type="submit">${ic('comms')} Send the answer</button></form>
</div></div>`).join('') + `<div class="empty filtered-empty" hidden>No lender query matches those filters.`
        + `<div style="margin-top:12px"><button class="btn" type="button" data-clear="querylist">Clear filters</button></div></div></div>`
        : empty('No lender is waiting on an answer.',
          { label: 'See what is with a lender', href: '/office/wait' }))
      + (done.length ? `<div class="ct" style="margin:18px 0 12px">Answered</div>`
        + table(['Villa', 'Stage', 'They asked', 'You sent back', 'When'],
          done.map(r => [esc(r.code), esc(r.stage_name), esc(r.question),
            `<b>${esc(r.answer || '—')}</b>`, num(M.longDate(r.answered_at))]),
          '.7fr 1fr 1.6fr 1.6fr .8fr') : '');
  };

  /* ---------------------------------------------------------------- chase */
  SCREENS.chase = (sess, d) => {
    const list = d.rows.list;
    return head('Sanction not recorded',
      'The buyer has chosen a lender and the sanction letter has not reached this office. Nothing can be disbursed against a sanction nobody has recorded.')
      + kpis([
        { l: 'Files waiting', icon: 'risk', v: String(list.length), n: 'no sanction on record' },
        { l: 'Value at stake', icon: 'money', v: esc(M.crore(M.sumAsShown(list.map(r => r.agreement_value_paise)))), n: 'agreement value of those villas' },
        { l: 'Chosen a lender', icon: 'attend', v: String(list.filter(r => r.lender_chosen_at).length), n: 'and told us which' },
        { l: 'Lenders involved', icon: 'growth', v: String(new Set(list.map(r => r.bank)).size), n: 'across these files' },
      ])
      + (list.length ? list.map(u => `<div class="card" style="margin-bottom:12px">
<div class="ch"><div class="ct">${esc(u.code)} · ${esc(u.buyer_name)}</div>${pill('due', esc(u.bank))}</div>
<div class="cb">
<div class="row"><div class="rico">${ic('money')}</div><div class="rt"><b>Agreement ${esc(M.crore(u.agreement_value_paise))}</b>
<span>${u.lender_chosen_at ? 'lender chosen ' + esc(M.longDate(u.lender_chosen_at)) : 'no date recorded for the choice'}</span></div></div>
<form method="post" action="/office/sanction" style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
<input type="hidden" name="unit" value="${esc(u.unit_id)}">
<input class="chip" name="sanction" required inputmode="numeric" placeholder="Sanctioned amount in rupees"
 style="flex:1 1 180px;min-width:0;cursor:text;font-family:var(--body)">
<input class="chip" name="own" required inputmode="numeric" placeholder="Buyer's own contribution"
 style="flex:1 1 180px;min-width:0;cursor:text;font-family:var(--body)">
<input class="chip" name="letter" required maxlength="60" placeholder="Sanction letter reference"
 style="flex:1 1 180px;min-width:0;cursor:text;font-family:var(--body)">
<button class="btn dark" type="submit">${ic('attend')} Record the sanction</button></form>
</div></div>`).join('')
        : empty('Every file with a lender has its sanction on record.',
          { label: 'See the villas', href: '/office/villas' }));
  };

  /* --------------------------------------------------------------- stages */
  SCREENS.stages = (sess, d) => {
    const list = d.rows.list;
    const by = k => list.filter(r => r.status === k).length;
    return head('Stages',
      'Every stage of every villa, in the order the payment schedule sets them.')
      + kpis([
        { l: 'Paid', icon: 'attend', v: String(by('paid')), n: 'money in' },
        { l: 'Billed', icon: 'money', v: String(by('demanded')), n: 'demand raised' },
        { l: 'Certified', icon: 'cert', v: String(by('certified')), n: 'signed, not yet billed' },
        { l: 'Marked on site', icon: 'growth', v: String(by('marked')), n: 'waiting on an engineer' },
      ])
      + search('stagelist', 'Find a villa or a stage')
      + filters('stagelist', [['Every stage', '*'],
        ...[...new Set(list.map(r => r.stage_name))].map(n => [n, tagOf(n)])])
      + filters('stagelist', [['Any state', '*'], ['Reported blocked', 'blocked'],
        ['Waiting to certify', 'marked'], ['Certified', 'certified'], ['Billed', 'demanded'],
        ['Paid', 'paid'], ['Not started', 'pending']])
      + showing('stagelist', 'stages', list.length)
      + table(['Villa', 'Stage', 'Evidence', 'Status', 'Value'],
        list.map(r => [
          who(r.code, r.buyer_name),
          `<b>${esc(r.stage_name)}</b>`
          + (r.blocked_reason
            ? `<span style="display:block;font-size:11px;color:var(--red)">${esc(r.blocked_reason)}`
              + ` · with ${esc(r.blocked_with || 'the site')} ${r.blocked_age}d</span>` : ''),
          num(r.shots + ' photo' + (r.shots === 1 ? '' : 's')),
          r.blocked_reason ? pill('over', 'blocked') : statusPill(r),
          `<span class="num" style="font-weight:700">${esc(M.crore(r.total_paise || stageTotal(d.byProject, r)))}</span>`,
        ]),
        '1.5fr 1.4fr .9fr 1.1fr .9fr',
        {
          id: 'stagelist', href: i => villaHref(list[i].code),
          tags: i => list[i].status + ' ' + tagOf(list[i].stage_name)
            + (list[i].blocked_reason ? ' blocked' : ''),
          noneMatch: 'No stage of that name is in that state.',
        });
  };

  /* ------------------------------------------------------------- evidence */
  SCREENS.evidence = (sess, d) => {
    const t = d.rows.totals;
    return head('Evidence certificates',
      'Every photograph is hashed when it is captured and the hash goes into the stage certificate. A photograph that changes stops matching its certificate.')
      + kpis([
        { l: 'Photographs', icon: 'cert', v: String(t.shots), n: 'captured on site' },
        { l: 'Distinct hashes', icon: 'attend', v: String(t.distinct_hashes), n: t.shots === t.distinct_hashes ? 'no duplicate content' : 'duplicates present' },
        { l: 'Certificates issued', icon: 'report', v: String(d.rows.certs), n: 'stages with a signed hash' },
        { l: 'Villas covered', icon: 'hostel', v: String(new Set(d.rows.list.map(r => r.code)).size), n: 'in the last 40 photographs' },
      ])
      + note('The engineer’s completion certificate is the one document in the pack that '
        + 'carries an external qualified signature. The other four generate from this record. '
        + 'None of it replaces the lender’s own technical officer, who still visits.')
      + search('evlist', 'Find a villa, a stage or a caption')
      + showing('evlist', 'photographs', d.rows.list.length)
      + table(['Villa', 'Stage', 'Caption', 'Taken', 'Hash'],
        d.rows.list.map(r => [
          `<b>${esc(r.code)}</b>`,
          esc(r.stage_name),
          esc(r.caption || '—'),
          num(M.longDate(r.taken_at)),
          `<span class="num" style="color:var(--faint);font-size:11.5px">${esc(String(r.sha256 || '').slice(0, 12))}</span>`,
        ]),
        '.8fr 1.2fr 1.8fr 1fr 1fr',
        {
          id: 'evlist', href: i => villaHref(d.rows.list[i].code),
          tags: () => 'all',
          noneMatch: 'No photograph matches that.',
          empty: 'No photographs have been captured yet.',
          out: { label: 'See the villas that have gone quiet', href: '/office/silent' },
        });
  };

  /* --------------------------------------------------------------- silent */
  SCREENS.silent = (sess, d) => {
    const quiet = d.rows.list.filter(r => !r.last_shot || days(r.last_shot) >= QUIET_DAYS);
    return head('Site gone quiet',
      'No photograph in ' + QUIET_DAYS + ' days. Either nothing is happening on that villa, or something is happening and nobody is recording it.')
      + kpis([
        { l: 'Villas quiet', icon: 'bell', v: String(quiet.length), n: 'over ' + QUIET_DAYS + ' days' },
        { l: 'Never photographed', icon: 'risk', v: String(quiet.filter(r => !r.last_shot).length), n: 'nothing on record at all' },
        { l: 'Longest silence', icon: 'cockpit', v: quiet.filter(r => r.last_shot).length ? Math.max(...quiet.filter(r => r.last_shot).map(r => days(r.last_shot))) + 'd' : '—', n: 'since the last photograph' },
        { l: 'Asked for a photograph', icon: 'comms', v: String(quiet.filter(r => r.asked_at).length), n: 'and still waiting' },
      ])
      + note('Asking does not take a villa off this list. It leaves when a '
        + 'photograph arrives from site, which is the only thing that answers '
        + 'the question the list is asking.')
      + (quiet.length ? filters('quietlist', [['Any silence', '*'],
        ['Three weeks to a month', 'q-month'], ['One to two months', 'q-two'],
        ['Over two months', 'q-long'], ['Never photographed', 'q-never']])
        + filters('quietlist', [['Asked or not', '*'], ['Asked already', 'q-asked'],
          ['Not asked yet', 'q-unasked']])
        + showing('quietlist', 'villas quiet', quiet.length)
        + `<div id="quietlist">` : '')
      + (quiet.length ? quiet.map(u => `<div class="card" data-tags="${
          !u.last_shot ? 'q-never' : days(u.last_shot) <= 30 ? 'q-month'
            : days(u.last_shot) <= 60 ? 'q-two' : 'q-long'} ${
          u.asked_at ? 'q-asked' : 'q-unasked'}" style="margin-bottom:12px">
<div class="ch"><div class="ct">${esc(u.code)} · ${esc(u.buyer_name)}</div>
${u.last_shot ? pill('over', days(u.last_shot) + ' days quiet') : pill('over', 'never photographed')}</div>
<div class="cb">
<div class="row"><div class="rico">${ic('growth')}</div><div class="rt"><b>${esc(u.next_stage || 'No stage pending')}</b>
<span>${esc(u.engineer_name || 'no engineer assigned')}</span></div>
<a class="btn" href="${villaHref(u.code)}">Open the villa</a>
${act('/office/ask', { unit: u.unit_id }, 'Ask for a photograph', { icon: 'bell' })}</div>
${u.asked_at ? `<div class="row"><div class="rico">${ic('comms')}</div>
<div class="rt"><b>Asked ${days(u.asked_at)} day${days(u.asked_at) === 1 ? '' : 's'} ago</b>
<span>${esc(u.asked_by || 'this office')} · it stays here until a photograph arrives</span></div>
${pill('accent', 'asked')}</div>` : ''}
<form method="post" action="/office/assign" style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
<input type="hidden" name="unit" value="${esc(u.unit_id)}">
<input type="hidden" name="from" value="silent">
<select class="chip" name="engineer" style="flex:1 1 200px;min-width:0;font-family:var(--body)">
${d.rows.engineers.map(e => `<option value="${esc(e.id)}"${e.id === u.assigned_engineer_id ? ' selected' : ''}>${esc(e.display_name)}</option>`).join('')}
</select>
<button class="btn dark" type="submit">${ic('hr')} Move it to them</button></form>
</div></div>`).join('') + `<div class="empty filtered-empty" hidden>No quiet villa matches those filters.`
        + `<div style="margin-top:12px"><button class="btn" type="button" data-clear="quietlist">Clear filters</button></div></div></div>`
        : empty('Every villa has been photographed inside ' + QUIET_DAYS + ' days.',
          { label: 'See the villas', href: '/office/villas' }));
  };

  /* -------------------------------------------------------------- signoff */
  SCREENS.signoff = (sess, d) => {
    const list = d.rows.list;
    return head('Sign-off queue',
      'Marked on site and waiting for a qualified engineer to certify it. Only a qualified engineer may sign the completion certificate, so nothing here can be cleared from this desk.')
      + kpis([
        { l: 'Waiting', icon: 'attend', v: String(list.length), n: 'stages marked, not certified' },
        { l: 'Value held up', icon: 'money', v: esc(M.crore(list.reduce((t, r) => t + stageTotal(d.byProject, r), 0))), n: 'cannot be billed yet' },
        { l: 'Oldest', icon: 'risk', v: list.length ? days(list[0].marked_at) + 'd' : '—', n: 'since it was marked' },
        { l: 'Without evidence', icon: 'cert', v: String(list.filter(r => r.shots === 0).length), n: 'no photograph attached' },
      ])
      + (list.length ? list.map(s => `<div class="card" style="margin-bottom:12px">
<div class="ch"><div class="ct">${esc(s.code)} · ${esc(s.stage_name)}</div>
${s.shots ? pill('due', s.shots + ' photograph' + (s.shots === 1 ? '' : 's')) : pill('over', 'no evidence')}</div>
<div class="cb">
<div class="row"><div class="rico">${ic('hr')}</div><div class="rt"><b>${esc(s.engineer_name || 'No engineer assigned')}</b>
<span>marked ${esc(M.longDate(s.marked_at))} · ${days(s.marked_at)} days waiting</span></div>
<div class="rr">${esc(M.crore(stageTotal(d.byProject, s)))}</div></div>
<form method="post" action="/office/assign" style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
<input type="hidden" name="unit" value="${esc(s.unit_id)}">
<input type="hidden" name="from" value="signoff">
<span class="hsub" style="flex:1 1 200px;margin:0">Ask a different engineer to certify this</span>
<select class="chip" name="engineer" style="flex:0 1 200px;min-width:0;font-family:var(--body)">
${d.rows.engineers.map(e => `<option value="${esc(e.id)}"${e.id === s.assigned_engineer_id ? ' selected' : ''}>${esc(e.display_name)}</option>`).join('')}
</select>
<button class="btn dark" type="submit">${ic('hr')} Reassign</button></form>
</div></div>`).join('') : empty('Nothing is waiting to be certified.'));
  };

  /* --------------------------------------------------------------- villas */
  SCREENS.villas = (sess, d) => {
    const list = d.rows.list;
    return head('Villas',
      'Every villa this console can see, its project, its buyer, its lender and how '
      + 'far through the book it is.',
      btn('Stages', { icon: 'growth', href: '/office/stages' }))
      + kpis([
        { l: 'Villas', icon: 'hostel', v: String(list.length),
          n: 'across ' + new Set(list.map(r => r.project_name)).size + ' project'
            + (new Set(list.map(r => r.project_name)).size === 1 ? '' : 's') },
        { l: 'With a lender', icon: 'money', v: String(list.filter(r => r.bank).length), n: 'the rest are self funded' },
        { l: 'Sanction recorded', icon: 'attend', v: String(list.filter(r => r.sanction_recorded_at).length), n: 'of those with a lender' },
        { l: 'New from sales', icon: 'plus', v: String(d.rows.handoffs.length), n: 'no owner in this office yet' },
      ])
      + (d.rows.handoffs.length ? card('New from sales, not picked up',
        d.rows.handoffs.map(h => `<div class="row"><div class="rico">${ic('plus')}</div>
<div class="rt"><b>${esc(h.code)} · ${esc(h.buyer_name)}</b>
<span>${esc(h.salesperson)} · token ${esc(M.crore(h.token_paise))} · ${ago(h.created_at)}</span></div>
<form method="post" action="/office/handoff"><input type="hidden" name="id" value="${esc(h.id)}">
<button class="btn dark" type="submit">Pick it up</button></form></div>`).join(''))
        + '<div style="height:12px"></div>' : '')
      + search('villalist', 'Find a villa or a buyer')
      + filters('villalist', [['Every stage', '*'],
        ...[...new Set(list.map(r => r.next_stage).filter(Boolean))].map(n => [n, tagOf(n)])])
      + filters('villalist', [['Every lender', '*'], ...lendersIn(list).map(b => [b, tagOf(b)]),
        ['Self funded', 'self']])
      + filters('villalist', [['Money moving', '*'], ['Money stuck here', 'stuck']])
      + showing('villalist', 'villas', list.length)
      + table(['Villa', 'Project', 'Stage in hand', 'Lender', 'Engineer', 'Paid', 'Agreement'],
        list.map(r => [
          who(r.code, r.buyer_name),
          esc(r.project_name),
          esc(r.next_stage || 'all stages paid'),
          r.bank ? esc(r.bank) : `<span style="color:var(--faint)">self funded</span>`,
          esc(r.engineer_name || '—'),
          num(r.paid + ' / ' + r.stages),
          `<span class="num" style="font-weight:700">${esc(M.crore(r.agreement_value_paise))}</span>`,
        ]),
        '1.5fr 1.1fr 1.1fr 1fr 1.1fr .6fr .9fr',
        {
          id: 'villalist', href: i => villaHref(list[i].code), min: 900,
          /* "Money stuck" is the question this screen is scanned for: a villa
             with a lender and no sanction on record, or a stage certified and
             not yet paid, is a villa whose money has stopped. */
          tags: i => (list[i].bank ? tagOf(list[i].bank) : 'self')
            + ' ' + tagOf(list[i].next_stage)
            + ((list[i].bank && !list[i].sanction_recorded_at) || list[i].stuck > 0
              ? ' stuck' : ''),
          noneMatch: 'No villa at that stage is with that lender.',
        });
  };

  /* ------------------------------------------------------------ documents */
  SCREENS.documents = (sess, d) => head('Documents',
    'Five documents make a stage pack. Four of them generate from this record. The fifth is the engineer’s completion certificate, and that one needs an external qualified signature.')
    + note('The five are the engineer’s completion certificate, the demand note, '
      + 'the photograph sheet, the progress statement and the statement of account. '
      + 'Four of them print from the record. The certificate is the one that carries '
      + 'an external qualified signature, and only a qualified engineer may sign it. '
      + 'None of them replaces the lender’s own technical officer — the lender always '
      + 'sends one, and the pack is what its officer reads before the visit.')
    + kpis([
      { l: 'Stage packs', icon: 'report', v: String(d.rows.stages.length), n: 'certified or beyond' },
      { l: 'Generated', icon: 'settings', v: String(d.rows.stages.length * 4), n: 'four per pack, from the record' },
      { l: 'Signed by an engineer', icon: 'cert', v: String(d.rows.stages.filter(r => r.certificate_hash).length), n: 'completion certificates' },
      { l: 'Loan files', icon: 'users', v: String(d.rows.loans.length), n: 'applicants on record' },
    ])
    + `<div class="ct" style="margin:6px 0 12px">The five, per stage</div>`
    + search('doclist', 'Find a villa or a buyer')
    + filters('doclist', [['Everything', '*'], ['Waiting on the engineer', 'unsigned'],
      ['Not billed yet', 'unbilled'], ['No photographs', 'noshots'], ['Complete', 'complete']])
    + showing('doclist', 'stage packs', d.rows.stages.length)
    + table(['Villa', 'Stage', 'The five documents', 'Signed'],
      d.rows.stages.map(r => [
        `<b><a href="${villaHref(r.code)}">${esc(r.code)}</a></b>`,
        esc(r.stage_name),
        /* Every one of the five, openable. Four print from the record; the
           fifth is the engineer's and carries their signature. The demand note
           exists only once a stage has been billed, so it says so when it has
           not been. */
        `<span class="lt" style="display:flex;gap:6px;flex-wrap:wrap">`
        + [['certificate', 'Certificate'], ['photographs', 'Photographs'],
           ['progress', 'Progress'], ['account', 'Account']].map(([k, l]) =>
          `<a class="pill p-accent" href="/doc/${k}/${encodeURIComponent(r.id)}.pdf">${l}</a>`).join('')
        + (r.doc_no
          ? `<a class="pill p-accent" href="/doc/demand/${encodeURIComponent(r.id)}.pdf">Demand</a>`
          : pill('grey', 'demand not raised'))
        + `</span>`,
        r.certificate_hash ? pill('paid', 'engineer') : pill('due', 'waiting'),
      ]),
      '.6fr 1.1fr 2.6fr .8fr',
      { id: 'doclist', empty: 'No stage has been certified yet.',
        noneMatch: 'Every pack is complete on that measure.',
        tags: i => (d.rows.stages[i].certificate_hash ? 'signed' : 'unsigned')
          + (d.rows.stages[i].doc_no ? ' billed' : ' unbilled')
          + (d.rows.stages[i].shots ? '' : ' noshots')
          + (d.rows.stages[i].certificate_hash && d.rows.stages[i].doc_no
            && d.rows.stages[i].shots ? ' complete' : '') })
    + `<div class="ct" style="margin:18px 0 12px">Loan files, by applicant</div>`
    + table(['Applicant', 'Villa', 'Relation', 'Documents seen'],
      d.rows.loans.map(r => [
        who(r.full_name, null),
        esc(r.code),
        esc(r.relation || '—'),
        r.asked === r.seen ? pill('paid', r.seen + ' of ' + r.asked)
          : pill('due', r.seen + ' of ' + r.asked),
      ]),
      '1.6fr .8fr 1.2fr 1fr',
        { empty: 'No loan file has been opened.',
          out: { label: 'See the sanctions not recorded', href: '/office/chase' } });

  /* -------------------------------------------------------------- choices */
  SCREENS.choices = (sess, d) => {
    const list = d.rows.list;
    const open = list.filter(r => !r.selected);
    const late = open.filter(r => r.needed_by && until(r.needed_by) < 0);
    return head('Choices',
      'Tiles, sanitaryware, kitchen. A choice that misses its cut-off holds up the stage behind it.')
      + kpis([
        { l: 'Not made', icon: 'exam', v: String(open.length), n: 'still open' },
        { l: 'Past the cut-off', icon: 'risk', v: String(late.length), n: 'holding up work' },
        { l: 'Made', icon: 'attend', v: String(list.length - open.length), n: 'and recorded' },
        { l: 'Villas waiting', icon: 'hostel', v: String(new Set(open.map(r => r.code)).size), n: 'with a choice open' },
      ])
      + filters('choicelist', [['All', '*'], ['Past the cut-off', 'late'], ['Open', 'open'],
        ['Made', 'made']])
      + showing('choicelist', 'choices', list.length)
      + table(['Villa', 'Choice', 'Needed by', 'Status', 'Selected'],
        list.map(r => [
          who(r.code, r.buyer_name),
          `<b>${esc(r.label)}</b>`,
          r.needed_by ? num(M.longDate(r.needed_by)) : '—',
          r.selected ? pill('paid', 'made')
            : (r.needed_by && until(r.needed_by) < 0)
              ? pill('over', Math.abs(until(r.needed_by)) + 'd past')
              : pill('due', 'waiting'),
          esc(r.selected || '—'),
        ]),
        '1.5fr 1.4fr 1fr 1fr 1.1fr',
        {
          id: 'choicelist', href: i => villaHref(list[i].code),
          tags: i => (list[i].selected ? 'made' : 'open')
            + (!list[i].selected && list[i].needed_by && until(list[i].needed_by) < 0 ? ' late' : ''),
          noneMatch: 'No choice is in that state.',
        });
  };

  /* --------------------------------------------------------------- visits */
  SCREENS.visits = (sess, d) => {
    const list = d.rows.list;
    const asked = list.filter(r => r.status === 'requested');
    return head('Visits',
      'Buyers coming to site. The engineer confirms or moves the slot; this office sees where each one stands.')
      + kpis([
        { l: 'Requested', icon: 'cal', v: String(asked.length), n: 'waiting on an engineer' },
        { l: 'Confirmed', icon: 'attend', v: String(list.filter(r => r.status === 'confirmed').length), n: 'slot agreed' },
        { l: 'Declined', icon: 'risk', v: String(list.filter(r => r.status === 'declined').length), n: 'a new slot is needed' },
        { l: 'Villas', icon: 'hostel', v: String(new Set(list.map(r => r.code)).size), n: 'with a visit on record' },
      ])
      + filters('visitlist', [['All', '*'], ['Requested', 'requested'],
        ['Confirmed', 'confirmed'], ['Declined', 'declined']])
      + showing('visitlist', 'visits', list.length)
      + table(['Villa', 'Slot', 'Engineer', 'Status', 'Note'],
        list.map(r => [
          who(r.code, r.buyer_name),
          num(M.longDate(r.slot_at)),
          esc(r.engineer_name || '—'),
          r.status === 'confirmed' ? pill('paid', 'confirmed')
            : r.status === 'declined' ? pill('over', 'declined') : pill('due', 'requested'),
          esc(r.note || r.response_note || '—'),
        ]),
        '1.5fr 1.1fr 1.2fr 1fr 1.6fr',
        {
          id: 'visitlist', href: i => villaHref(list[i].code),
          tags: i => list[i].status, empty: 'No visit has been asked for.',
          noneMatch: 'No visit is in that state.',
        });
  };

  /* ------------------------------------------------------------- warranty */
  SCREENS.warranty = (sess, d) => {
    const open = d.rows.snags.filter(s => s.status === 'open');
    const claims = d.rows.claims;
    return head('Warranty',
      'Snags raised after handover, and the claims buyers have opened against them.')
      + kpis([
        { l: 'Open snags', icon: 'risk', v: String(open.length), n: 'not yet fixed' },
        { l: 'Fixed', icon: 'attend', v: String(d.rows.snags.length - open.length), n: 'closed out' },
        { l: 'Claims open', icon: 'comms', v: String(claims.filter(c => c.status !== 'closed').length), n: 'buyers waiting on an answer' },
        { l: 'Villas', icon: 'hostel', v: String(new Set(open.map(s => s.code)).size), n: 'with something open' },
      ])
      + `<div class="ct" style="margin:6px 0 12px">Claims from buyers</div>`
      + filters('claimlist', [['All', '*'], ['Open', 'open'], ['Closed', 'closed']])
      + showing('claimlist', 'claims', claims.length)
      + table(['Villa', 'Claim', 'Raised', 'Messages', 'Status'],
        claims.map(q => [
          `<b>${esc(q.code)}</b>`,
          esc(q.subject),
          num(M.longDate(q.raised_at)),
          num(String(q.replies)),
          q.status === 'closed' ? pill('paid', 'closed') : pill('over', 'open'),
        ]),
        '.8fr 2fr 1fr .8fr 1fr',
        {
          id: 'claimlist',
          href: i => '/office/question/' + encodeURIComponent(claims[i].id),
          tags: i => (claims[i].status === 'closed' ? 'closed' : 'open'),
          noneMatch: 'No claim is in that state.',
          empty: 'No warranty claim has been opened.',
          out: { label: 'See the villas', href: '/office/villas' },
        })
      + `<div class="ct" style="margin:18px 0 12px">Snags on site</div>`
      + search('snaglist', 'Find a villa or a trade')
      + filters('snaglist', [['All', '*'], ['Open', 'open'], ['Fixed', 'fixed']])
      + filters('snaglist', [['Every trade', '*'], ...TRADES.map(t => [t[1], 'trade-' + t[0]])])
      + showing('snaglist', 'snags', d.rows.snags.length)
      + table(['Villa', 'Snag', 'Raised by', 'Raised', 'Status'],
        d.rows.snags.map(s => [
          `<b>${esc(s.code)}</b>`,
          esc(s.title),
          esc(s.raised_role || '—'),
          num(M.longDate(s.raised_at)),
          s.status === 'open' ? pill('over', 'open') : pill('paid', 'fixed'),
        ]),
        '.8fr 2fr 1fr 1fr 1fr',
        {
          id: 'snaglist',
          tags: i => d.rows.snags[i].status + ' trade-' + tradeOf(d.rows.snags[i].title),
          noneMatch: 'No snag of that trade is in that state.',
          empty: 'No snag has been raised.',
          out: { label: 'See after possession', href: '/office/possession' },
        });
  };

  /* ----------------------------------------------------------------- rera */
  SCREENS.rera = (sess, d) => {
    const list = d.rows.list;
    const due = list.filter(r => !r.filed_at);
    return head('RERA filing',
      'The quarterly progress report. It is filed against the same certified stages the packs are built from, so the two cannot disagree.')
      + kpis([
        { l: 'Quarters on record', icon: 'cert', v: String(list.length), n: 'since the project opened' },
        { l: 'Filed', icon: 'attend', v: String(list.length - due.length), n: 'with a reference' },
        { l: 'Not filed', icon: 'risk', v: String(due.length), n: 'still owed' },
        { l: 'Next due', icon: 'cal', v: due.length ? esc(M.longDate(due[due.length - 1].due_on)) : '—', n: 'the earliest one outstanding' },
      ])
      + (due.length ? due.map(q => `<div class="card" style="margin-bottom:12px">
<div class="ch"><div class="ct">${esc(q.quarter)}</div>${until(q.due_on) < 0 ? pill('over', Math.abs(until(q.due_on)) + ' days late') : pill('due', 'due ' + M.longDate(q.due_on))}</div>
<div class="cb">
<form method="post" action="/office/qpr" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
<input type="hidden" name="id" value="${esc(q.id)}">
<input class="chip" name="reference" required maxlength="60" placeholder="Acknowledgement reference from the portal"
 style="flex:1 1 260px;min-width:0;cursor:text;font-family:var(--body)">
<button class="btn dark" type="submit">${ic('attend')} Mark it filed</button></form>
</div></div>`).join('') : '')
      + table(['Quarter', 'Due', 'Filed', 'Reference'],
        list.map(r => [
          `<b>${esc(r.quarter)}</b>`,
          num(M.longDate(r.due_on)),
          r.filed_at ? pill('paid', M.longDate(r.filed_at)) : pill('over', 'not filed'),
          esc(r.reference || '—'),
        ]),
        '1fr 1fr 1.2fr 1.6fr',
        { empty: 'No quarter is on record.',
          out: { label: 'See the evidence certificates', href: '/office/evidence' } });
  };

  /* --------------------------------------------------------------- escrow */
  SCREENS.escrow = (sess, d) => {
    const t = d.rows.totals;
    const held = Number(t.inn) - Number(t.out);
    return head('Escrow drawdown',
      'Seventy per cent of what a buyer pays stays in the project account until the work it was billed for is certified. This is what has moved.')
      + kpis([
        { l: 'Held now', icon: 'money', v: esc(M.crore(held)), n: 'in the project account' },
        { l: 'Paid in', icon: 'growth', v: esc(M.crore(t.inn)), n: 'from buyers and lenders' },
        { l: 'Drawn down', icon: 'report', v: esc(M.crore(t.out)), n: 'released against certified work' },
        { l: 'Movements', icon: 'cockpit', v: String(d.rows.list.length), n: 'most recent first' },
      ])
      + table(['When', 'Villa', 'Direction', 'Reference', 'Amount'],
        d.rows.list.map(r => [
          num(M.longDate(r.occurred_at)),
          esc(r.code || '—'),
          r.direction === 'in' ? pill('paid', 'in') : pill('accent', 'drawn'),
          esc(r.reference || '—'),
          `<span class="num" style="font-weight:700">${esc(M.crore(r.amount_paise))}</span>`,
        ]),
        '1fr .8fr .8fr 1.8fr 1fr',
        { empty: 'Nothing has moved through the account yet.',
          out: { label: 'See what has been billed', href: '/office/stages' } });
  };

  /* ----------------------------------------------------------- possession */
  SCREENS.possession = (sess, d) => {
    const list = d.rows.list;
    const done = list.filter(r => r.handed_over_at);
    return head('After possession',
      'Offered, snags cleared, handed over. The warranty clock starts at handover.')
      + kpis([
        { l: 'Handed over', icon: 'home', v: String(done.length), n: 'keys with the buyer' },
        { l: 'Offered', icon: 'cal', v: String(list.filter(r => r.offered_at && !r.handed_over_at).length), n: 'awaiting handover' },
        { l: 'Snags cleared', icon: 'attend', v: String(list.filter(r => r.snags_cleared_at).length), n: 'before handover' },
        { l: 'Villas in the list', icon: 'hostel', v: String(list.length), n: 'at or past offer' },
      ])
      + table(['Villa', 'Offered', 'Snags cleared', 'Handed over', 'Keys to'],
        list.map(r => [
          who(r.code, r.buyer_name),
          r.offered_at ? num(M.longDate(r.offered_at)) : pill('grey', 'not offered'),
          r.snags_cleared_at ? pill('paid', M.longDate(r.snags_cleared_at)) : pill('due', 'open'),
          r.handed_over_at ? pill('paid', M.longDate(r.handed_over_at)) : pill('due', 'waiting'),
          esc(r.keys_to || '—'),
        ]),
        '1.5fr 1fr 1.2fr 1.2fr 1fr',
        { href: i => villaHref(list[i].code), empty: 'No villa has reached possession.',
          out: { label: 'See the villas', href: '/office/villas' } });
  };

  /* ------------------------------------------------------------- schedule */
  SCREENS.schedule = (sess, d) => {
    const list = d.rows.list;
    const avg = Number(d.rows.avg);
    return head('Payment schedule',
      'Set once for the project. Every villa is billed against these percentages, and a stage cannot be billed before it is certified.')
      + note('Changing a percentage here does not re-bill anything already raised. '
        + 'A demand is immutable once it exists — a correction is a credit note against it, '
        + 'never an edit.')
      + table(['#', 'Stage', 'Share', 'On the average villa', 'Paid', 'Of'],
        list.map(r => [
          `<b>${r.seq + 1}</b>`,
          `<b>${esc(r.name)}</b><span style="display:block;font-size:11px;color:var(--faint)">${esc(r.description || '')}</span>`,
          num((r.pct_bp / 100).toFixed(1) + '%'),
          `<span class="num" style="font-weight:700">${esc(M.crore(avg * r.pct_bp / 10000))}</span>`,
          num(String(r.paid)),
          num(String(r.total)),
        ]),
        '.4fr 2.2fr .7fr 1.2fr .6fr .6fr',
        { empty: 'No schedule is set.', out: { label: 'See the stages', href: '/office/stages' } });
  };

  /* -------------------------------------------------------------- lenders */
  SCREENS.lenders = (sess, d) => {
    const list = d.rows.list;
    return head('Lenders',
      'The panel. A buyer may use any lender; these are the ones with the project already approved, which is the difference between two weeks and six.')
      + kpis([
        { l: 'On the panel', icon: 'money', v: String(list.filter(r => r.on_panel).length), n: 'project approved' },
        { l: 'Off panel', icon: 'growth', v: String(list.filter(r => !r.on_panel).length), n: 'buyer may still use them' },
        { l: 'Villas financed', icon: 'hostel', v: String(list.reduce((t, r) => t + r.villas, 0)), n: 'across all lenders' },
        /* Summed from what the rows will PRINT, not from what is stored: this
           figure sits directly above its own evidence, and a headline that
           does not equal the column under it is the fastest way to lose a
           reader's trust in every other number on the screen. */
        { l: 'Owed to us', icon: 'report',
          v: esc(M.crore(M.sumAsShown(list.map(r => r.owed)))), n: 'billed and unpaid' },
      ])
      + filters('lenderlist', [['All', '*'], ['On the panel', 'panel'], ['Off panel', 'offpanel'],
        ['Owes us money', 'owing']])
      + showing('lenderlist', 'lenders', list.length)
      + table(['Lender', 'APF code', 'Rate', 'Turnaround', 'Villas', 'Owed'],
        list.map(r => [
          `<b>${esc(r.name)}</b>`,
          `<span class="num" style="font-size:11.5px;color:var(--faint)">${esc(r.apf_code || '—')}</span>`,
          num((r.rate_bp / 100).toFixed(2) + '%'),
          r.on_panel ? num(r.turnaround_low + '–' + r.turnaround_high + ' days') : pill('grey', 'not on panel'),
          num(String(r.villas)),
          `<span class="num" style="font-weight:700">${esc(M.crore(r.owed))}</span>`,
        ]),
        '1.3fr 1.5fr .7fr 1.1fr .6fr .9fr',
        {
          id: 'lenderlist',
          tags: i => (list[i].on_panel ? 'panel' : 'offpanel')
            + (Number(list[i].owed) > 0 ? ' owing' : ''),
          noneMatch: 'No lender matches that.',
          empty: 'No lender is on record.',
        });
  };

  /* --------------------------------------------------------------- logins */
  SCREENS.logins = (sess, d) => {
    const list = d.rows.list;
    return head('Logins',
      'Who can sign in, and as what. A buyer’s login is created with their villa and can only ever read that villa.')
      + note('This console cannot read a buyer’s account row, and it cannot read the '
        + 'session store at all — the database refuses both. So this is who may sign in, '
        + 'not who is signed in, and buyer accounts are counted here rather than listed.')
      + kpis([
        { l: 'Office', icon: 'users', v: String(list.filter(r => r.role === 'office').length), n: 'this desk' },
        { l: 'Engineers', icon: 'hr', v: String(list.filter(r => r.role === 'engineer').length), n: 'qualified to certify' },
        { l: 'Buyers', icon: 'hostel', v: String(d.rows.buyers), n: 'one per villa' },
        { l: 'Readable here', icon: 'bolt', v: String(list.length), n: 'of ' + (list.length + d.rows.buyers) + ' accounts' },
      ])
      + table(['Name', 'Email', 'Role', 'Qualification', 'Registration'],
        list.map(r => [
          who(r.display_name || r.email, null),
          `<span style="color:var(--grey)">${esc(r.email)}</span>`,
          r.role === 'office' ? pill('accent', 'office') : pill('grey', 'engineer'),
          esc(r.engineer_qual || '—'),
          esc(r.engineer_reg || '—'),
        ]),
        '1.4fr 1.6fr .9fr 1.3fr 1.1fr',
        { empty: 'No account is readable from here.',
          out: { label: 'Back to the dashboard', href: '/office' } });
  };

  /* ------------------------------------------------------------- settings */
  SCREENS.settings = (sess, d) => head('Settings',
    'What this console is pointed at, and what it may write.')
    + `<div class="g2">`
    + card('The project',
      row('hostel', d.rows.project.name + ' · ' + d.rows.project.phase, d.rows.villas + ' villas')
      + row('cal', 'Payment schedule', d.rows.stages + ' stages, set once for the project',
        `<a class="btn" href="/office/schedule">Open</a>`)
      + row('money', 'Lender panel', d.rows.lenders + ' lenders with the project approved',
        `<a class="btn" href="/office/lenders">Open</a>`)
      + row('users', 'Logins', 'office, engineers and one buyer per villa',
        `<a class="btn" href="/office/logins">Open</a>`))
    + card('What this console writes',
      row('report', 'Bookings and receipts', 'read from your ERP — nothing is written back',
        pill('grey', 'read only'))
      + row('cert', 'Stage certificates', 'signed by a qualified engineer, never from this desk',
        pill('grey', 'engineer only'))
      + row('money', 'Demands', 'immutable once raised; a correction is a credit note',
        pill('accent', 'append only'))
      + row('settings', 'Audit log', d.rows.audit + ' entries — every write, with who and when',
        pill('accent', 'append only')))
    + `</div>`
    + note('Money is in rupees throughout, rolled up to lakh and crore. '
      + 'Dates are Indian Standard Time.');

  /* ----------------------------------------------------------------- help */
  SCREENS.help = () => head('Help',
    'How this console expects to be used, and the rules it will not let you break.')
    + `<div class="g2">`
    + card('The things people ask',
      row('cert', 'Why can I not certify a stage from here?',
        'Only a qualified engineer may sign a completion certificate. This desk can reassign it, not sign it.')
      + row('report', 'What is in a pack?',
        'Five documents. Four generate from the record; the fifth is the engineer’s certificate.')
      + row('users', 'Does the pack replace the lender’s visit?',
        'No. The lender always sends its own technical officer. The pack is what that officer reads first.')
      + row('money', 'Can I edit a demand?',
        'No. A demand is immutable once raised. Raise a credit note against it instead.'))
    + card('Where things live',
      row('growth', 'A villa’s whole file', 'Villas, then the villa — stages, evidence, money, people',
        `<a class="btn" href="/office/villas">Open</a>`)
      + row('risk', 'Money that has stopped', 'Ready to send, At the lender, Lender queries, Sanction not recorded',
        `<a class="btn" href="/office/packs">Open</a>`)
      + row('bolt', 'What is on fire today', 'The dashboard leads with what is waiting on evidence',
        `<a class="btn" href="/office">Open</a>`))
    + `</div>`;

  // ------------------------------------------------------- the villa file

  async function villaFile(sess, code, n) {
    return asUser(sess, async c => {
      const u = (await c.query(
        `SELECT u.*, w.display_name engineer_name FROM units u
           LEFT JOIN users w ON w.id = u.assigned_engineer_id WHERE u.code = $1`, [code])).rows[0];
      if (!u) return null;
      const byProject = await schedules(c);
      const stages = (await c.query(
        `SELECT s.*, t.name stage_name, t.seq, t.pct_bp, dm.total_paise, dm.due_at, dm.paid_at,
                dm.doc_no,
                (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
           FROM unit_stages s
           JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = $2
           LEFT JOIN demands dm ON dm.unit_stage_id = s.id
          WHERE s.unit_id = $1 ORDER BY t.seq`, [u.id, u.project_id])).rows;
      const qs = (await c.query(
        `SELECT q.*, (SELECT count(*)::int FROM query_messages m WHERE m.query_id = q.id) replies
           FROM queries q WHERE q.unit_id = $1 ORDER BY q.raised_at DESC`, [u.id])).rows;
      const paid = stages.filter(s => s.paid_at).reduce((t, s) => t + Number(s.total_paise), 0);

      const main = head(u.code + ' · ' + u.buyer_name,
        (u.unit_type || '') + ' · ' + (u.bank || 'self funded')
        + ' · ' + esc(u.engineer_name || 'no engineer assigned'),
        btn('All villas', { href: '/office/villas' })
        + btn('Stages', { icon: 'growth', dark: true, href: '/office/stages' }))
        + `<div class="hero">
  <div><div class="eyebrow">Agreement value</div>
    <div class="big num">${esc(M.crore(u.agreement_value_paise))}</div>
    <div class="bigsub">${esc(u.unit_type || 'villa')} · ${esc(u.bank ? 'financed by ' + u.bank : 'self funded')}</div></div>
  <div>
    <div class="mini-r">
      <div><div class="eyebrow">Paid so far</div><div class="mini-v g num">${esc(M.crore(paid))}</div></div>
      <div style="text-align:right"><div class="eyebrow">Sanction</div><div class="mini-v num">${esc(u.sanction_paise ? M.crore(u.sanction_paise) : '—')}</div></div>
    </div>
    <div class="bar"><span style="width:${Math.round((paid / Number(u.agreement_value_paise)) * 100)}%"></span></div>
    <div class="barcap"><span><b>${stages.filter(s => s.paid_at).length}</b> of ${stages.length} stages paid</span>
      <span style="color:var(--faint)">${esc(u.sanction_recorded_at ? 'sanction recorded' : 'sanction not recorded')}</span></div>
  </div>
</div>`
        + table(['#', 'Stage', 'Evidence', 'Status', 'Amount'],
          stages.map(s => [
            `<b>${s.seq + 1}</b>`,
            `<b>${esc(s.stage_name)}</b>`,
            num(s.shots + ' photo' + (s.shots === 1 ? '' : 's')),
            statusPill(s),
            `<span class="num" style="font-weight:700">${esc(M.crore(s.total_paise || stageTotal(byProject, { ...s, agreement_value_paise: u.agreement_value_paise, project_id: u.project_id })))}</span>`,
          ]),
          '.4fr 2fr 1fr 1.2fr 1fr')
        + (qs.length ? `<div class="ct" style="margin:18px 0 12px">What this buyer has asked</div>`
          + table(['Subject', 'Kind', 'Raised', 'Messages', 'Status'],
            qs.map(q => [
              `<b>${esc(q.subject)}</b>`,
              q.kind === 'warranty' ? pill('over', 'warranty') : pill('accent', 'question'),
              num(M.longDate(q.raised_at)),
              num(String(q.replies)),
              q.status === 'closed' ? pill('paid', 'closed') : pill('due', 'open'),
            ]),
            '2fr 1fr 1fr .8fr 1fr',
            { href: i => '/office/question/' + encodeURIComponent(qs[i].id) }) : '');
      return { main, n };
    });
  }

  // ----------------------------------------------------- one question thread

  async function questionThread(sess, id, n, msg) {
    return asUser(sess, async c => {
      const q = (await c.query(
        `SELECT q.*, u.code, coalesce(w.display_name, u.buyer_name) asker
           FROM queries q JOIN units u ON u.id = q.unit_id
           LEFT JOIN users w ON w.id = q.raised_by WHERE q.id = $1`, [id])).rows[0];
      if (!q) return null;
      const msgs = (await c.query(
        `SELECT m.*, coalesce(w.display_name, initcap(m.author_role)) author_name
           FROM query_messages m LEFT JOIN users w ON w.id = m.author_id
          WHERE m.query_id = $1 ORDER BY m.sent_at`, [id])).rows;

      const main = head(q.subject,
        esc(q.code) + ' · ' + esc(q.asker) + ' · '
        + (q.kind === 'warranty' ? 'warranty claim' : 'question')
        + ' · raised ' + esc(M.longDate(q.raised_at)),
        btn('Villa file', { href: villaHref(q.code) })
        + (q.status !== 'closed'
          ? btn('Close this', { icon: 'attend', dark: true, post: '/office/close', fields: { id: q.id } })
          : ''))
        + `<div class="card"><div class="ch"><div class="ct">The thread</div>
${q.status === 'closed' ? pill('paid', 'closed') : pill('due', 'open')}</div><div class="cb">`
        + (msgs.length ? msgs.map(m => row(
          m.author_role === 'office' ? 'users' : 'comms',
          m.body,
          (m.author_role === 'office' ? 'You' : m.author_name) + ' · ' + M.longDate(m.sent_at))).join('')
          : empty('The buyer has said nothing beyond the subject line.'))
        + `<form method="post" action="/office/answer" style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
<input type="hidden" name="id" value="${esc(q.id)}">
<input class="chip" name="body" required maxlength="400" placeholder="What you want to tell them"
 style="flex:1 1 260px;min-width:0;cursor:text;font-family:var(--body)">
<button class="btn dark" type="submit">${ic('comms')} Send</button></form>
</div></div>`;
      return { main, n };
    });
  }

  return {
    KEYS, NAV, nav, counts, load, SCREENS, villaFile, questionThread,
    projectFile, importPreview, projHref,
    render: (sess, key, d, msg, view) =>
      officePage(sess, nav(key, d.n), SCREENS[key](sess, d, msg, view), msg),
    wrap: (sess, n, main, msg) => officePage(sess, nav(null, n), main, msg),
  };
};
