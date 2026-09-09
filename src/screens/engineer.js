'use strict';
/* ============================================================================
   THE SITE ENGINEER'S SCREENS.

   Nine: what is on him today, his villas, the visits he must attend, the site
   log, the certificates waiting for his signature, the snags to close, one
   log kind, one villa, and one certificate.

   THE SYSTEM. These were v21's - plint.css plus app.css - and they are now the
   product's one system, from inbell_office_dashboard.html, drawn out of
   src/screens/kit.js exactly as the head office is. Nothing here draws a
   component of its own.

   WHAT THIS FILE MAY NOT DO. It does not price a stage, raise a demand or write
   an audit row. Certification goes through the same `certify()` the route
   handler has always called, which is the only path that touches money, and the
   audit row is written by the trigger on unit_stages rather than by anything
   here.

   Dependencies arrive as a context object rather than by requiring server.js,
   because server.js requires this. Nothing is imported across that line.
   ========================================================================= */

module.exports = function engineerScreens(ctx) {
  const { esc, desk, M, asUser, schedules, stageTotal } = ctx;

  const K = require('./kit')({ esc });
  const {
    head, kpis, pill, btn, table, card, titled, dl, note, empty, photos,
    filters, search, showing, field, input, select, file, form, age, agePill, num, tagOf, AGE,
  } = K;

  /* v21's six kinds of log entry, with the quick entries it offers under each.
     Two taps, which is the point: a site person will not type a paragraph, and
     an empty log six months later is what loses the argument. */
  const LOG_KINDS = {
    material: ['Material received', 'Cement, steel, blocks, fittings',
      ['120 bags cement', '8 tonnes steel', '2000 blocks', 'Fittings, plumbing']],
    labour: ['Labour on site', 'Head count by trade',
      ['18 on site', '12 on site', '24 on site', 'No labour today']],
    weather: ['Weather stoppage', 'Rain or heat, hours lost',
      ['Rain, 2 hours lost', 'Rain, half day lost', 'Heat, work stopped at noon']],
    safety: ['Safety incident', 'Anything, however minor',
      ['Near miss, no injury', 'Minor cut, first aid', 'Toolbox talk held']],
    drawing: ['Drawing revision', 'New sheet from the architect',
      ['New revision received', 'Revision superseded', 'Query raised with architect']],
    rework: ['Rework', 'Work redone and why',
      ['Level reset', 'Line corrected', 'Finish redone']],
  };

  /* v21's four delay reasons on the Problem tab. */
  const FLAGS = [
    ['Material not delivered', 'Blocks work until resolved'],
    ['Labour shortage', 'Stage will slip'],
    ['Design clash on site', 'Needs an architect decision'],
    ['Weather stoppage', 'No work possible'],
  ];

  /* The line a filtered-to-nothing list shows instead of going blank. */
  const noneMatch = (scope, said) =>
    `<div class="empty filtered-empty" hidden>${esc(said)}<div style="margin-top:12px">`
    + `<button class="btn" type="button" data-clear="${scope}">Clear filters</button></div></div>`;

  const days = d => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));

  // ---------------------------------------------------------------- reads

  /** Everything the screens count, in one round trip per request. */
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

      /* SIX OF SEVEN OPEN SNAGS WERE INVISIBLE HERE.

         `u_self` lets a member of staff read staff rows and nobody else's,
         because that table holds password hashes. An inner join against a row
         the policy hides returns nothing at all - so every snag a BUYER
         raised, which is most of them, dropped out of the engineer's list
         while the office's count of the same table said seven. The name comes
         off the villa, which the engineer can read, and the join is outer. */
      const snags = (await c.query(
        `SELECT sn.*, u.code,
                coalesce(w.display_name, u.buyer_name, 'the buyer') raiser
           FROM snags sn JOIN units u ON u.id = sn.unit_id
           LEFT JOIN users w ON w.id = sn.raised_by
          ORDER BY sn.status, sn.raised_at`)).rows;

      const log = (await c.query(
        `SELECT l.*, w.display_name logger FROM site_log l JOIN users w ON w.id = l.logged_by
          ORDER BY l.logged_at DESC LIMIT 40`)).rows;

      return { mine, certs, visits, snags, log, byProject: await schedules(c) };
    });
  }

  const NAV = [['/engineer', 'On you today'], ['/engineer/villas', 'Villas'],
               ['/engineer/visits', 'Visits'], ['/engineer/log', 'Site log'],
               ['/engineer/snags', 'Snags'], ['/engineer/certs', 'Certificates']];

  // ------------------------------------------------------- On you today

  /* The three figures appear ONCE.

     They used to appear twice, sixty pixels apart, in two different
     treatments: a three-column strip inside the header card, and then four
     tiles under it repeating the same numbers. The tiles won, because a tile
     is a link to the screen that holds the work and the strip was not. */
  function me(sess, d, msg) {
    const chased = d.mine.filter(v => v.blocker_role === 'engineer');
    const pending = d.certs.filter(x => x.shots >= 2);
    const open = d.snags.filter(s => s.status === 'open');
    const total = chased.length + pending.length + open.length;

    return desk(sess, '/engineer', 'On you today', '', `
${head('On you today',
  'Nothing here moves without you, and nothing reaches a lender until you sign. '
  + total + ' ' + (total === 1 ? 'thing is' : 'things are') + ' on you.',
  open.length ? btn('Close ' + open.length + ' snag' + (open.length === 1 ? '' : 's'),
    { href: '/engineer/snags', icon: 'cam', dark: true }) : '')}
${kpis([
  { l: 'Office chasing', icon: 'bell', v: String(chased.length), n: 'villas they have flagged',
    href: '/engineer/villas', tone: chased.length ? 'hot' : null },
  { l: 'To certify', icon: 'cert', v: String(pending.length), n: 'ready for your signature',
    href: '/engineer/certs', tone: pending.length ? 'warn' : null },
  { l: 'Snags', icon: 'risk', v: String(open.length), n: 'to photograph and close',
    href: '/engineer/snags', tone: open.length ? 'hot' : null },
  { l: 'Visits', icon: 'cal', v: String(d.visits.length), n: 'buyers coming to site',
    href: '/engineer/visits' },
])}
${chased.length ? titled('Office is chasing you', table(
  ['Villa', 'Stage and why', 'State', 'Last photograph'],
  chased.map(v => [
    `<b>${esc(v.code)}</b>`,
    `<b>${esc(v.next_stage || 'All stages done')}</b><br><span class="hsub">`
      + esc(v.buyer_name) + ' &middot; ' + esc(v.blocker_reason || '') + '</span>',
    pill('over', 'Chased'),
    v.last_shot ? age(days(v.last_shot), false) : pill('over', 'No photograph'),
  ]),
  '.6fr 2.4fr .7fr .9fr',
  { href: i => '/engineer/villa/' + encodeURIComponent(chased[i].code), min: 620 })) : ''}
${titled('Waiting on your signature',
  /* EVERY ONE OF THEM. This list was `pending.slice(0, 8)` under a tile
     reading 33, with nothing saying so. */
  pending.length ? table(
    ['Villa', 'Stage and buyer', 'Photographs', 'Marked', 'Amount', ''],
    pending.map(x => [
      `<b>${esc(x.code)}</b>`,
      `<b>${esc(x.stage_name)}</b><br><span class="hsub">${esc(x.buyer_name)}</span>`,
      pill('accent', x.shots + ' photograph' + (x.shots === 1 ? '' : 's')),
      age(days(x.marked_at), false),
      num(M.money(stageTotal(d.byProject, x))),
      `<a class="btn dark" href="/engineer/cert/${encodeURIComponent(x.id)}">Review</a>`,
    ]),
    '.6fr 1.8fr 1fr .5fr .9fr auto', { min: 760 })
    : empty('Nothing waiting on your signature.',
      { href: '/engineer/villas', label: 'See your villas' }),
  btn('Every certificate', { href: '/engineer/certs', icon: 'cert' }))}
`, msg);
  }

  // -------------------------------------------------------------- Villas

  function villas(sess, d, msg) {
    /* 'Three weeks' and the pill's 'overdue' have to be the same number, or
       the sentence counts villas the rows do not flag. */
    const behind = d.mine.filter(v => !v.last_shot || days(v.last_shot) >= AGE.overdue).length;

    const rows = d.mine.map(v => {
      const since = v.last_shot ? days(v.last_shot) : null;
      return [
        /* The code is the way in. A row carrying a control cannot itself be a
           link - a form inside an anchor is not valid HTML - and on a phone the
           control is behind the table's sideways scroll, so without this the
           register had no reachable way into a villa at 375. */
        `<a href="/engineer/villa/${encodeURIComponent(v.code)}"><b>${esc(v.code)}</b></a>`,
        `<b>${esc(v.next_stage || 'All stages done')}</b><br><span class="hsub">`
          + esc(v.buyer_name) + ' &middot; ' + esc(v.bank || 'self funded') + '</span>',
        agePill(since),
        since === null ? num('none') : age(since, false),
        /* The ACTION column used to be a heading over sixteen empty cells.
           It carries the thing an engineer opens this list to do. */
        `<a class="btn" href="/engineer/villa/${encodeURIComponent(v.code)}">Photograph</a>`,
      ];
    });

    return desk(sess, '/engineer/villas', 'Villas', '', `
${head('Villas to update',
  `${behind} ${behind === 1 ? 'has' : 'have'} gone three weeks without a photograph.`)}
${kpis([
  { l: 'Assigned to you', icon: 'hostel', v: String(d.mine.length), n: 'villas on this engineer' },
  { l: 'Gone quiet', icon: 'bell', v: String(behind), n: 'three weeks with no photograph',
    tone: behind ? 'hot' : null },
  { l: 'Photographed', icon: 'cam', v: String(d.mine.length - behind), n: 'seen within three weeks',
    tone: 'ok' },
])}
${d.mine.length ? search('engvillas', 'Find a villa, a buyer or a lender')
  + filters('engvillas', [['Every stage', '*'],
    ...[...new Set(d.mine.map(v => v.next_stage).filter(Boolean))].map(n => [n, tagOf(n)])])
  + filters('engvillas', [['Every lender', '*'],
    ...[...new Set(d.mine.map(v => v.bank).filter(Boolean))].map(b => [b, tagOf(b)]),
    ['Self funded', 'self']])
  + filters('engvillas', [['All', '*'], ['Gone quiet', 'quiet'], ['Photographed', 'seen']])
  + showing('engvillas', 'villas', d.mine.length) : ''}
${table(['Villa', 'Next stage and buyer', 'Evidence', 'Last seen', 'Action'],
  rows, '.6fr 2.2fr .9fr .6fr auto',
  {
    id: 'engvillas', min: 720,
    tags: i => {
      const v = d.mine[i];
      const since = v.last_shot ? days(v.last_shot) : null;
      return tagOf(v.next_stage) + ' ' + (v.bank ? tagOf(v.bank) : 'self')
        + (since === null || since >= AGE.overdue ? ' quiet' : ' seen');
    },
    empty: 'No villas are assigned to you.',
    noneMatch: 'No villa of yours matches that.',
  })}
`, msg);
  }

  // -------------------------------------------------------------- Visits

  function visits(sess, d, msg) {
    const rows = d.visits.map(v => {
      const mine = v.engineer_id === sess.id;
      const when = M.longDate(v.slot_at) + ', ' +
        /* IST, like every other date this product prints. Without the zone
           this took the server's own - the demo runs in Singapore and this
           machine is in Sydney - and a ten o'clock site visit was shown to
           the engineer as half past two. */
        new Date(v.slot_at).toLocaleTimeString('en-IN',
          { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      return [
        `<b>${esc(v.code)}</b>`,
        `<b>${esc(v.buyer_name)}</b><br><span class="hsub">${esc(when)} &middot; `
          + esc(v.note || 'No note.') + (mine ? '' : ' &middot; named to another engineer') + '</span>',
        v.status === 'confirmed' ? pill('paid', 'Accepted')
          : v.status === 'reassign' ? pill('due', 'Reassign') : pill('accent', 'New'),
        age(days(v.requested_at), v.status === 'confirmed'),
        v.status === 'confirmed'
          ? `<form method="post" action="/engineer/visit"><input type="hidden" name="id" value="${esc(v.id)}">
<input type="hidden" name="do" value="declined">
<button class="btn" type="submit">Cannot make it</button></form>`
          : `<form method="post" action="/engineer/visit" style="display:flex;gap:6px;flex-wrap:wrap">
<input type="hidden" name="id" value="${esc(v.id)}">
<button class="btn dark" type="submit" name="do" value="confirmed">Accept</button>
<button class="btn" type="submit" name="do" value="reassign">Reassign</button></form>`,
      ];
    });

    return desk(sess, '/engineer/visits', 'Visits', '', `
${head('Buyers coming to site',
  'You are named to each. Flags raised while you are there, you answer on the spot.')}
${kpis([
  { l: 'Booked', icon: 'cal', v: String(d.visits.length), n: 'slots on your name' },
  { l: 'Accepted', icon: 'attend', v: String(d.visits.filter(v => v.status === 'confirmed').length),
    n: 'you have confirmed' },
  { l: 'Waiting on you', icon: 'risk', v: String(d.visits.filter(v => v.status === 'requested').length),
    n: 'not yet answered',
    tone: d.visits.filter(v => v.status === 'requested').length ? 'hot' : null },
])}
${titled('Every visit asked for', table(
  ['Villa', 'Buyer and slot', 'State', 'Asked', 'Answer'],
  rows, '.6fr 2.4fr .8fr .5fr auto',
  { min: 780, empty: 'No visits booked. Buyers request a slot from their own screens.' }))}
`, msg);
  }

  // --------------------------------------------------------------- Snags

  function snags(sess, d, msg) {
    const open = d.snags.filter(s => s.status === 'open');
    const done = d.snags.filter(s => s.status === 'fixed');

    const fixForm = s => form('/engineer/snag',
      `<span class="ffile">${file('photo', { id: 'snag-' + s.id, label: 'Photograph of the fix' })}</span>`
      + field('What was done', input('caption', { required: true, max: 120, placeholder: 'Tile replaced and grouted' }))
      + field('Where', input('gps', { required: true, max: 40, placeholder: '12.8391, 77.7724' })),
      { fields: { id: s.id }, upload: true, submit: 'Send for sign-off', icon: 'cam',
        q: 'snag', ql: s.code + ' · ' + s.title });

    return desk(sess, '/engineer/snags', 'Snags', '', `
${head('Snags to close', 'Photograph the fix. The buyer signs it off, not you.')}
${kpis([
  { l: 'Open', icon: 'risk', v: String(open.length), n: 'raised and not yet fixed',
    tone: open.length ? 'hot' : null },
  { l: 'Sent for sign-off', icon: 'attend', v: String(done.length), n: 'photographed, with the buyer' },
])}
${open.length ? open.map(s => titled(s.code + ' · ' + s.title,
  card('', `<p class="hsub">Raised by ${esc(s.raiser)} &middot; ${esc(M.longDate(s.raised_at))}
&middot; open ${days(s.raised_at)} days</p><div style="margin-top:12px">${fixForm(s)}</div>`),
  agePill(days(s.raised_at)))).join('')
  : titled('Open snags', empty('No open snags. Everything raised has been fixed and sent for sign-off.',
    { href: '/engineer/villas', label: 'See your villas' }))}
${done.length ? titled('Fixed, waiting for the buyer', table(
  ['Villa', 'What was wrong', 'Raised by', 'State'],
  done.map(s => [
    `<b>${esc(s.code)}</b>`, `<b>${esc(s.title)}</b>`, esc(s.raiser), pill('paid', 'Sent'),
  ]), '.6fr 2fr 1.2fr .7fr', { min: 560 })) : ''}
`, msg);
  }

  // ----------------------------------------------------------------- Log

  function log(sess, d, kind, msg) {
    if (kind && LOG_KINDS[kind]) {
      const [label, detail, quick] = LOG_KINDS[kind];
      return desk(sess, '/engineer/log', label, '', `
${head(label, esc(detail), btn('Every kind', { href: '/engineer/log', icon: 'back' }))}
${titled('Quick entries', table(
  ['Entry', 'What it records', ''],
  quick.map(q => [
    `<b>${esc(q)}</b>`,
    'One tap. Recorded against you, now.',
    `<form method="post" action="/engineer/log" data-q="log" data-ql="${esc(q)}">
<input type="hidden" name="kind" value="${esc(kind)}">
<input type="hidden" name="title" value="${esc(q)}">
<button class="btn dark" type="submit">Add</button></form>`,
  ]), '1.2fr 2fr auto', { min: 560 }))}
${titled('Or write it', card('', form('/engineer/log',
  field('What happened', input('title', { required: true, max: 120, placeholder: 'Slab pour deferred' }))
  + field('Detail, optional', input('detail', { max: 200, placeholder: '14:00 to 16:00' })),
  { fields: { kind }, submit: 'Add entry', icon: 'plus', q: 'log', ql: label })))}
${/* WHAT WAS ALREADY LOGGED OF THIS KIND. The screen took entries and showed
     none back, so the only way to see whether the cement was already recorded
     this morning was to go back a screen and filter. An entry is added here
     and it appears here. */
  titled('Already logged, ' + label.toLowerCase(), (() => {
    const mine = d.log.filter(e => e.kind === kind);
    return mine.length ? table(
      ['Entry', 'Detail and who', 'When'],
      mine.map(e => [
        `<b>${esc(e.title)}</b>`,
        esc(e.detail || '') + (e.detail ? ' &middot; ' : '') + esc(e.logger),
        age(days(e.logged_at), true),
      ]), '1.4fr 2fr .5fr', { min: 560 })
      : empty('Nothing of this kind logged yet.');
  })())}
`, msg);
    }

    return desk(sess, '/engineer/log', 'Site log', '', `
${head('Site log', 'Two taps. This is what settles a dispute six months later.')}
${kpis([
  /* The query takes forty. Saying "the last forty" over five entries names a
     cap the reader cannot see and makes them wonder what is missing. */
  { l: 'Entries', icon: 'doc', v: String(d.log.length),
    n: d.log.length >= 40 ? 'the last forty on this site' : 'everything logged on this site' },
  { l: 'Today', icon: 'cal', v: String(d.log.filter(e => days(e.logged_at) === 0).length),
    n: 'logged since midnight' },
])}
${titled('What can be logged', `<div class="kpis tiles k3">${
  Object.entries(LOG_KINDS).map(([k, [label, detail]]) =>
    `<a class="kpi" href="/engineer/log/${k}"><div class="kl">${K.ic('doc')} ${esc(label)}</div>`
    + `<div class="kn" style="margin-top:4px;font-size:12px">${esc(detail)}</div></a>`).join('')
}</div>`)}
${d.log.length ? search('englog', 'Find an entry')
  + filters('englog', [['Everything', '*'],
    ...[...new Set(d.log.map(e => e.kind))].map(k => [k, tagOf(k)])])
  + showing('englog', 'entries', d.log.length) : ''}
${titled('Recent', table(
  ['Entry', 'Detail and who', 'Kind', 'When'],
  d.log.map(e => [
    `<b>${esc(e.title)}</b>`,
    esc(e.detail || '') + (e.detail ? ' &middot; ' : '') + esc(e.logger),
    pill('accent', e.kind),
    age(days(e.logged_at), true),
  ]),
  '1.4fr 2fr .8fr .5fr',
  {
    id: 'englog', min: 620, tags: i => tagOf(d.log[i].kind),
    empty: 'Nothing logged yet.', noneMatch: 'No entry of that kind.',
  }))}
`, msg);
  }

  // --------------------------------------------------------------- Certs

  function certs(sess, d, msg) {
    const pend = d.certs;
    const thinOf = x => x.shots < 2;

    const rows = pend.map(x => {
      const thin = thinOf(x);
      return [
        /* As on the villa register: the code is the way in, because the action
           at the end of the row is behind a sideways scroll on a phone. */
        `<a href="${thin ? '/engineer/villa/' + encodeURIComponent(x.code)
          : '/engineer/cert/' + encodeURIComponent(x.id)}"><b>${esc(x.code)}</b></a>`,
        `<b>${esc(x.stage_name)}</b><br><span class="hsub">${esc(x.buyer_name)} &middot; marked by `
          + esc(x.marked_by) + ' on ' + esc(M.longDate(x.marked_at)) + '</span>',
        thin ? pill('due', x.shots === 0 ? 'No photograph yet'
          : 'Only ' + x.shots + ' photo' + (x.shots === 1 ? '' : 's'))
          : pill('accent', 'Ready'),
        age(days(x.marked_at), false),
        num(M.money(stageTotal(d.byProject, x))),
        /* A row that cannot be signed used to say the words "Too few photos"
           and offer nothing - on the one screen where the engineer would go
           and take them. It is a link to the villa's camera now. */
        thin
          ? `<a class="btn" href="/engineer/villa/${encodeURIComponent(x.code)}">Photograph it</a>`
          : `<a class="btn dark" href="/engineer/cert/${encodeURIComponent(x.id)}">Review</a>`,
      ];
    });

    return desk(sess, '/engineer/certs', 'Certificates', '', `
${head('Waiting for your signature', 'Nothing reaches the lender until you sign.')}
${kpis([
  { l: 'Files', icon: 'cert', v: String(pend.length), n: 'stages marked on site',
    tone: pend.length ? 'hot' : null },
  { l: 'Ready to sign', icon: 'attend', v: String(pend.filter(x => !thinOf(x)).length),
    n: 'two photographs or more', tone: 'ok' },
  { l: 'Short of photographs', icon: 'cam', v: String(pend.filter(thinOf).length),
    n: 'go and take them', tone: pend.filter(thinOf).length ? 'warn' : null },
])}
${pend.length ? search('engcerts', 'Find a villa, a buyer or a stage')
  + filters('engcerts', [['All', '*'], ['Ready to sign', 'ready'],
    ['Short of photographs', 'thin']])
  + filters('engcerts', [['Every stage', '*'],
    ...[...new Set(pend.map(x => x.stage_name))].map(n => [n, tagOf(n)])])
  + showing('engcerts', 'waiting for your signature', pend.length) : ''}
${table(['Villa', 'Stage and buyer', 'Evidence', 'Marked', 'Amount', 'Action'],
  rows, '.6fr 2.2fr .9fr .5fr .9fr auto',
  {
    id: 'engcerts', min: 820,
    tags: i => (thinOf(pend[i]) ? 'thin' : 'ready') + ' ' + tagOf(pend[i].stage_name),
    empty: 'Nothing waiting. Every stage you verified has been certified.',
    noneMatch: 'No certificate of yours matches that.',
  })}
`, msg);
  }

  // ----------------------------------------------------------- the certificate

  /** The certificate document, with the figures read rather than invented. */
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

    /* The title is TEXT. It used to be built with a pre-encoded `&middot;` and
       handed to a shell that escapes what it is given, so the app bar and the
       crumb both printed the entity as source: "Certificate &middot; Villa
       A-02". */
    return desk(sess, '/engineer/certs', 'Certificate · Villa ' + x.code, '', `
${head("Engineer's certificate of stage completion",
  `Villa ${esc(x.code)} &middot; ${esc(x.stage_name)}`,
  btn('Every certificate', { href: '/engineer/certs', icon: 'back' }))}
${titled('What you are signing', dl([
  ['Villa', esc(x.code)],
  ['Stage', esc(x.stage_name)],
  ['Marked on site by', esc(x.marked_by)],
  ['Verified on', esc(M.longDate(x.marked_at))],
  ['Location', esc(shots.length ? shots[0].gps : 'no photograph')],
  ['Photographs', shots.length + ' attached, hash locked'],
  ['Certifying engineer', esc(who.display_name + (who.engineer_qual ? ', ' + who.engineer_qual : ''))],
  ['Registration', esc(who.engineer_reg || 'not a registered engineer')],
  ['Amount this releases', esc(M.money(stageTotal(d.byProject, x)))],
]))}
${titled('The photographs this certificate covers',
  photos(shots.map(s => ({
    sha256: s.sha256, caption: s.caption,
    when: M.longDate(s.taken_at), gps: s.gps,
  })), 'No photographs are attached to this stage.')
  + note('Each one is hash locked: the file cannot be changed without the hash '
    + 'changing with it. Tap a photograph to see it full size.'))}
${card('Your signature', `
<p class="hsub">You certify this stage is complete per the sanctioned plan and that the
photographs are of this villa on the date shown. This goes to the lender.</p>
<div style="margin-top:14px">${who.engineer_reg
  ? `<form method="post" action="/engineer/certify">
<input type="hidden" name="id" value="${esc(x.id)}">
<button class="btn dark" type="submit">Sign with my registration</button></form>
<p class="hsub" style="margin-top:10px">Applied from your profile. Recorded against your login.</p>`
  : `<p class="hsub">You are not a registered engineer, so you cannot sign this. Mark the work
done on site and a qualified engineer certifies it.</p>`}</div>`)}
`);
  }

  // -------------------------------------------------------- villa detail

  async function villa(sess, code, mode, d, msg, photoStage) {
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
          WHERE s.unit_id = $1 ORDER BY e.taken_at DESC LIMIT 12`, [unit.id])).rows;
      /* The same outer join as the queue above, and for the same reason. */
      const snagRows = (await c.query(
        `SELECT sn.*, coalesce(w.display_name, u.buyer_name, 'the buyer') raiser
           FROM snags sn JOIN units u ON u.id = sn.unit_id
           LEFT JOIN users w ON w.id = sn.raised_by
          WHERE sn.unit_id = $1 ORDER BY sn.status, sn.raised_at`, [unit.id])).rows;
      return { unit, stages, shots, snags: snagRows };
    });
    if (!u) return null;

    const next = u.stages.find(s => s.status === 'pending');
    const live = u.stages.find(s => s.status === 'marked');
    const priced = M.schedule(u.unit.agreement_value_paise, d.byProject.get(u.unit.project_id));
    const tab = (k, l) => `<a class="chip ${mode === k ? 'on' : ''}"
      href="/engineer/villa/${encodeURIComponent(code)}?mode=${k}">${esc(l)}</a>`;

    let body;
    if (mode === 'flag') {
      body = titled('What is the problem', card('', `
<form method="post" action="/engineer/flag">
<input type="hidden" name="code" value="${esc(code)}">
${FLAGS.map(([t, why], i) => `<label class="dlr" style="cursor:pointer;grid-template-columns:auto 1fr">
<span><input type="radio" name="reason" value="${esc(t)}" ${i === 0 ? 'checked' : ''}></span>
<span><span class="dlv">${esc(t)}</span><br><span class="dlk">${esc(why)}</span></span></label>`).join('')}
<div class="frm" style="margin-top:14px">
<label class="fld wide"><span class="fll">What happened</span>
<input class="fi" name="detail" required maxlength="200"
  placeholder="Blocks ordered 28 August, vendor now says 12 September."></label>
<button class="btn dark" type="submit">Report the delay</button></div>
</form>`))
        + note(esc(u.unit.buyer_name) + ' is told the stage has moved and why, the same day. '
          + 'Silence is what generates the phone calls.');
    } else if (mode === 'snag') {
      body = titled('Snags on this villa', u.snags.length ? table(
        ['What', 'Raised by', 'State', 'Age', ''],
        u.snags.map(s => [
          `<b>${esc(s.title)}</b>`,
          esc(s.raiser) + ' &middot; ' + esc(M.longDate(s.raised_at)),
          s.status === 'fixed' ? pill('paid', 'Fixed') : pill('over', 'Open'),
          age(days(s.raised_at), s.status === 'fixed'),
          s.status === 'open'
            ? `<a class="btn" href="/engineer/snags">Close it</a>` : '',
        ]), '1.6fr 1.4fr .7fr .5fr auto', { min: 680 })
        : empty('Nothing raised against this villa.'))
        + note('Snags open at handover. The buyer walks through, logs what is wrong with '
          + 'photographs, and each item is closed and signed off in the same record. '
          + 'Defect liability runs twelve months from possession.');
    } else {
      const target = live || next;
      const workable = u.stages.filter(s => s.status === 'pending' || s.status === 'marked');
      /* Which stage the camera is pointed at. The stage in hand by default,
         or the one whose own "Photograph it first" sent the reader here. */
      const shootAt = workable.find(s => s.id === photoStage) || target;
      body = `
${titled('Photographs on this villa',
  photos(u.shots.map(s => ({
    sha256: s.sha256, caption: s.caption,
    when: M.longDate(s.taken_at), gps: s.gps,
  })), 'No photographs on this villa yet. The camera is below.'))}
${/* WHICH STAGE THE PHOTOGRAPH IS FILED AGAINST, SAID ON THE FORM.

     It was a hidden field holding the stage in hand, and on every villa on
     this site that is the one already marked and waiting for a certificate.
     So "Photograph it first", sitting under a stage that cannot be marked
     until it has a photograph, led to a camera that filed against a
     DIFFERENT stage - and the stage below stayed unphotographable for as
     long as the one above was uncertified. Every stage still open is in the
     list now, the one in hand is chosen, and each button passes its own. */
  target ? `<span id="addphoto"></span>` + titled('Add a photograph', card('', form('/evidence/upload',
  `<span class="ffile">${file('photo', { id: 'shot-' + code, label: 'Take or attach' })}</span>`
  + field('Against which stage', select('stage', workable.map(st => [st.id,
      /* Short enough that the select does not clip it: the longer form read
         "Blockwork - waiting for you" on a 1440 screen. */
      st.name + (st.status === 'marked' ? ' - to certify' : '')]),
    { value: shootAt.id, required: true }))
  + field('Caption', input('caption', { required: true, max: 120, placeholder: 'Internal partitions, first floor' }))
  + field('Where', input('gps', { required: true, max: 40, placeholder: '12.8391, 77.7724' })),
  { fields: { back: '/engineer/villa/' + code }, upload: true,
    submit: 'Add photograph', icon: 'cam',
    q: 'photo', ql: code + ' · ' + (shootAt.name || '') })
  + `<p class="hsub" style="margin-top:10px">Stamped and locked at capture. This is the bank's evidence.</p>`))
  : ''}
${/* A STAGE TO MARK IS A CARD, NOT A ROW.

     A table scrolls sideways on a phone, which put "Mark done" and "Certify" -
     the two controls this screen exists for - off the right-hand edge at 375.
     A decision gets its own surface; a record stays a table. Every remaining
     stage is here, not the first two of however many. */
  workable.length ? titled('Mark complete', '') + workable.map(st => titled(st.name,
    card('', `<p class="hsub">${esc(st.description || '')} &middot; ${esc(M.money(priced[st.seq].totalPaise))}</p>
<div class="frm" style="margin-top:12px">${st.status === 'pending'
      ? (st.shots > 0
        ? `<form method="post" action="/engineer/mark" data-q="mark"
      data-ql="${esc(code + ' · ' + st.name)}">
<input type="hidden" name="id" value="${esc(st.id)}">
<button class="btn dark" type="submit">Mark done</button></form>`
        : `<a class="btn" href="/engineer/villa/${encodeURIComponent(code)}?photo=${
            encodeURIComponent(st.id)}#addphoto">Photograph it first</a>`)
      : `<a class="btn dark" href="/engineer/cert/${encodeURIComponent(st.id)}">Certify</a>`}
${st.shots ? pill('paid', st.shots + ' photograph' + (st.shots === 1 ? '' : 's'))
      : pill('due', 'No photograph')}</div>`),
    st.status === 'marked' ? pill('due', 'Marked on site') : ''))
    .join('')
  : titled('Mark complete', empty('Every stage on this villa is done.'))}
${live ? note('Marking this sends ' + esc(M.money(priced[live.seq].totalPaise)) + ' to '
  + esc(u.unit.buyer_name) + ', due in fourteen days'
  + (u.unit.bank ? ', and the evidence pack to ' + esc(u.unit.bank) : '') + '. You do none of it.') : ''}`;
    }

    return desk(sess, '/engineer/villas', 'Villa ' + code, '', `
${/* THE VILLA'S NAME LEADS. It used to be the stage's - so a screen offering
     "Certify" on Blockwork was headed "Plastering", and an engineer standing
     on site could not tell at a glance which of sixteen villas he was on. The
     stage is still here, in the line that carries the rest of the facts. */
  head('Villa ' + code,
  `${next ? esc(next.name) : 'All stages done'} &middot; ${esc(u.unit.buyer_name)} `
  + `&middot; ${esc(u.unit.bank || 'self funded')}`,
  btn('Every villa', { href: '/engineer/villas', icon: 'back' }))}
<div class="filters">${tab('update', 'Update')}${tab('flag', 'Problem')}${tab('snag', 'Snags')}</div>
${body}
`, msg);
  }

  return { load, me, villas, visits, snags, log, certs, certDetail, villa, LOG_KINDS, FLAGS, NAV };
};
