'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { asUser, login, pool } = require('./db');
const M = require('./money');
const PDF = require('./pdf');

const S = require('./session');
const config = require('./config');
const AUDIT = require('./audit');
const EV = require('./evidence');
const MP = require('./multipart');
const LOG = require('./log');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ------------------------------------------------------------------- chrome
function page(title, sess, body, wide) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Plint</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/plint.css"></head><body><div class="wrap">
<div class="bar"><span class="bm">Plint</span>
<span class="sub">NVT Eterna &middot; Phase 1 &middot; 48 villas</span>
${sess ? `<span class="role" aria-pressed="true">${esc(sess.name)}</span>
<a class="role" href="/logout" style="text-decoration:none">Sign out</a>` : ''}</div>
<div class="stagearea"><div class="phone${wide ? ' wide' : ''}">
<div class="sysbar"><span>9:41</span><span>Plint</span></div>
<div class="scroll anim">${body}</div></div></div></div></body></html>`;
}

// -------------------------------------------------------------------- login
function loginPage(err) {
  return page('Sign in', null, `
<div class="gap l"></div>
<div class="lede"><p class="k">Sign in</p>
<h1 class="big">Work done on site,<br>money moved at the bank.</h1>
<p class="b cap">Three roles. One chain of evidence.</p></div>
<div class="gap"></div>
${err ? `<div class="blk"><p class="b hot">${esc(err)}</p></div><div class="gap s"></div>` : ''}
<form method="post" action="/login">
<div class="blk"><input class="line" name="email" placeholder="Email"
  style="width:100%;border:1px solid var(--hair);border-radius:8px;padding:13px 14px;font:400 14px Inter"></div>
<div class="gap s"></div>
<div class="blk"><input class="line" name="pw" type="password" placeholder="Password"
  style="width:100%;border:1px solid var(--hair);border-radius:8px;padding:13px 14px;font:400 14px Inter"></div>
<div class="gap s"></div>
<div class="blk"><button class="act st" style="width:100%;height:46px;background:var(--brand);color:#fff;border:0;border-radius:8px;font:500 14px Inter;cursor:pointer">Sign in</button></div>
</form>
<div class="gap"></div><div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Seeded logins &middot; password plint</p></div>
<div class="line"><span class="b">arjun@example.in</span><b>Buyer, villa B-14</b></div>
<div class="line"><span class="b">ramachandran@nvt.in</span><b>Certifying engineer</b></div>
<div class="line"><span class="b">priya@nvt.in</span><b>Head office</b></div>
<div class="gap l"></div>`);
}

// --------------------------------------------------------------- buyer view
async function buyerScreen(sess, code) {
  const data = await asUser(sess, async c => {
    const u = (await c.query('SELECT * FROM units WHERE code=$1', [code])).rows[0];
    if (!u) return null;
    const stages = (await c.query(
      `SELECT s.*, t.name, t.pct_bp, t.description, t.seq
         FROM unit_stages s JOIN stage_templates t
           ON t.code = s.stage_code AND t.project_id = $2
        WHERE s.unit_id = $1 ORDER BY t.seq`, [u.id, u.project_id])).rows;
    const dm = (await c.query(
      `SELECT d.*, s.stage_code FROM demands d JOIN unit_stages s ON s.id = d.unit_stage_id
        WHERE s.unit_id = $1 ORDER BY d.raised_at`, [u.id])).rows;
    const ev = (await c.query(
      `SELECT e.*, s.stage_code FROM evidence e JOIN unit_stages s ON s.id = e.unit_stage_id
        WHERE s.unit_id = $1 ORDER BY e.taken_at DESC`, [u.id])).rows;
    return { u, stages, dm, ev };
  });
  if (!data) return null;
  const { u, stages, dm, ev } = data;

  const led = M.ledger({ agreementValuePaise: u.agreement_value_paise, stages });
  const open = dm.filter(d => !d.paid_at).slice(-1)[0];
  const openStage = open && stages.find(s => s.stage_code === open.stage_code);
  const payable = open ? M.payableNow(open) : 0;

  const marks = stages.map(s =>
    `<i class="${s.status === 'paid' ? 'on' : s.status === 'demanded' ? 'due' : ''}"></i>`).join('');

  const stageRows = stages.map((s, i) => {
    const base = M.stageBase(u.agreement_value_paise, s.pct_bp);
    const amt = base + M.gstOn(base);
    const done = s.status === 'paid';
    const live = s.status === 'demanded' || s.status === 'marked' || s.status === 'certified';
    const pics = ev.filter(e => e.stage_code === s.stage_code);
    return `<div class="stage${done || live ? '' : ' wait'}">
<span class="idx s n">${String(i + 1).padStart(2, '0')}</span>
<div class="body"><div class="row"><h4 class="h2">${esc(s.name)}</h4>
<span class="amt${live ? ' hot' : ''}">${M.money(amt)}</span></div>
<p class="s meta">${esc(s.description)} &middot; ${
  done ? 'Paid' : s.status === 'demanded' ? 'Demanded, due ' + M.longDate(dm.find(d => d.stage_code === s.stage_code).due_at)
  : s.status === 'certified' ? 'Certified, demand being raised'
  : s.status === 'marked' ? 'Marked on site, awaiting the engineer\u2019s certificate'
  : 'Not started'}</p>
${pics.length ? `<div class="strip">${pics.map(p => `<button class="st" title="${esc(p.gps)}">
<span class="cap">${esc(p.caption)} &middot; ${M.longDate(p.taken_at)}</span></button>`).join('')}</div>` : ''}
</div></div>`;
  }).join('');

  return page('Villa ' + u.code, sess, `
<div class="top"><div class="g"><p class="s">Villa ${esc(u.code)}</p></div></div>
<div class="lede"><p class="k">Due now</p>
<span class="mega ${open ? 'hot' : ''}">${open ? M.money(payable) : M.money(0)}</span>
<p class="b cap">${open
  ? esc(openStage.name) + ', ' + (openStage.pct_bp / 100) + ' per cent, plus GST. Due '
    + M.longDate(open.due_at) + '. After that date interest runs at twelve per cent a year.'
  : 'Nothing is due. The next demand is raised only when a stage is verified on site.'}</p>
<div class="marks">${marks}</div></div>
<div class="gap"></div>
${open ? `<div class="blk"><a class="act line st" style="text-decoration:none;color:var(--ink)"
  href="/doc/demand/${esc(open.unit_stage_id)}.pdf">Demand letter ${esc(open.doc_no)} &middot; PDF</a>
<a class="act line st" style="text-decoration:none;color:var(--ink)"
  href="/doc/certificate/${esc(open.unit_stage_id)}.pdf">Engineer&rsquo;s completion certificate &middot; PDF</a></div>
<div class="gap"></div>` : ''}
<div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Your villa</p></div>
<div class="line"><span class="b">Unit</span><b>${esc(u.unit_type)}</b></div>
<div class="line"><span class="b">Agreement value</span><b>${M.money(u.agreement_value_paise)}</b></div>
<div class="line"><span class="b">Paid so far</span><b>${M.money(led.paidPaise)}</b></div>
<div class="line"><span class="b">Demanded, unpaid</span><b>${M.money(led.demandedPaise)}</b></div>
<div class="line"><span class="b">Not yet due</span><b>${M.money(led.remainingPaise)}</b></div>
<div class="line"><span class="b">Lender</span><b>${esc(u.bank || 'Self funded')}</b></div>
<div class="line"><span class="b">Site engineer</span><b>${esc(u.site_engineer)}</b></div>
<div class="gap"></div><div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Payment schedule</p></div>
${stageRows}
<div class="gap l"></div>`);
}

// ------------------------------------------------------------ engineer view
async function engineerScreen(sess, flash) {
  const rows = await asUser(sess, c => c.query(
    `SELECT s.id, s.status, s.marked_by, s.marked_at, u.code, u.buyer_name, u.bank,
            u.agreement_value_paise, t.name stage_name, t.pct_bp,
            (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
       FROM unit_stages s
       JOIN units u ON u.id = s.unit_id
       JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
      WHERE s.status = 'marked'
      ORDER BY s.marked_at`));

  const list = rows.rows.map(x => {
    const base = M.stageBase(x.agreement_value_paise, x.pct_bp);
    const thin = x.shots < 2;
    return `<div class="wrow" style="display:flex;gap:20px;align-items:center;padding:18px 26px;border-bottom:1px solid var(--hair-2)">
<div style="flex:1;min-width:0"><h4 class="h2">${esc(x.code)} &middot; ${esc(x.stage_name)}</h4>
<p class="s">${esc(x.buyer_name)} &middot; marked by ${esc(x.marked_by)} on ${M.longDate(x.marked_at)}
 &middot; ${x.shots} photograph${x.shots === 1 ? '' : 's'}</p></div>
<span class="amt n" style="color:var(--ink-2)">${M.money(base + M.gstOn(base))}</span>
${thin
  ? `<span class="s hot" style="flex:0 0 130px;text-align:right">Too few photographs</span>`
  : `<form method="post" action="/engineer/certify" style="flex:0 0 130px;text-align:right">
<input type="hidden" name="id" value="${esc(x.id)}">
<button class="wbtn st" style="background:var(--brand);color:#fff;border:0;border-radius:7px;padding:10px 14px;font:500 12.5px Inter;cursor:pointer">Certify</button></form>`}
</div>
<form method="post" action="/evidence/upload" enctype="multipart/form-data"
  style="display:flex;gap:10px;align-items:center;padding:10px 26px 16px;border-bottom:1px solid var(--hair-2)">
<input type="hidden" name="stage" value="${esc(x.id)}">
<input class="s" type="file" name="photo" accept="image/jpeg,image/png" required
  style="flex:0 0 210px;font:400 12px Inter;color:var(--ink-2)">
<input class="s" name="caption" placeholder="Caption" required maxlength="120"
  style="flex:1;min-width:0;border:1px solid var(--hair);border-radius:7px;padding:8px 10px;font:400 12.5px Inter">
<input class="s n" name="gps" placeholder="12.8391, 77.7724" required maxlength="40"
  style="flex:0 0 150px;border:1px solid var(--hair);border-radius:7px;padding:8px 10px;font:400 12.5px Inter">
<button class="wbtn st" style="flex:0 0 130px;background:#fff;color:var(--ink);border:1px solid var(--hair);border-radius:7px;padding:9px 14px;font:500 12.5px Inter;cursor:pointer">Add photograph</button>
</form>`;
  }).join('');

  return page('Certify', sess, `
<div class="top"><div class="g"><p class="s">${esc(sess.name)} &middot; certifying engineer</p></div></div>
<div class="lede"><p class="k">Stages awaiting your certificate</p>
<span class="mega">${rows.rows.length}</span>
<p class="b cap">A stage cannot go to the lender without a certificate signed by a qualified engineer.
A supervisor marking it done on site is not the same thing.</p></div>
<div class="gap"></div>
${flash ? `<div class="blk"><p class="b ink">${flash}</p></div><div class="gap s"></div>` : ''}
${list || '<div class="blk"><p class="b">Nothing is waiting on you.</p></div>'}
<div class="gap l"></div>`, true);
}

/** Certification. The only place a demand is created. */
async function certify(sess, stageId) {
  return asUser(sess, async c => {
    const s = (await c.query(
      `SELECT s.*, u.id unit_id, u.code, u.agreement_value_paise, u.project_id, t.pct_bp, t.name
         FROM unit_stages s JOIN units u ON u.id = s.unit_id
         JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
        WHERE s.id = $1`, [stageId])).rows[0];
    if (!s || s.status !== 'marked') return null;
    const shots = (await c.query('SELECT count(*)::int n FROM evidence WHERE unit_stage_id=$1', [stageId])).rows[0].n;
    if (shots < 2) return null;

    const hash = crypto.createHash('sha256')
      .update([s.id, sess.id, shots, new Date().toISOString()].join('|')).digest('hex');
    await c.query(
      `UPDATE unit_stages SET status='demanded', certified_by=$2, certified_at=now(), certificate_hash=$3
        WHERE id=$1`, [stageId, sess.id, hash]);

    const price = M.priceStage({
      agreementValuePaise: s.agreement_value_paise,
      pctBp: s.pct_bp,
      raisedAt: new Date(),
    });
    const seq = (await c.query(
      `SELECT count(*)::int n FROM demands d JOIN unit_stages t ON t.id=d.unit_stage_id
        WHERE t.unit_id=$1`, [s.unit_id])).rows[0].n + 1;
    const demandId = 'dm-' + s.code + '-' + s.stage_code;
    const docNo = 'PL/' + s.code.replace('-', '') + '/' + String(seq).padStart(2, '0');
    await c.query(
      `INSERT INTO demands VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)`,
      [demandId, stageId, docNo,
       price.raisedAt, price.dueAt, price.basePaise, price.gstPaise, price.extrasPaise, price.totalPaise]);

    // One row for the act, inside the same transaction. Certification is the
    // only place a demand is created, so the demand's figures are recorded
    // here, as at the moment the engineer signed for them.
    await AUDIT.write(c, sess, {
      action: 'certified',
      targetKind: 'unit_stage',
      targetId: stageId,
      figures: {
        unit: s.code, stage: s.stage_code, stage_name: s.name,
        pct_bp: s.pct_bp, agreement_value_paise: Number(s.agreement_value_paise),
        demand_id: demandId, doc_no: docNo,
        base_paise: price.basePaise, gst_paise: price.gstPaise,
        extras_paise: price.extrasPaise, total_paise: price.totalPaise,
        raised_at: price.raisedAt, due_at: price.dueAt,
        photographs: shots, certificate_hash: hash,
      },
    });
    const bank = (await c.query('SELECT bank FROM units WHERE id=$1', [s.unit_id])).rows[0].bank;

    // The evidence pack, recorded rather than asserted. Nothing sends it yet,
    // so the row is queued and the copy says queued. A villa with no lender
    // has nowhere to send one, which is a state and not a failure.
    await c.query(
      `INSERT INTO pack_deliveries (id, unit_stage_id, lender, state)
       VALUES ($1,$2,$3,$4) ON CONFLICT (unit_stage_id) DO NOTHING`,
      ['pk-' + s.code + '-' + s.stage_code, stageId, bank,
       bank ? 'queued' : 'not_applicable']);

    await c.query(`UPDATE blockers SET holder=$2, holder_role=$3, reason=$4
       WHERE unit_stage_id=$1`,
      [stageId,
       bank || 'Priya Menon',
       bank ? 'lender' : 'office',
       bank ? 'Certified. Evidence pack queued for ' + bank + '.'
            : 'No lender on file. Pack cannot be sent.']);

    return { code: s.code, stage: s.name, total: price.totalPaise, stageId, bank };
  });
}

// --------------------------------------------------------- head office view
async function officeScreen(sess) {
  const rows = await asUser(sess, c => c.query(
    `SELECT u.code, u.buyer_name, u.bank, u.agreement_value_paise,
            t.name stage_name, t.pct_bp, s.status,
            b.holder, b.holder_role, b.reason, b.since,
            (CURRENT_DATE - b.since) age
       FROM blockers b
       JOIN unit_stages s ON s.id = b.unit_stage_id
       JOIN units u ON u.id = s.unit_id
       JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
      ORDER BY b.holder_role, (CURRENT_DATE - b.since) DESC`));

  const groups = {};
  let stuck = 0;
  for (const x of rows.rows) {
    const base = M.stageBase(x.agreement_value_paise, x.pct_bp);
    x.value = base + M.gstOn(base);
    stuck += x.value;
    (groups[x.holder_role] ||= []).push(x);
  }
  const order = ['engineer', 'lender', 'office', 'buyer'];
  const label = { engineer: 'Waiting on the certifying engineer', lender: 'Waiting on the lender',
                  office: 'Waiting on head office', buyer: 'Waiting on the buyer' };

  const oldest = Math.max(...rows.rows.map(r => r.age));
  const body = order.filter(k => groups[k]).map(k => {
    const g = groups[k].sort((a, b) => b.age - a.age);
    const sum = g.reduce((n, x) => n + x.value, 0);
    return `<div class="gap"></div><div class="blk"><p class="k">${label[k]}</p>
<h3 class="h1">${g.length} villa${g.length === 1 ? '' : 's'} &middot; ${M.crore(sum)}</h3></div>
<div class="gap s"></div>
${g.map(x => `<div class="wrow" style="display:flex;gap:18px;align-items:center;padding:15px 26px;border-bottom:1px solid var(--hair-2)">
<span style="flex:0 0 8px;height:8px;border-radius:50%;background:${x.age >= 21 ? 'var(--hot)' : x.age >= 10 ? 'var(--warn)' : 'var(--hair)'}"></span>
<div style="flex:1;min-width:0"><h4 class="h2">${esc(x.code)} &middot; ${esc(x.stage_name)}</h4>
<p class="s">${esc(x.reason)}</p></div>
<span class="s n" style="flex:0 0 90px;text-align:right">${x.age} days</span>
<span class="amt n" style="flex:0 0 110px;text-align:right">${M.crore(x.value)}</span></div>`).join('')}`;
  }).join('');

  return page('Worklist', sess, `
<div class="top"><div class="g"><p class="s">${esc(sess.name)} &middot; head office</p></div></div>
<div class="lede"><p class="k">Stuck money</p>
<span class="mega hot">${M.crore(stuck)}</span>
<p class="b cap">Across ${rows.rows.length} villas. The oldest has been sitting for ${oldest} days.
Grouped by who is holding it up, not by stage.</p></div>
${body}<div class="gap l"></div>`, true);
}

// ------------------------------------------------------------------ documents
async function docContext(sess, stageId) {
  return asUser(sess, async c => {
    const s = (await c.query(
      `SELECT s.*, u.code, u.unit_type, u.bank, u.buyer_name, u.agreement_value_paise,
              u.project_id, t.name, t.pct_bp, t.description
         FROM unit_stages s JOIN units u ON u.id = s.unit_id
         JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
        WHERE s.id = $1`, [stageId])).rows[0];
    if (!s) return null;
    const d = (await c.query('SELECT * FROM demands WHERE unit_stage_id=$1', [stageId])).rows[0];
    const ev = (await c.query('SELECT * FROM evidence WHERE unit_stage_id=$1 ORDER BY taken_at', [stageId])).rows;
    // Read the bytes here, inside the identity that was allowed to see the row.
    // A row without a stored file simply has no image and prints as a line.
    for (const e of ev) {
      if (!e.mime) continue;
      try { e.image = EV.readSync(e.sha256); } catch { e.image = null; }
    }
    const eng = s.certified_by
      ? (await c.query('SELECT * FROM users WHERE id=$1', [s.certified_by])).rows[0]
      : null;
    const p = (await c.query('SELECT * FROM projects WHERE id=$1', [s.project_id])).rows[0];
    return {
      unit: s, stageRow: s, demand: d, evidence: ev, project: p, buyer: s.buyer_name,
      stage: { name: s.name, pct_bp: s.pct_bp, description: s.description },
      engineer: eng || { display_name: 'Not certified' },
    };
  });
}

// --------------------------------------------------------------------- http
function body(req) {
  return new Promise(res => { let b = ''; req.on('data', d => b += d); req.on('end', () => res(b)); });
}
const form = b => Object.fromEntries(new URLSearchParams(b));
// Sessions live in the database. Nothing about authentication is held in
// this process, so a restart signs nobody out.
const sessionOf = req => S.lookup(S.tokenFrom(req));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const start = Date.now();
  const reqId = crypto.randomBytes(8).toString('hex');
  let sess = null;

  const send = (code, type, b) => { res.writeHead(code, { 'content-type': type }); res.end(b); };
  const html = (code, b) => send(code, 'text/html; charset=utf-8', b);
  res.on('finish', () => LOG.request(req, res, { start, sess, id: reqId }));

  try {
    // Liveness and readiness in one: it is only healthy if the database
    // answers, because without one this process can do nothing at all.
    if (p === '/health') {
      try {
        const r = await pool.query('SELECT 1 ok');
        return send(200, 'application/json',
          JSON.stringify({ status: 'ok', database: r.rows.length === 1 ? 'up' : 'odd' }));
      } catch (e) {
        LOG.error('health.database', e, { id: reqId });
        return send(503, 'application/json',
          JSON.stringify({ status: 'unavailable', database: 'down' }));
      }
    }

    sess = await sessionOf(req);

    if (p === '/plint.css') return send(200, 'text/css', fs.readFileSync(path.join(__dirname, '../public/plint.css')));

    if (p === '/' ) {
      if (!sess) return html(200, loginPage(url.searchParams.get('e')));
      if (sess.role === 'buyer') { res.writeHead(302, { location: '/villa/' + sess.unit }); return res.end(); }
      res.writeHead(302, { location: sess.role === 'engineer' ? '/engineer' : '/office' }); return res.end();
    }

    if (p === '/login' && req.method === 'POST') {
      const f = form(await body(req));
      const u = await login((f.email || '').trim(), f.pw || '');
      if (!u) return html(200, loginPage('That email and password do not match.'));
      if (u.role === 'buyer') {
        u.unit = (await asUser(u, c => c.query('SELECT code FROM units'))).rows[0].code;
      }
      const token = await S.open(u);
      res.writeHead(302, { location: '/', 'set-cookie': S.setCookie(token) });
      return res.end();
    }

    if (p === '/logout') {
      // Revoked in the database, not merely forgotten by the browser.
      await S.revoke(S.tokenFrom(req));
      res.writeHead(302, { location: '/', 'set-cookie': S.clearCookie() });
      return res.end();
    }

    if (!sess) { res.writeHead(302, { location: '/' }); return res.end(); }

    if (p.startsWith('/villa/')) {
      const out = await buyerScreen(sess, decodeURIComponent(p.slice(7)));
      // RLS returned nothing: the villa is not this buyer's. Same answer as
      // a villa that does not exist. No existence leak.
      return out ? html(200, out) : html(404, page('Not found', sess,
        '<div class="gap l"></div><div class="blk"><h1 class="h1">No such villa.</h1></div>'));
    }

    if (p === '/engineer' && sess.role === 'engineer')
      return html(200, await engineerScreen(sess, url.searchParams.get('m')));

    if (p === '/engineer/certify' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const r = await certify(sess, f.id);
      const msg = r
        ? `${r.code} ${r.stage.toLowerCase()} certified. Demand for ${M.money(r.total)} raised. `
          + (r.bank ? `The evidence pack is queued for ${r.bank}.`
                    : 'No lender is on file, so there is no pack to send.')
        : 'That stage could not be certified.';
      res.writeHead(302, { location: '/engineer?m=' + encodeURIComponent(msg) });
      return res.end();
    }

    if (p === '/office' && sess.role === 'office') return html(200, await officeScreen(sess));

    // Evidence photographs. Authorised by row-level security and nothing else:
    // the row is fetched as the asking session, and the disk is touched only if
    // one came back. A buyer guessing a neighbour's hash gets the same 404 as a
    // hash that was never issued.
    const img = /^\/evidence\/([0-9a-f]{64})$/.exec(p);
    if (img) {
      const row = await asUser(sess, c => c.query(
        'SELECT sha256, mime FROM evidence WHERE sha256 = $1 LIMIT 1', [img[1]]))
        .then(r => r.rows[0]);
      if (!row || !row.mime) return html(404, page('Not found', sess,
        '<div class="gap l"></div><div class="blk"><h1 class="h1">No such photograph.</h1></div>'));
      let bytes;
      try { bytes = await EV.read(row.sha256); }
      catch { return html(404, page('Not found', sess,
        '<div class="gap l"></div><div class="blk"><h1 class="h1">No such photograph.</h1></div>')); }
      res.writeHead(200, {
        'content-type': row.mime,
        'content-length': bytes.length,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      return res.end(bytes);
    }

    if (p === '/evidence/upload' && req.method === 'POST') {
      if (sess.role !== 'engineer' && sess.role !== 'office') {
        return html(404, page('Not found', sess,
          '<div class="gap l"></div><div class="blk"><h1 class="h1">Not found.</h1></div>'));
      }
      const back = m => { res.writeHead(302, { location: '/engineer?m=' + encodeURIComponent(m) }); res.end(); };
      let parsed;
      try {
        const raw = await MP.read(req, EV.MAX_BYTES + 4096);
        parsed = MP.parse(raw, req.headers['content-type']);
      } catch (e) {
        return back(e.code === 'TOO_LARGE'
          ? 'That photograph is larger than the ' + Math.round(EV.MAX_BYTES / 1048576) + ' MB limit.'
          : 'That upload could not be read.');
      }
      const file = parsed.files.photo;
      const stage = (parsed.fields.stage || '').trim();
      const caption = (parsed.fields.caption || '').trim().slice(0, 120);
      const gps = (parsed.fields.gps || '').trim().slice(0, 40);
      if (!file || !stage || !caption || !gps) return back('A photograph, a caption and a GPS reading are all required.');

      let stored;
      try { stored = await EV.store(file.data); }
      catch (e) {
        return back(e.code === 'BAD_TYPE' ? 'Only JPEG and PNG photographs are accepted.'
                  : e.code === 'TOO_LARGE' ? 'That photograph is larger than the ' + Math.round(EV.MAX_BYTES / 1048576) + ' MB limit.'
                  : 'That photograph could not be stored.');
      }

      try {
        await asUser(sess, async c => {
          // The row id is derived from the stage and the content hash, so the
          // same photograph filed twice against one stage collides rather than
          // duplicating.
          const id = 'ev-' + crypto.createHash('sha256')
            .update(stage + '|' + stored.sha256).digest('hex').slice(0, 24);
          await c.query(
            `INSERT INTO evidence (id, unit_stage_id, caption, taken_at, gps, sha256,
                                   mime, byte_size, uploaded_by, uploaded_at)
             VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,now())
             ON CONFLICT (id) DO NOTHING`,
            [id, stage, caption, gps, stored.sha256, stored.mime, stored.byteSize, sess.id]);
        });
      } catch (e) {
        return back('That stage would not accept the photograph.');
      }
      return back('Photograph filed against ' + stage + '.');
    }

    const doc = /^\/doc\/(demand|certificate)\/(.+)\.pdf$/.exec(p);
    if (doc) {
      const ctx = await docContext(sess, decodeURIComponent(doc[2]));
      if (!ctx) return html(404, page('Not found', sess, '<div class="blk"><h1 class="h1">No such document.</h1></div>'));
      if (doc[1] === 'demand' && !ctx.demand)
        return html(404, page('Not found', sess, '<div class="blk"><h1 class="h1">No demand raised yet.</h1></div>'));
      res.writeHead(200, { 'content-type': 'application/pdf' });
      const stream = doc[1] === 'demand' ? PDF.demandLetter(ctx) : PDF.completionCertificate(ctx);
      return stream.pipe(res);
    }

    html(404, page('Not found', sess, '<div class="gap l"></div><div class="blk"><h1 class="h1">Not found.</h1></div>'));
  } catch (e) {
    // The stack goes to the log, with the request id. The browser gets the id
    // and nothing else: no message, no class name, no query, no stack. A user
    // can quote the id and an operator can find the line.
    LOG.error('request.failed', e, {
      id: reqId, method: req.method, path: p,
      actor: sess ? sess.id : null, role: sess ? sess.role : null,
    });
    if (res.headersSent) return res.destroy();
    html(500, page('Error', null,
      '<div class="gap l"></div><div class="blk"><h1 class="h1">Something failed.</h1>'
      + '<p class="b cap">Nothing was changed. Quote reference '
      + esc(reqId) + ' if you report this.</p></div>'));
  }
});

if (require.main === module) {
  const port = config.port();
  server.listen(port, () => LOG.info('listening', { port, url: 'http://localhost:' + port }));

  // A crash that is not caught is still a crash, but it is a logged one.
  process.on('unhandledRejection', e => LOG.error('unhandledRejection', e));
  process.on('uncaughtException', e => { LOG.error('uncaughtException', e); process.exit(1); });
}
module.exports = server;
