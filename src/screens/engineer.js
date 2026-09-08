'use strict';
/* ============================================================================
   The site engineer's five tabs, and the villa detail behind them.

   v21 gives this role Me, Villas, Visits, Log and Certs, and a villa screen
   with three modes: Update (photographs and stage marking), Problem (report a
   delay) and Snags. All of it here reads and writes the database, so what the
   engineer does on site is what the office and the buyer see next.

   WHAT THIS FILE MAY NOT DO. It does not price a stage, raise a demand or
   write an audit row. Certification goes through the same `certify()` the
   route handler has always called, which is the only path that touches money,
   and the audit row is written by the trigger on unit_stages rather than by
   anything here.

   Dependencies arrive as a context object rather than by requiring server.js,
   because server.js requires this. Nothing is imported across that line.
   ========================================================================= */

module.exports = function engineerScreens(ctx) {
  const { esc, desk, M, asUser, schedules, stageTotal, LOGO } = ctx;

  /* One list row, built in one place. See src/screens/rows.js for why the
     villa code has to be inside the heading rather than beside it. */
  const { wrow, whead, empty, ageChip, AGE } = require('./rows')({ esc });
  /* The furniture every dashboard is built from. One platform, three
     dashboards: the header, the summary card and the tile grid are defined
     once in ./ui and composed here. Nothing in this file draws its own - it
     used to draw nine, each slightly different from the other eight. */
  const UI = require('./ui')({ esc });

  /* v21's six kinds of log entry, with the quick entries it offers under each.
     Two taps, which is the point: a site person will not type a paragraph, and
     an empty log six months later is what loses the argument. */
  const LOG_KINDS = {
    material: ['Material received', 'Cement, steel, blocks, fittings',
      ['120 bags cement', '8 tonnes steel', '2000 blocks', 'Fittings, plumbing']],
    labour: ['Labour on site', 'Head count by trade',
      ['Under 10 on site', '10 to 20 on site', '20 to 40 on site', 'Over 40 on site']],
    weather: ['Weather stoppage', 'Rain or heat, hours lost',
      ['Rain, under 2 hours', 'Rain, half day', 'Rain, full day', 'Heat stoppage']],
    safety: ['Safety incident', 'Anything, however minor',
      ['Near miss, no injury', 'Minor injury, first aid', 'Injury, sent to hospital', 'Unsafe condition found']],
    drawing: ['Drawing revision', 'New sheet from the architect',
      ['New revision received', 'Revision supersedes an issued sheet', 'Query raised with the architect', 'Drawing missing']],
    rework: ['Rework', 'Work redone and why',
      ['Work redone, passed', 'Work redone, still failing', 'Material rejected', 'Level or line out of tolerance']],
  };

  /* v21's four delay reasons on the Problem tab. */
  const FLAGS = [
    ['Material not delivered', 'Blocks work until resolved'],
    ['Labour shortage', 'Stage will slip'],
    ['Design clash on site', 'Needs an architect decision'],
    ['Weather stoppage', 'No work possible'],
  ];

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  const chip = n => ageChip(n);
  /* From the shared layer. Three files had their own copy, all three drawing a
     `.tools` panel - a white card around the words "Sent." */
  const flash = UI.flash;

  // ---------------------------------------------------------------- reads

  /** Everything the five tabs count, in one round trip per request. */
  async function load(sess) {
    return asUser(sess, async c => {
      const mine = (await c.query(
        `SELECT u.id, u.code, u.buyer_name, u.bank, u.project_id, u.agreement_value_paise,
                (SELECT max(e.taken_at) FROM evidence e
                   JOIN unit_stages s2 ON s2.id = e.unit_stage_id
                  WHERE s2.unit_id = u.id) last_shot,
                (SELECT t.name FROM unit_stages s3
                   JOIN stage_templates t ON t.code = s3.stage_code AND t.project_id = u.project_id
                  WHERE s3.unit_id = u.id AND s3.status = 'pending'
                  ORDER BY t.seq LIMIT 1) next_stage,
                (SELECT b.reason FROM unit_stages s4 JOIN blockers b ON b.unit_stage_id = s4.id
                  WHERE s4.unit_id = u.id LIMIT 1) blocker_reason,
                (SELECT b.holder_role FROM unit_stages s5 JOIN blockers b ON b.unit_stage_id = s5.id
                  WHERE s5.unit_id = u.id LIMIT 1) blocker_role
           FROM units u
          WHERE u.assigned_engineer_id = $1
          ORDER BY u.code`, [sess.id])).rows;

      const certs = (await c.query(
        `SELECT s.id, s.marked_at, s.marked_by, u.code, u.buyer_name, u.bank, u.project_id,
                u.agreement_value_paise, t.name stage_name, t.seq, t.pct_bp,
                (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
           FROM unit_stages s
           JOIN units u ON u.id = s.unit_id
           JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
          WHERE s.status = 'marked'
          ORDER BY s.marked_at`)).rows;

      const visits = (await c.query(
        `SELECT v.*, u.code, u.buyer_name
           FROM visits v JOIN units u ON u.id = v.unit_id
          WHERE v.status IN ('requested','confirmed','reassign')
          ORDER BY v.slot_at`)).rows;

      const snags = (await c.query(
        `SELECT sn.*, u.code, w.display_name raiser
           FROM snags sn JOIN units u ON u.id = sn.unit_id
           JOIN users w ON w.id = sn.raised_by
          ORDER BY sn.status, sn.raised_at`)).rows;

      const log = (await c.query(
        `SELECT l.*, w.display_name logger FROM site_log l JOIN users w ON w.id = l.logged_by
          ORDER BY l.logged_at DESC LIMIT 40`)).rows;

      return { mine, certs, visits, snags, log, byProject: await schedules(c) };
    });
  }

  const NAV = [['/engineer', 'Me'], ['/engineer/villas', 'Villas'],
               ['/engineer/visits', 'Visits'], ['/engineer/log', 'Log'],
               ['/engineer/certs', 'Certs']];

  // ------------------------------------------------------------- Me (today)

  function me(sess, d, msg) {
    const chased = d.mine.filter(v => v.blocker_role === 'engineer');
    const pending = d.certs.filter(x => x.shots >= 2);
    const open = d.snags.filter(s => s.status === 'open');
    const total = chased.length + pending.length + open.length;

    return desk(sess, '/engineer', 'Me', '', `
${UI.head('On you today',
  'Everything on this engineer, in the order it will be asked for.',
  UI.summary({
    cap: 'on you',
    figure: String(total),
    tone: total ? 'hot' : null,
    note: 'Nothing here moves without you, and nothing reaches a lender until you sign.',
    parts: [
      { cap: 'Chased', value: String(chased.length), tone: UI.countTone(chased.length, true) },
      { cap: 'To sign', value: String(pending.length), tone: UI.countTone(pending.length, false) },
      { cap: 'Snags', value: String(open.length), tone: UI.countTone(open.length, true) },
    ],
  }) + UI.stats([
    { n: chased.length, label: 'Office chasing', sub: 'villas they have flagged',
      href: '/engineer/villas', tone: UI.countTone(chased.length, true) },
    { n: pending.length, label: 'To certify', sub: 'ready for your signature',
      href: '/engineer/certs', tone: UI.countTone(pending.length, false) },
    { n: open.length, label: 'Snags', sub: 'to photograph and close',
      href: '/engineer/snags', tone: UI.countTone(open.length, true) },
    { n: d.visits.length, label: 'Visits', sub: 'buyers coming to site',
      href: '/engineer/visits' },
  ]))}
<div class="mbody anim">
${flash(msg)}
${open.length ? `<div class="tools"><a class="wbtn st" href="/engineer/snags"
  style="text-decoration:none">Close ${open.length} snag${open.length === 1 ? '' : 's'}</a><div class="g"></div></div>` : ''}
${chased.length ? `<div class="blk"><p class="k">Office is chasing you</p></div>
<div class="wl">${chased.map(v => wrow({
  href: '/engineer/villa/' + encodeURIComponent(v.code),
  code: v.code,
  title: v.next_stage || 'All stages done',
  detail: esc(v.buyer_name) + ' &middot; ' + esc(v.blocker_reason || ''),
  days: v.last_shot ? days(v.last_shot) + 'd' : 'no photo',
  daysAge: v.last_shot ? days(v.last_shot) : null,
  chip: '<i class="chip late">Chased</i>',
})).join('')}</div><div class="gap"></div>` : ''}

<div class="blk"><p class="k">Waiting on your signature</p></div>
<div class="wl">${pending.length ? pending.slice(0, 8).map(x => wrow({
  href: '/engineer/cert/' + encodeURIComponent(x.id),
  code: x.code,
  title: x.stage_name,
  detail: esc(x.buyer_name) + ' &middot; ' + x.shots + ' photograph' + (x.shots === 1 ? '' : 's'),
  days: days(x.marked_at) + 'd',
  daysAge: days(x.marked_at),
  amount: M.money(stageTotal(d.byProject, x)),
})).join('')
  : empty('Nothing waiting on your signature.')}</div>
</div>`);
  }

  // -------------------------------------------------------------- Villas

  function villas(sess, d, msg) {
    const rows = d.mine.map(v => {
      const since = v.last_shot ? days(v.last_shot) : null;
      return wrow({
        href: '/engineer/villa/' + encodeURIComponent(v.code),
        code: v.code,
        title: v.next_stage || 'All stages done',
        detail: esc(v.buyer_name) + ' &middot; ' + esc(v.bank || 'self funded'),
        days: since === null ? '' : since + 'd',
        daysAge: since,
        chip: ageChip(since),
      });
    }).join('');

    /* 'Three weeks' and the pill's 'overdue' have to be the same number, or
       the sentence counts villas the rows do not flag. */
    const behind = d.mine.filter(v => !v.last_shot || days(v.last_shot) >= AGE.overdue).length;
    return desk(sess, '/engineer/villas', 'Villas', '', `
${UI.head('Villas to update',
  `${behind} ${behind === 1 ? 'has' : 'have'} gone three weeks without a photograph.`,
  UI.summary({ cap: 'assigned', figure: String(d.mine.length),
    tone: behind ? 'warn' : null,
    parts: [
      { cap: 'Quiet', value: String(behind), tone: UI.countTone(behind, true) },
      { cap: 'Photographed', value: String(d.mine.length - behind), tone: 'ok' },
    ] }))}
<div class="mbody anim">${flash(msg)}
<div class="wl">${d.mine.length ? `<div class="whead"><span class="id">Villa</span>
<span class="mid">Next stage and buyer</span><span class="stc">Evidence</span>
<span class="amt"></span><span class="actc">Action</span></div>${rows}`
  : '<div class="emptyrow"><p class="b ink">No villas are assigned to you.</p></div>'}</div>
</div>`);
  }

  // -------------------------------------------------------------- Visits

  function visits(sess, d, msg) {
    const cards = d.visits.map(v => {
      const mine = v.engineer_id === sess.id;
      const when = M.longDate(v.slot_at) + ', ' +
        new Date(v.slot_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      /* Name on the title line, when and why underneath - v21's `.vhead` puts
         the person first and the slot on its own line. Both on one line made
         the title wrap four deep on a phone. */
      return wrow({
        code: v.code,
        title: v.buyer_name,
        detail: esc(when) + ' &middot; ' + esc(v.note || 'No note.')
                + (mine ? '' : ' &middot; named to another engineer'),
        days: days(v.requested_at) + 'd ago',
        daysAge: days(v.requested_at),
        chip: '<i class="chip ' + (v.status === 'confirmed' ? 'ok'
              : v.status === 'reassign' ? 'warn' : 'wait') + '">'
              + (v.status === 'confirmed' ? 'Accepted'
              : v.status === 'reassign' ? 'Reassign' : 'New') + '</i>',
        /* Two controls need a line of their own; one does not. A confirmed
           visit offers only "Cannot make it", and marking it wide put that
           single button on its own row with the rest of the line empty. */
        actionWide: v.status !== 'confirmed',
        action: `
${v.status === 'confirmed'
  ? `<form method="post" action="/engineer/visit"><input type="hidden" name="id" value="${esc(v.id)}">
<input type="hidden" name="do" value="declined">
<button class="wbtn st" type="submit">Cannot make it</button></form>`
  : `<form method="post" action="/engineer/visit" style="display:flex;gap:6px;flex-wrap:wrap">
<input type="hidden" name="id" value="${esc(v.id)}">
<button class="wbtn solid st" type="submit" name="do" value="confirmed">Accept</button>
<button class="wbtn st" type="submit" name="do" value="reassign">Ask to reassign</button></form>`}`,
      });
    }).join('');

    return desk(sess, '/engineer/visits', 'Visits', '', `
${UI.head('Buyers coming to site',
  'You are named to each. Flags raised while you are there, you answer on the spot.',
  UI.summary({ cap: 'booked', figure: String(d.visits.length) }))}
<div class="mbody anim">${flash(msg)}
<div class="wl">${d.visits.length ? cards
  : '<div class="emptyrow"><p class="b ink">No visits booked. Buyers request a slot from their app.</p></div>'}</div>
</div>`);
  }

  // --------------------------------------------------------------- Snags

  function snags(sess, d, msg) {
    const open = d.snags.filter(s => s.status === 'open');
    const done = d.snags.filter(s => s.status === 'fixed');
    const row = s => wrow({
      code: s.code,
      title: s.title,
      detail: 'Raised by ' + esc(s.raiser) + ' &middot; ' + M.longDate(s.raised_at),
      days: s.status === 'fixed' ? '' : days(s.raised_at) + 'd',
      daysAge: s.status === 'fixed' ? null : days(s.raised_at),
      chip: s.status === 'fixed' ? '<i class="chip ok">Sent</i>' : chip(days(s.raised_at)),
    }) + `
${s.status === 'open' ? `<form method="post" action="/engineer/snag" enctype="multipart/form-data" class="uprow"
  style="display:flex;gap:10px;align-items:center;padding:10px 26px 16px;border-bottom:1px solid var(--hair)">
<input type="hidden" name="id" value="${esc(s.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<input class="fi" type="file" name="photo" accept="image/jpeg,image/png" required
  style="margin:0;flex:0 0 200px;padding:7px 8px">
<input class="fi" name="caption" placeholder="What was done" required maxlength="120"
  style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi n" name="gps" placeholder="12.8391, 77.7724" required maxlength="40"
  style="margin:0;flex:0 0 150px;padding:7px 10px"></span>
<button class="wbtn st" type="submit" style="flex:0 0 160px">Photograph the fix</button></form>` : ''}`;

    /* Reached from Me and from a villa, not from the bar - v21 gives it a back
       button to Me rather than a slot of its own, and five slots are taken. So
       the shell is told Me is the current destination, or the bar would
       highlight nothing while the engineer is standing on a real screen. */
    return desk(sess, '/engineer', 'Snags', '', `
${UI.head('Snags to close',
  'Photograph the fix. The buyer signs it off, not you.',
  UI.summary({ cap: 'open', figure: String(open.length), tone: open.length ? 'hot' : null }),
  { href: '/engineer', label: 'Back' })}
<div class="mbody anim">${flash(msg)}
<div class="wl">${open.length ? open.map(row).join('')
  : '<div class="emptyrow"><p class="b ink">No open snags. Everything raised has been fixed and sent for sign-off.</p></div>'}</div>
${done.length ? `<div class="gap"></div><div class="blk"><p class="k">Fixed, waiting for the buyer</p></div>
<div class="wl">${done.map(row).join('')}</div>` : ''}
</div>`);
  }

  // ----------------------------------------------------------------- Log

  function log(sess, d, kind, msg) {
    if (kind && LOG_KINDS[kind]) {
      const [label, detail, quick] = LOG_KINDS[kind];
      return desk(sess, '/engineer/log', label, '', `
${UI.head(label, esc(detail), '', { href: '/engineer/log', label: 'Back' })}
<div class="mbody anim">
<div class="blk"><p class="k">Quick entries</p></div>
<div class="wl">${quick.map(q => `<form method="post" action="/engineer/log" class="wrow">
<input type="hidden" name="kind" value="${esc(kind)}">
<input type="hidden" name="title" value="${esc(q)}">
<span class="mid"><p class="rt">${esc(q)}</p><p class="s">One tap. Recorded against you, now.</p></span>
<span class="actc"><button class="wbtn solid st" type="submit">Add</button></span></form>`).join('')}</div>
<div class="gap"></div>
<div class="blk"><p class="k">Or write it</p></div>
<form method="post" action="/engineer/log" class="uprow"
  style="display:flex;gap:10px;align-items:center;padding:10px 26px 16px">
<input type="hidden" name="kind" value="${esc(kind)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<input class="fi" name="title" placeholder="What happened" required maxlength="120"
  style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi" name="detail" placeholder="Detail, optional" maxlength="200"
  style="margin:0;flex:1;min-width:0;padding:7px 10px"></span>
<button class="wbtn st" type="submit" style="flex:0 0 140px">Add entry</button></form>
</div>`);
    }

    return desk(sess, '/engineer/log', 'Site log', '', `
${UI.head('Site log',
  'Two taps. This is what settles a dispute six months later.',
  UI.summary({ cap: 'entries', figure: String(d.log.length) }))}
<div class="mbody anim">${flash(msg)}
<div class="blk"><div class="lgrid">
${Object.entries(LOG_KINDS).map(([k, [label, detail]]) => `<a class="lgb st"
  href="/engineer/log/${k}" style="text-decoration:none">
<span class="h2">${esc(label)}</span>
<span class="s">${esc(detail)}</span></a>`).join('')}</div></div>
<div class="gap"></div>
<div class="blk"><p class="k">Recent</p></div>
<div class="wl">${d.log.length ? d.log.map(e => wrow({
  title: e.title,
  detail: esc(e.detail || '') + (e.detail ? ' &middot; ' : '') + esc(e.logger),
  days: days(e.logged_at) + 'd ago',
  chip: '<i class="chip wait">' + esc(e.kind) + '</i>',
})).join('')
  : empty('Nothing logged yet.')}</div>
</div>`);
  }

  // --------------------------------------------------------------- Certs

  function certs(sess, d, msg) {
    const pend = d.certs;
    return desk(sess, '/engineer/certs', 'Certs', '', `
${UI.head('Waiting for your signature',
  'Nothing reaches the lender until you sign.',
  UI.summary({ cap: 'files', figure: String(pend.length),
    tone: pend.length ? 'hot' : null,
    parts: [
      { cap: 'Ready', value: String(pend.filter(x => x.shots >= 2).length), tone: 'ok' },
      { cap: 'Short of photographs', value: String(pend.filter(x => x.shots < 2).length),
        tone: UI.countTone(pend.filter(x => x.shots < 2).length, false) },
    ] }))}
<div class="mbody anim">${flash(msg)}
<div class="wl">${pend.length ? `<div class="whead"><span class="id">Villa</span>
<span class="mid">Stage and buyer</span><span class="stc">Evidence</span>
<span class="amt">Amount</span><span class="actc">Action</span></div>` : ''}
${pend.length ? pend.map(x => {
  const thin = x.shots < 2;
  return wrow({
    code: x.code,
    title: x.stage_name,
    detail: esc(x.buyer_name) + ' &middot; marked by ' + esc(x.marked_by)
            + ' on ' + M.longDate(x.marked_at),
    days: days(x.marked_at) + 'd',
    daysAge: days(x.marked_at),
    chip: '<i class="chip ' + (thin ? 'warn' : 'wait') + '">'
          + (thin ? x.shots + ' photo' + (x.shots === 1 ? '' : 's') : 'ready') + '</i>',
    amount: M.money(stageTotal(d.byProject, x)),
    action: thin ? 'Too few photos'
          : '<a class="wbtn solid st" href="/engineer/cert/' + encodeURIComponent(x.id)
            + '" style="text-decoration:none">Review</a>',
    actionIsText: thin,
  }); }).join('')
  : '<div class="emptyrow"><p class="b ink">Nothing waiting. Every stage you verified has been certified.</p></div>'}
</div></div>`);
  }

  /** v21's certificate document, with the figures read rather than invented. */
  async function certDetail(sess, stageId, d) {
    const x = d.certs.find(r => r.id === stageId);
    if (!x) return null;
    /* The registration is read here rather than carried on the session. It
       decides whether this person may sign at all - Suresh marks work done and
       is not a qualified engineer - so it is read fresh from the row that
       holds it, not from a cookie issued at login. */
    const { shots, me: who } = await asUser(sess, async c => ({
      shots: (await c.query(
        `SELECT caption, taken_at, gps, sha256 FROM evidence
          WHERE unit_stage_id = $1 ORDER BY taken_at`, [stageId])).rows,
      me: (await c.query(
        `SELECT display_name, engineer_qual, engineer_reg FROM users WHERE id = $1`,
        [sess.id])).rows[0] || {},
    }));
    const line = (k, v) => `<p class="cline"><span>${esc(k)}</span><b>${esc(v)}</b></p>`;

    return desk(sess, '/engineer/certs', 'Certificate &middot; Villa ' + x.code, '', `
${UI.head("Engineer's certificate of stage completion",
  `Villa ${esc(x.code)} &middot; ${esc(x.stage_name)}`,
  '', { href: '/engineer/certs', label: 'Back' })}
<div class="mbody anim">
<div class="blk"><div class="certdoc">
${line('Villa', x.code)}
${line('Stage', x.stage_name)}
${line('Marked on site by', x.marked_by)}
${line('Verified on', M.longDate(x.marked_at))}
${line('Location', shots.length ? shots[0].gps : 'no photograph')}
${line('Photographs', shots.length + ' attached, hash locked')}
${line('Certifying engineer', who.display_name + (who.engineer_qual ? ', ' + who.engineer_qual : ''))}
${line('Registration', who.engineer_reg || 'not a registered engineer')}
${line('Amount this releases', M.money(stageTotal(d.byProject, x)))}
</div></div>
<div class="gap"></div>
<div class="blk"><p class="k">The photographs this certificate covers</p></div>
<div class="wl">${shots.map(s => `<div class="wrow">
<span class="id"></span>
<span class="mid"><p class="rt">${esc(s.caption)}</p>
<p class="s">${M.longDate(s.taken_at)} &middot; ${esc(s.gps)} &middot; ${esc(s.sha256.slice(0, 16))}…</p></span>
<span class="stc"><i class="chip ok">hash locked</i></span>
<span class="amt"></span><span class="actc"></span></div>`).join('')}</div>
<div class="gap"></div>
<div class="blk"><p class="b">You certify this stage is complete per the sanctioned plan and that the
photographs are of this villa on the date shown. This goes to the lender.</p></div>
<div class="blk" style="padding-top:14px">
${who.engineer_reg
  ? `<form method="post" action="/engineer/certify">
<input type="hidden" name="id" value="${esc(x.id)}">
<button class="wbtn solid st" type="submit" style="height:46px">Sign with my registration</button></form>
<p class="s" style="margin-top:10px">Applied from your profile. Recorded against your login.</p>`
  : `<p class="b ink">You are not a registered engineer, so you cannot sign this. Mark the work
done on site and a qualified engineer certifies it.</p>`}
</div>
</div>`);
  }

  // -------------------------------------------------------- villa detail

  async function villa(sess, code, mode, d, msg) {
    const u = await asUser(sess, async c => {
      const unit = (await c.query(
        `SELECT u.*, e.display_name engineer FROM units u
           LEFT JOIN users e ON e.id = u.assigned_engineer_id
          WHERE u.code = $1`, [code])).rows[0];
      if (!unit) return null;
      const stages = (await c.query(
        `SELECT s.id, s.status, s.stage_code, t.name, t.description, t.seq, t.pct_bp,
                (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
           FROM unit_stages s
           JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = $2
          WHERE s.unit_id = $1 ORDER BY t.seq`, [unit.id, unit.project_id])).rows;
      const shots = (await c.query(
        `SELECT e.caption, e.taken_at, e.gps, e.sha256, s.stage_code
           FROM evidence e JOIN unit_stages s ON s.id = e.unit_stage_id
          WHERE s.unit_id = $1 ORDER BY e.taken_at DESC LIMIT 8`, [unit.id])).rows;
      const snagRows = (await c.query(
        `SELECT sn.*, w.display_name raiser FROM snags sn JOIN users w ON w.id = sn.raised_by
          WHERE sn.unit_id = $1 ORDER BY sn.status, sn.raised_at`, [unit.id])).rows;
      return { unit, stages, shots, snags: snagRows };
    });
    if (!u) return null;

    const next = u.stages.find(s => s.status === 'pending');
    const live = u.stages.find(s => s.status === 'marked');
    const tab = (k, l) => `<a class="tab" aria-pressed="${mode === k}"
      href="/engineer/villa/${esc(code)}?mode=${k}" style="text-decoration:none">${l}</a>`;
    const priced = M.schedule(u.unit.agreement_value_paise,
      d.byProject.get(u.unit.project_id));

    let body;
    if (mode === 'flag') {
      body = `
<div class="blk"><p class="k">What is the problem</p></div>
<form method="post" action="/engineer/flag">
<input type="hidden" name="code" value="${esc(code)}">
<div class="wl">${FLAGS.map(([t, why], i) => `<label class="wrow" style="cursor:pointer">
<span class="id"><input type="radio" name="reason" value="${esc(t)}" ${i === 0 ? 'checked' : ''}></span>
<span class="mid"><p class="rt">${esc(t)}</p><p class="s">${esc(why)}</p></span>
<span class="stc"></span><span class="amt"></span><span class="actc"></span></label>`).join('')}</div>
<div class="uprow" style="display:flex;gap:10px;align-items:center;padding:14px 26px">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<input class="fi" name="detail" placeholder="Blocks ordered 28 August, vendor now says 12 September."
  required maxlength="200" style="margin:0;flex:1;min-width:0;padding:7px 10px"></span>
<button class="wbtn solid st" type="submit" style="flex:0 0 160px">Report the delay</button></div>
</form>
<div class="blk"><div class="said hot"><p class="b">${esc(u.unit.buyer_name)} is told the stage has
moved and why, the same day. Silence is what generates the phone calls.</p></div></div>`;
    } else if (mode === 'snag') {
      body = `
<div class="blk"><p class="k">Snags</p></div>
<div class="wl">${u.snags.length ? u.snags.map(s => `<div class="wrow">
<span class="id">${s.status === 'fixed' ? '<i class="chip ok">fixed</i>' : chip(days(s.raised_at))}</span>
<span class="mid"><p class="rt">${esc(s.title)}</p>
<p class="s">Raised by ${esc(s.raiser)} &middot; ${M.longDate(s.raised_at)}</p></span>
<span class="stc"></span><span class="amt"></span>
<span class="actc">${s.status === 'open'
  ? `<a class="wbtn st" href="/engineer/snags" style="text-decoration:none">Close it</a>` : ''}</span></div>`).join('')
  : '<div class="emptyrow"><p class="b ink">Nothing raised against this villa.</p></div>'}</div>
<div class="blk" style="padding-top:14px"><p class="b">Snags open at handover. The buyer walks
through, logs what is wrong with photographs, and each item is closed and signed off in the same
record. Defect liability runs twelve months from possession.</p></div>`;
    } else {
      const target = live || next;
      body = `
<div class="blk"><p class="k">Photographs</p></div>
<div class="wl">${u.shots.length ? u.shots.map(s => `<div class="wrow">
<span class="id">${esc(s.stage_code)}</span>
<span class="mid"><p class="rt">${esc(s.caption)}</p>
<p class="s">${M.longDate(s.taken_at)} &middot; ${esc(s.gps)}</p></span>
<span class="stc"><i class="chip ok">stamped</i></span>
<span class="amt n">${esc(s.sha256.slice(0, 10))}…</span><span class="actc"></span></div>`).join('')
  : '<div class="emptyrow"><p class="b ink">No photographs on this villa yet.</p></div>'}</div>
${target ? `<form method="post" action="/evidence/upload" enctype="multipart/form-data" class="uprow"
  style="display:flex;gap:10px;align-items:center;padding:12px 26px 16px">
<input type="hidden" name="stage" value="${esc(target.id)}">
<input type="hidden" name="back" value="/engineer/villa/${esc(code)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<input class="fi" type="file" name="photo" accept="image/jpeg,image/png" required
  style="margin:0;flex:0 0 200px;padding:7px 8px">
<input class="fi" name="caption" placeholder="Caption" required maxlength="120"
  style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi n" name="gps" placeholder="12.8391, 77.7724" required maxlength="40"
  style="margin:0;flex:0 0 150px;padding:7px 10px"></span>
<button class="wbtn st" type="submit" style="flex:0 0 160px">Add photograph</button></form>` : ''}
<div class="blk"><p class="s">Stamped and locked at capture. This is the bank's evidence.</p></div>
<div class="gap"></div>
<div class="blk"><p class="k">Mark complete</p></div>
<div class="wl">${u.stages.filter(s => s.status === 'pending' || s.status === 'marked')
  .slice(0, 2).map(s => {
    const amount = priced[s.seq].totalPaise;
    return `<div class="wrow">
<span class="id">${s.status === 'marked' ? '<i class="chip wait">marked</i>' : ''}</span>
<span class="mid"><p class="rt">${esc(s.name)}</p><p class="s">${esc(s.description || '')}</p></span>
<span class="stc">${s.shots ? `<i class="chip ok">${s.shots} photo${s.shots === 1 ? '' : 's'}</i>`
      : '<i class="chip warn">no photograph</i>'}</span>
<span class="amt n">${M.money(amount)}</span>
<span class="actc">${s.status === 'pending'
      ? (s.shots > 0
        ? `<form method="post" action="/engineer/mark">
<input type="hidden" name="id" value="${esc(s.id)}">
<button class="wbtn solid st" type="submit">Mark done</button></form>`
        : '<span class="s">Photograph it first</span>')
      : `<a class="wbtn st" href="/engineer/cert/${esc(s.id)}" style="text-decoration:none">Certify</a>`}</span>
</div>`; }).join('')}</div>
${live ? `<div class="blk"><div class="said"><p class="b ink">Marking this sends
${M.money(priced[live.seq].totalPaise)} to ${esc(u.unit.buyer_name)}, due in fourteen days${
  u.unit.bank ? `, and the evidence pack to ${esc(u.unit.bank)}` : ''}. You do none of it.</p></div></div>` : ''}`;
    }

    return desk(sess, '/engineer/villas', 'Villa ' + esc(code), '', `
${UI.head(next ? next.name : 'All stages done',
  `${esc(u.unit.buyer_name)} &middot; ${esc(u.unit.bank || 'self funded')} &middot; villa ${esc(code)}`,
  '', { href: '/engineer/villas', label: 'Back' })}
<div class="mbody anim">${flash(msg)}
<div class="tools"><div class="tabs" style="padding:0">
${tab('update', 'Update')}${tab('flag', 'Problem')}${tab('snag', 'Snags')}</div><div class="g"></div></div>
${body}
</div>`);
  }

  return { load, me, villas, visits, snags, log, certs, certDetail, villa, LOG_KINDS, FLAGS, NAV };
};
