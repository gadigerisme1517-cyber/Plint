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
const EV = require('./evidence');
const MP = require('./multipart');
const LOG = require('./log');
const THROTTLE = require('./throttle');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The only files served straight off disk. Path -> [file, content type,
   cache-control]. Nothing here is personal, which is what makes it cacheable
   both by the browser and by the service worker.

   sw.js is served no-cache on purpose: it is how every future change reaches
   an installed app, so it must never be the stale thing. */
const IMMUTABLE = 'public, max-age=604800';

/* The stylesheets are NOT immutable and must not claim to be. Their URLs carry
   no version, so a browser told to hold /plint.css for a week holds whatever
   it had when the deploy landed. `no-cache` means "keep it, but ask before you
   use it" - and the ask costs a 304 against the ETag below, not a download.
   The icons keep the long life: a stale mark for a week is cosmetic, a stale
   stylesheet is a broken screen. */
const REVALIDATE = 'no-cache';
const STATIC = {
  '/plint.css':            ['plint.css', 'text/css; charset=utf-8', REVALIDATE],
  '/app.css':              ['app.css', 'text/css; charset=utf-8', REVALIDATE],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=3600'],
  '/sw.js':                ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/offline':              ['offline.html', 'text/html; charset=utf-8', 'public, max-age=3600'],
  '/icons/icon-192.png':          ['icons/icon-192.png', 'image/png', IMMUTABLE],
  '/icons/icon-512.png':          ['icons/icon-512.png', 'image/png', IMMUTABLE],
  '/icons/icon-maskable-192.png': ['icons/icon-maskable-192.png', 'image/png', IMMUTABLE],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png', IMMUTABLE],
  '/icons/apple-touch-icon.png':  ['icons/apple-touch-icon.png', 'image/png', IMMUTABLE],
  '/icons/favicon.svg':           ['icons/favicon.svg', 'image/svg+xml; charset=utf-8', IMMUTABLE],
};

/* Read and hashed once, at boot. Two things need the hash: an ETag, so the
   `no-cache` above costs a 304 rather than a download; and BUILD. */
const ASSETS = {};
for (const [route, [file, type, cache]] of Object.entries(STATIC)) {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'public', file));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  ASSETS[route] = { bytes, type, cache, etag: '"' + digest + '"', digest };
}

/* One hash over every static file, in a fixed order, computed before sw.js is
   templated so nothing is circular.

   It is the service worker's cache name. Without it the name is a constant,
   and a constant is a bug: the cache is keyed by URL, the URLs carry no
   version, and cache-first never asks the server again - so an app installed
   today would keep today's stylesheet through every future deploy, for ever.
   Change one byte of one asset and the worker gets a new cache to fill and
   deletes the old one on activate. */
const BUILD = crypto.createHash('sha256')
  .update(Object.keys(ASSETS).sort().map(r => r + ' ' + ASSETS[r].digest).join('\n'))
  .digest('hex').slice(0, 12);

{
  const a = ASSETS['/sw.js'];
  const templated = a.bytes.toString('utf8');
  /* Anchored on the declaration, not on the token appearing anywhere: the
     comment above it mentions __BUILD__ too, so a looser check passed happily
     while VERSION had been hardcoded back to a constant. */
  if (!/^const VERSION = 'plint-shell-__BUILD__';$/m.test(templated)) {
    throw new Error("public/sw.js must declare: const VERSION = 'plint-shell-__BUILD__'; " +
                    'without it the shell cache name never changes between deploys');
  }
  a.bytes = Buffer.from(templated.split('__BUILD__').join(BUILD), 'utf8');
  a.etag = '"' + crypto.createHash('sha256').update(a.bytes).digest('hex').slice(0, 16) + '"';
}

/* Registers the service worker, and clears its cache on sign-out.

   The whole script is inert without it: no data is read, nothing is stored,
   and the app works identically in a browser that refuses service workers.
   That is the point - the worker adds installability and an honest offline
   screen, and is not load-bearing for anything else. */
const SW = `<script>
if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      // Swallowing this hid a registration failure once. The app works
      // without a worker, so this must not throw, but it must be findable.
      console.warn('plint: service worker did not register:', e && e.message);
    });
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href="/logout"]');
    if (a && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage('plint:signout');
    }
  });
}
</script>`;

// ------------------------------------------------------------------- chrome

/* v21's mark. Its own logo() takes a `light` flag and paints the mark #FFF,
   and .bm is #FFF too - both of which are invisible on v21's #F6F9FC body.
   The stylesheet is a verbatim extraction and is not mine to edit, so the
   colour is supplied here instead. See DECISIONS.md. */
const LOGO = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-label="Plint">
<path d="M14.2 3h4.6a8.6 8.6 0 0 1 0 17.2h-4.6V29H8.4v-8.4l5.8-5.8V3Z" fill="var(--brand)"/>
<path d="M14.2 8.6V15h4.6a3.2 3.2 0 0 0 0-6.4h-4.6Z" fill="#FFF"/>
<rect x="5.4" y="8.6" width="6.4" height="6.4" rx="1.6" fill="var(--brand)"/></svg>`;

function page(title, sess, body, wide) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Plint</title>
<meta name="theme-color" content="#0A2540">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Plint">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/plint.css">
<link rel="stylesheet" href="/app.css"></head><body><div class="wrap">
<div class="bar"><span class="blogo">${LOGO}</span>
<span class="bm" style="color:var(--ink)">Plint</span>
<span class="sub">NVT Eterna &middot; Phase 1 &middot; 48 villas</span>
${sess ? `<span class="role" aria-pressed="true">${esc(sess.name)}</span>
<a class="role" href="/logout" style="text-decoration:none">Sign out</a>` : ''}</div>
<div class="stagearea"><div class="phone${wide ? ' wide solo' : ''}">
<div class="sysbar"><span>9:41</span><span>Plint</span></div>
<div class="scroll anim">${body}</div></div></div></div>${SW}</body></html>`;
}

/** The office runs in v21's desktop shell, not the phone frame. */
function desk(sess, tab, title, sub, main) {
  /* The sidebar is built from the role, not fixed. An engineer given the
     office nav sees two links that 404 for him, which is a worse answer than
     not offering them. */
  const nav = sess.role === 'office'
    ? [['', [['/office', 'Stuck money']]],
       ['Buyer loans', [['/office/sanctions', 'Sanction not recorded']]]]
    : [['', [['/engineer', 'Sign-off and evidence']]]];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Plint</title>
<meta name="theme-color" content="#0A2540">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Plint">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/plint.css">
<link rel="stylesheet" href="/app.css"></head><body><div class="wrap">
<div class="bar"><span class="blogo">${LOGO}</span>
<span class="bm" style="color:var(--ink)">Plint</span>
<span class="sub">NVT Eterna &middot; Phase 1 &middot; 48 villas</span>
<span class="role" aria-pressed="true">${esc(sess.name)}</span>
<a class="role" href="/logout" style="text-decoration:none">Sign out</a></div>
<div class="desk">
<div class="side">
<div class="logo">${LOGO}<span>Plint</span></div>
${nav.map(([g, items]) => `${g ? `<p class="k grp">${esc(g)}</p>` : ''}
${items.map(([href, label]) => `<a class="sbtn st" href="${href}" aria-selected="${tab === href}"
 style="text-decoration:none;display:block">${esc(label)}</a>`).join('')}`).join('')}
<div class="foot"><p class="s">Eterna Phase 1 &middot; 48 villas<br>Reads from your ERP. Writes nothing back.</p></div>
</div>
<div class="main">
<div class="topbar"><div class="crumb"><span>NVT Eterna</span><b>${esc(title)}</b></div></div>
${main}
</div></div></div>${SW}</body></html>`;
}

// -------------------------------------------------------------------- login
function loginPage(err) {
  return page('Sign in', null, `
<div class="gap l"></div>
<div class="blk"><div class="authcard" style="box-shadow:none;padding:0">
<p class="k">Sign in</p>
<h2 class="authh">NVT Quality Lifestyle</h2>
${err ? `<p class="b hot" style="margin-top:10px">${esc(err)}</p>` : ''}
<form method="post" action="/login">
<label class="fl" for="email">Work email</label>
<input class="fi" id="email" name="email" type="email" placeholder="priya@nvtlifestyle.in" autocomplete="username">
<label class="fl" for="pw">Password</label>
<input class="fi" id="pw" name="pw" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password">
<button class="wbtn solid st authbtn" type="submit">Sign in</button>
</form>
<p class="s authnote">Your role decides what opens. Site engineers get the worklist,
buyers get their villa, the office gets the dashboard.</p>
</div></div>
<div class="gap"></div><div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Seeded logins &middot; password plint</p></div>
<div class="item"><span class="mid"><p class="h2">arjun@example.in</p><p class="s">Buyer, villa B-14</p></span></div>
<div class="item"><span class="mid"><p class="h2">ramachandran@nvt.in</p><p class="s">Certifying engineer</p></span></div>
<div class="item"><span class="mid"><p class="h2">priya@nvt.in</p><p class="s">Head office</p></span></div>
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

  // The whole schedule at once: the last stage carries the rounding residual,
  // so no stage on this screen is priced on its own. `stages` is ordered by
  // t.seq above, which is what makes the residual land on the right one.
  const priced = M.schedule(u.agreement_value_paise, stages.map(s => s.pct_bp));

  // v21 states a stage three ways: done, now, wait. The old markup only had
  // "wait", so a finished stage and the live one looked alike.
  const stageRows = stages.map((s, i) => {
    const amt = priced[i].totalPaise;
    const done = s.status === 'paid';
    const live = s.status === 'demanded' || s.status === 'marked' || s.status === 'certified';
    const pics = ev.filter(e => e.stage_code === s.stage_code);
    return `<div class="stage ${done ? 'done' : live ? 'now' : 'wait'}">
<span class="idx s n">${String(i + 1).padStart(2, '0')}</span>
<span class="body"><span class="row"><h4 class="h2">${esc(s.name)}</h4>
<span class="amt${s.status === 'demanded' ? ' hot' : ''}">${M.money(amt)}</span></span>
<p class="s meta">${esc(s.description)} &middot; ${
  done ? 'Paid' : s.status === 'demanded' ? 'Demanded, due ' + M.longDate(dm.find(d => d.stage_code === s.stage_code).due_at)
  : s.status === 'certified' ? 'Certified, demand being raised'
  : s.status === 'marked' ? 'Marked on site, awaiting the engineer\u2019s certificate'
  : 'Not started'}</p>
${pics.length ? `<span class="strip">${pics.map(p => `<button class="st" title="${esc(p.gps)}">
<span class="cap">${esc(p.caption)} &middot; ${M.longDate(p.taken_at)}</span></button>`).join('')}</span>` : ''}
</span></div>`;
  }).join('');

  const sanctioned = !!u.sanction_recorded_at;

  return page('Villa ' + u.code, sess, `
<div class="top"><div class="g"><p class="s">Villa ${esc(u.code)}</p></div></div>
<div class="gap s"></div>
<div class="lede"><p class="k">Due now</p>
<span class="mega ${open ? 'hot' : ''}">${open ? M.money(payable) : M.money(0)}</span>
<p class="b cap">${open
  ? esc(openStage.name) + ', ' + (openStage.pct_bp / 100) + ' per cent, plus GST. Due '
    + M.longDate(open.due_at) + '. After that date interest runs at twelve per cent a year.'
  : 'Nothing is due. The next demand is raised only when a stage is verified on site.'}</p>
${open ? `<div class="duebar"><span class="ddot"></span><span class="dtx">
<strong>Next payment ${M.money(payable)}</strong> due ${M.longDate(open.due_at)}, on ${esc(openStage.name.toLowerCase())}</span></div>` : ''}
<div class="marks">${marks}</div></div>
<div class="gap"></div>
${open ? `<div class="blk">
<a class="item st" style="text-decoration:none" href="/doc/demand/${esc(open.unit_stage_id)}.pdf">
<span class="mid"><p class="h2">Demand letter ${esc(open.doc_no)}</p><p class="s">PDF</p></span></a>
<a class="item st" style="text-decoration:none" href="/doc/certificate/${esc(open.unit_stage_id)}.pdf">
<span class="mid"><p class="h2">Engineer&rsquo;s completion certificate</p><p class="s">PDF</p></span></a></div>
<div class="gap"></div>` : ''}
<div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Your loan</p></div>
<div class="item"><span class="mid"><p class="h2">${sanctioned ? 'Sanction recorded' : 'Sanction not recorded'}</p>
<p class="s">${sanctioned
  ? esc(u.bank) + ' &middot; ' + M.money(u.sanction_paise) + ' sanctioned, '
    + M.money(u.own_contribution_paise) + ' your own contribution'
  : u.bank
    ? 'Bring your sanction letter to the sales office. Until it is recorded, no stage can release money.'
    : 'Self funded. Nothing to record.'}</p></span></div>
<a class="item st" style="text-decoration:none" href="/documents">
<span class="mid"><p class="h2">What the bank will ask for</p>
<p class="s">The papers to keep ready. A list only.</p></span></a>
<div class="gap"></div><div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Your villa</p></div>
<div class="item"><span class="mid"><p class="h2">Unit</p></span><span class="amt n">${esc(u.unit_type)}</span></div>
<div class="item"><span class="mid"><p class="h2">Agreement value</p></span><span class="amt n">${M.money(u.agreement_value_paise)}</span></div>
<div class="item"><span class="mid"><p class="h2">Paid so far</p></span><span class="amt n">${M.money(led.paidPaise)}</span></div>
<div class="item"><span class="mid"><p class="h2">Demanded, unpaid</p></span><span class="amt n">${M.money(led.demandedPaise)}</span></div>
<div class="item"><span class="mid"><p class="h2">Not yet due</p></span><span class="amt n">${M.money(led.remainingPaise)}</span></div>
<div class="item"><span class="mid"><p class="h2">Lender</p></span><span class="amt n">${esc(u.bank || 'Self funded')}</span></div>
<div class="item"><span class="mid"><p class="h2">Site engineer</p></span><span class="amt n">${esc(u.site_engineer)}</span></div>
<div class="gap"></div><div class="rule"></div><div class="gap s"></div>
<div class="blk"><p class="k">Stage by stage</p></div><div class="gap s"></div>
${stageRows}
<div class="gap l"></div>`, true);
}

/* ---------------------------------------------------------------- documents
   v21's loan model: the builder does not chase papers. This lists what the
   bank will ask for so the buyer can keep them ready, and that is all it does.
   No upload, no ticking, nothing sent. The list is the product. */
const DOC_SETS = {
  salaried: [
    ['PAN card', false], ['Aadhaar', false], ['Address proof', false],
    ['Last 3 salary slips', false], ['Form 16', false], ['6 months bank statement', false],
  ],
  self: [
    ['PAN card', false], ['Aadhaar', false], ['Address proof', false],
    ['Last 3 years ITR', false], ['P&L and balance sheet', true],
    ['GST returns, 12 months', false], ['Business registration proof', false],
    ['12 months bank statement', false],
  ],
};

async function documentsScreen(sess) {
  const u = await asUser(sess, c =>
    c.query('SELECT code, bank, sanction_recorded_at FROM units')).then(r => r.rows[0]);
  if (!u) return null;

  /* Two applicants, one salaried and one self-employed, which is what makes
     v21's total fourteen. Applicant composition is not modelled in this
     schema, so the shape comes from the design and is stated as such. */
  const applicants = [
    { name: 'Main applicant', kind: 'salaried', rel: 'Salaried' },
    { name: 'Co-applicant', kind: 'self', rel: 'Self-employed' },
  ];
  const total = applicants.reduce((n, a) => n + DOC_SETS[a.kind].length, 0);

  return page('Papers', sess, `
<div class="top"><a class="ib st" href="/" style="text-decoration:none">&larr;</a>
<div class="g"><p class="s">Your loan &middot; ${esc(u.bank || 'lender not chosen')}</p></div></div>
<div class="gap s"></div>
<div class="lede"><p class="k">What the bank will ask for</p>
<span class="big" style="font-size:30px;line-height:34px">${total} papers</span>
<p class="b cap">A list, so you can keep them ready. You give these to
${esc(u.bank || 'your bank')} directly. Do not send them here.</p></div>
<div class="gap l"></div>
${applicants.map(a => `
<div class="blk"><div class="apphdr">
<span class="h2">${esc(a.name)}</span>
<span class="s">${esc(a.rel)}</span></div></div>
<div class="gap s"></div>
<div class="doclist2">
${DOC_SETS[a.kind].map(([label, ca]) => `<div class="drow2">
<span class="dchk" style="border-style:dashed"></span>
<span class="dmid"><span class="b ink">${esc(label)}</span>${
  ca ? '<span class="caflag">needs CA sign-off</span>' : ''}</span>
</div>`).join('')}
</div>
<div class="gap"></div>`).join('')}
<div class="blk"><div class="said">
<p class="b ink">${u.sanction_recorded_at
  ? 'Your sanction is recorded. Every stage finished on site now releases your money, and you can watch each release.'
  : 'When your loan is approved, come back to the sales office with the sanction letter. From that point every stage finished on site releases your money automatically.'}</p>
</div></div>
<p class="b note">Plint holds no loan papers and sends nothing to any bank. Your bank runs
its own checks and you sign at the branch yourself.</p>
<div class="gap l"></div>`, true);
}

/**
 * The ordered basis points of every project's schedule, so a stage can be
 * priced inside the schedule it belongs to rather than on its own. A screen
 * that lists stages from many units needs this before it can name a figure.
 */
async function schedules(c) {
  const rows = (await c.query(
    'SELECT project_id, seq, pct_bp FROM stage_templates ORDER BY project_id, seq')).rows;
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
    byProject.get(r.project_id)[r.seq] = r.pct_bp;
  }
  return byProject;
}

/** The total for one stage, priced within its schedule. */
function stageTotal(byProject, row) {
  const bps = byProject.get(row.project_id);
  const priced = M.schedule(row.agreement_value_paise, bps);
  return priced[row.seq].totalPaise;
}

// ------------------------------------------------------------ engineer view
async function engineerScreen(sess, flash) {
  const { rows, byProject } = await asUser(sess, async c => ({
    rows: (await c.query(
      `SELECT s.id, s.status, s.marked_by, s.marked_at, u.code, u.buyer_name, u.bank,
              u.agreement_value_paise, u.project_id, t.name stage_name, t.pct_bp, t.seq,
              (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
         FROM unit_stages s
         JOIN units u ON u.id = s.unit_id
         JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
        WHERE s.status = 'marked'
        ORDER BY s.marked_at`)).rows,
    byProject: await schedules(c),
  }));

  const list = rows.map(x => {
    const total = stageTotal(byProject, x);
    const thin = x.shots < 2;
    return `<div class="wrow">
<span class="id">${esc(x.code)}</span>
<span class="mid"><p class="rt">${esc(x.stage_name)}</p>
<p class="s">${esc(x.buyer_name)} &middot; marked by ${esc(x.marked_by)} on ${M.longDate(x.marked_at)}</p></span>
<span class="stc"><i class="chip ${thin ? 'warn' : 'wait'}">${
  thin ? x.shots + ' photograph' + (x.shots === 1 ? '' : 's') : 'evidence ready'}</i></span>
<span class="amt n">${M.money(total)}</span>
${thin
  ? `<span class="s actc">Too few photographs</span>`
  : `<form method="post" action="/engineer/certify" class="actc">
<input type="hidden" name="id" value="${esc(x.id)}">
<button class="wbtn solid st" type="submit">Certify</button></form>`}
</div>
<form method="post" action="/evidence/upload" enctype="multipart/form-data" class="uprow"
  style="display:flex;gap:10px;align-items:center;padding:10px 26px 16px;border-bottom:1px solid var(--hair)">
<input type="hidden" name="stage" value="${esc(x.id)}">
<span class="mid" style="display:flex;gap:10px;align-items:center">
<input class="fi" type="file" name="photo" accept="image/jpeg,image/png" required
  style="margin:0;flex:0 0 200px;padding:7px 8px">
<input class="fi" name="caption" placeholder="Caption" required maxlength="120"
  style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi n" name="gps" placeholder="12.8391, 77.7724" required maxlength="40"
  style="margin:0;flex:0 0 150px;padding:7px 10px"></span>
<button class="wbtn st" type="submit" style="flex:0 0 140px">Add photograph</button>
</form>`;
  }).join('');

  return desk(sess, '/engineer', 'Sign-off and evidence', '', `
<div class="mhead"><div class="hstrip">
<div class="g"><h1 class="pgt">Sign-off and evidence</h1>
<p class="s" style="margin-top:2px">Stages marked done on site, not yet certified</p></div>
<div class="kpi"><span class="kpin">${rows.length}</span><span class="k">files</span></div>
</div></div>
<div class="mbody anim">
${flash ? `<div class="tools"><span class="rescount s">${flash}</span><div class="g"></div></div>` : ''}
<div class="tools"><span class="rescount s">A stage cannot go to the lender without a certificate
signed by a qualified engineer. A supervisor marking it done on site is not the same thing.</span>
<div class="g"></div></div>
<div class="wl">
${rows.length ? `<div class="whead"><span class="id">Villa</span><span class="mid">Stage and buyer</span>
<span class="stc">Evidence</span><span class="amt">Amount</span><span class="actc">Action</span></div>` : ''}
${list || '<div class="emptyrow"><p class="b ink">Nothing is waiting on you.</p></div>'}
</div>
</div>`);
}

/** Certification. The only place a demand is created. */
async function certify(sess, stageId) {
  return asUser(sess, async c => {
    const s = (await c.query(
      `SELECT s.*, u.id unit_id, u.code, u.agreement_value_paise, u.project_id,
              t.pct_bp, t.name, t.seq
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

    // Priced inside its own schedule, not on its own, so the last stage
    // carries the residual and the ten demands sum to the agreement value.
    const bps = (await schedules(c)).get(s.project_id);
    const price = M.priceStage({
      agreementValuePaise: s.agreement_value_paise,
      scheduleBps: bps,
      index: s.seq,
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

    /* No audit write here. A trigger on unit_stages writes it, from the
       row's own certified_by, certified_at and certificate_hash plus the
       demand figures, deferred to COMMIT so this handler's ordering does not
       matter. There is exactly one writer and it is the database, so a
       certification cannot leave no record however it was performed. */

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
  const { rows, byProject } = await asUser(sess, async c => ({
    rows: await c.query(
      `SELECT u.code, u.buyer_name, u.bank, u.agreement_value_paise, u.project_id,
              t.name stage_name, t.pct_bp, t.seq, s.status,
              b.holder, b.holder_role, b.reason, b.since,
              (CURRENT_DATE - b.since) age
         FROM blockers b
         JOIN unit_stages s ON s.id = b.unit_stage_id
         JOIN units u ON u.id = s.unit_id
         JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
        ORDER BY b.holder_role, (CURRENT_DATE - b.since) DESC`),
    byProject: await schedules(c),
  }));

  const groups = {};
  let stuck = 0;
  for (const x of rows.rows) {
    x.value = stageTotal(byProject, x);
    stuck += x.value;
    (groups[x.holder_role] ||= []).push(x);
  }
  const order = ['engineer', 'lender', 'office', 'buyer'];
  const label = { engineer: 'Waiting on the certifying engineer', lender: 'Waiting on the lender',
                  office: 'Waiting on head office', buyer: 'Waiting on the buyer' };

  const oldest = Math.max(...rows.rows.map(r => r.age));

  /* Red, per v21 and per the standing rule: the stuck-money KPI, the oldest
     ageing bars, and the dot on a late row. `.chip late` and `.days b.h` carry
     the last of those; everything younger is warn or plain. */
  const body = order.filter(k => groups[k]).map(k => {
    const g = groups[k].sort((a, b) => b.age - a.age);
    const sum = g.reduce((n, x) => n + x.value, 0);
    return `<div class="tools"><span class="rescount s">${esc(label[k])} &middot;
${g.length} villa${g.length === 1 ? '' : 's'} &middot; ${M.crore(sum)}</span><div class="g"></div></div>
<div class="wl">
<div class="whead"><span class="id">Villa</span><span class="mid">Stage and reason</span>
<span class="stc">Status</span><span class="days">Age</span><span class="amt">Amount</span></div>
${g.map(x => `<div class="wrow">
<span class="id">${esc(x.code)}</span>
<span class="mid"><p class="rt">${esc(x.stage_name)}</p><p class="s">${esc(x.reason)}</p></span>
<span class="stc"><i class="chip ${x.age >= 21 ? 'late' : x.age >= 10 ? 'warn' : 'wait'}">${
  x.age >= 21 ? 'Overdue' : x.age >= 10 ? 'Ageing' : 'Open'}</i></span>
<span class="days"><b class="${x.age >= 21 ? 'h' : ''}">${x.age}</b>d</span>
<span class="amt n">${M.crore(x.value)}</span></div>`).join('')}
</div><div class="gap"></div>`;
  }).join('');

  // The ageing profile, oldest bucket in red. v21 reds the last buckets only.
  const buckets = [[0, 9], [10, 20], [21, 34], [35, 9999]];
  const counts = buckets.map(([lo, hi]) => rows.rows.filter(r => r.age >= lo && r.age <= hi).length);
  const most = Math.max(1, ...counts);
  const bars = `<div class="agebars">${counts.map((n, i) =>
    `<span class="agebar ${i >= 2 ? 'hot' : ''}" style="height:${n ? Math.max(8, (n / most) * 88) : 2}px"
      title="${['0 to 9 days', '10 to 20 days', '21 to 34 days', '35 days and over'][i]}: ${n}"></span>`).join('')}</div>`;

  return desk(sess, '/office', 'Stuck money', '', `
<div class="mhead"><div class="hstrip">
<div class="g"><h1 class="pgt">Stuck money</h1>
<p class="s" style="margin-top:2px">Across ${rows.rows.length} villas. The oldest has been sitting
for ${oldest} days. Grouped by who is holding it up, not by stage.</p>
${bars}</div>
<div class="kpi"><span class="kpin hot">${M.crore(stuck)}</span><span class="k">stuck</span></div>
<div class="kpi"><span class="kpin">${rows.rows.length}</span><span class="k">files</span></div>
</div></div>
<div class="mbody anim">${body}</div>`);
}

/* --------------------------------------------- head office: record a sanction
   v21's "Sanction not recorded" tab. The builder collects no papers and talks
   to no bank. The buyer arranges the loan himself and brings the letter in;
   this is where it is written down, and nothing is disbursed until it is. */
async function sanctionScreen(sess, flash) {
  /* Days waiting comes from the blocker, which is the same "how long has this
     been sitting" figure the rest of the office already trusts. There is no
     booking date in this schema, so the column is labelled for what it is. */
  const rows = await asUser(sess, c => c.query(
    `SELECT u.id, u.code, u.buyer_name, u.bank, u.agreement_value_paise,
            (SELECT max(CURRENT_DATE - b.since)
               FROM blockers b JOIN unit_stages s2 ON s2.id = b.unit_stage_id
              WHERE s2.unit_id = u.id) age
       FROM units u
      WHERE u.bank IS NOT NULL AND u.sanction_recorded_at IS NULL
      ORDER BY u.code`)).then(r => r.rows);

  const list = rows.map(x => `<div class="wrow">
<span class="id">${esc(x.code)}</span>
<span class="mid"><p class="rt">${esc(x.buyer_name)}</p>
<p class="s">${esc(x.bank)} &middot; agreement ${M.money(x.agreement_value_paise)}</p></span>
<span class="stc"><i class="chip ${x.age > 10 ? 'late' : 'wait'}">no sanction</i></span>
<span class="days"><b class="${x.age > 10 ? 'h' : ''}">${x.age == null ? '—' : x.age}</b>d</span>
<span class="amt n">${M.money(x.agreement_value_paise)}</span>
</div>
<form method="post" action="/office/sanction" class="uprow"
  style="display:flex;gap:10px;align-items:center;padding:10px 26px 16px;border-bottom:1px solid var(--hair)">
<input type="hidden" name="unit" value="${esc(x.id)}">
<input class="fi n" name="sanction" inputmode="numeric" required
  placeholder="Sanctioned amount, in rupees" style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi n" name="own" inputmode="numeric" required
  placeholder="Own contribution, in rupees" style="margin:0;flex:1;min-width:0;padding:7px 10px">
<input class="fi" name="letter" required maxlength="60"
  placeholder="Sanction letter reference" style="margin:0;flex:1;min-width:0;padding:7px 10px">
<button class="wbtn solid st" type="submit" style="flex:0 0 150px">Record sanction</button>
</form>`).join('');

  return desk(sess, '/office/sanctions', 'Sanction not recorded', '', `
<div class="mhead"><div class="hstrip">
<div class="g"><h1 class="pgt">Sanction not recorded</h1>
<p class="s" style="margin-top:2px">Buyers with no sanction letter on file yet. Nothing can be
disbursed against a stage until this is marked.</p></div>
<div class="kpi"><span class="kpin">${rows.length}</span><span class="k">files</span></div>
</div></div>
<div class="mbody anim">
${flash ? `<div class="tools"><span class="rescount s">${esc(flash)}</span><div class="g"></div></div>` : ''}
<div class="tools"><span class="rescount s">${rows.length} buyer${rows.length === 1 ? '' : 's'}
without a recorded sanction</span><div class="g"></div></div>
<div class="wl">
${rows.length ? `<div class="whead"><span class="id">Villa</span><span class="mid">Buyer and lender</span>
<span class="stc">Status</span><span class="days">Waiting</span><span class="amt">Agreement</span></div>` : ''}
${list || '<div class="emptyrow"><p class="b ink">Every buyer with a lender has a sanction on file.</p></div>'}
</div>
<p class="b note">Plint does not collect loan papers and does not talk to any bank. The buyer
arranges his loan himself. When he brings the sanction letter to the office, it is recorded here,
and only then can a verified stage release money against it. Amounts are entered in rupees.</p>
</div>`);
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
    // Thumbnails, not the originals: a certificate carrying four full site
    // photographs is a 40 MB PDF. Read inside the identity that was allowed to
    // see the row. A row without a stored file has no image and prints as a
    // line, exactly as it did before files existed.
    for (const e of ev) {
      if (!e.mime) continue;
      try { e.image = await EV.thumbnail(e.sha256); } catch { e.image = null; }
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

  const send = (code, type, b, extra) =>
    { res.writeHead(code, { 'content-type': type, ...(extra || {}) }); res.end(b); };
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

    /* Static, non-personal files. An explicit map rather than a path join, so
       no request can ever walk out of public/ and no route can be added to
       this list by accident. These are the only things the service worker is
       allowed to cache, and the two lists have to agree. */
    if (ASSETS[p]) {
      const a = ASSETS[p];
      // Cheap revalidation, which is what makes `no-cache` on the stylesheets
      // affordable on a phone.
      if (req.headers['if-none-match'] === a.etag) {
        res.writeHead(304, { etag: a.etag, 'cache-control': a.cache });
        return res.end();
      }
      return send(200, a.type, a.bytes, { 'cache-control': a.cache, etag: a.etag });
    }

    if (p === '/' ) {
      if (!sess) return html(200, loginPage(url.searchParams.get('e')));
      if (sess.role === 'buyer') { res.writeHead(302, { location: '/villa/' + sess.unit }); return res.end(); }
      res.writeHead(302, { location: sess.role === 'engineer' ? '/engineer' : '/office' }); return res.end();
    }

    if (p === '/login' && req.method === 'POST') {
      const f = form(await body(req));
      const email = (f.email || '').trim();

      // Counted before the password is looked at, so a blocked key costs an
      // attacker a round trip and not a scrypt.
      const blocked = await THROTTLE.check(req, email);
      if (blocked) {
        LOG.warn('login.blocked', {
          id: reqId, email, addr: THROTTLE.addressOf(req), until: blocked.until,
        });
        return html(429, loginPage(
          'Too many sign-in attempts. Try again in '
          + blocked.minutes + ' minute' + (blocked.minutes === 1 ? '' : 's') + '.'));
      }

      const u = await login(email, f.pw || '');
      if (!u) {
        LOG.warn('login.failed', { id: reqId, email, addr: THROTTLE.addressOf(req) });
        return html(200, loginPage('That email and password do not match.'));
      }
      // It worked, so the counters go back to zero: only failures accumulate.
      await THROTTLE.clear(req, email);

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

    if (p === '/office/sanctions' && sess.role === 'office')
      return html(200, await sanctionScreen(sess, url.searchParams.get('m')));

    if (p === '/office/sanction' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/office/sanctions?m=' + encodeURIComponent(m) }); res.end(); };

      // Entered in rupees at the desk, stored in paise like everything else.
      const paise = v => {
        const n = Number(String(v || '').replace(/[,\s₹]/g, ''));
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
      };
      const sanction = paise(f.sanction), own = paise(f.own);
      const letter = (f.letter || '').trim().slice(0, 60);
      if (sanction === null || own === null || !letter || !f.unit) {
        return back('A sanctioned amount, an own contribution and a letter reference are all required.');
      }
      try {
        const ok = await asUser(sess, c => c.query(
          'SELECT record_sanction($1,$2,$3,$4) ok', [f.unit, sanction, own, letter]))
          .then(r => r.rows[0].ok);
        return back(ok
          ? 'Sanction recorded. Stage disbursements are now live for this buyer.'
          : 'That villa already has a sanction on file, or is not a villa.');
      } catch (e) {
        LOG.warn('sanction.refused', { id: reqId, unit: f.unit, err: e.message });
        return back('That sanction could not be recorded.');
      }
    }

    if (p === '/documents' && sess.role === 'buyer') {
      const out = await documentsScreen(sess);
      return out ? html(200, out) : html(404, page('Not found', sess,
        '<div class="gap l"></div><div class="blk"><h1 class="h1">Not found.</h1></div>'));
    }

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

/* Listening is a function so the deploy entrypoint can migrate first and then
   start the same server, rather than reimplementing this block. */
function start() {
  const port = config.port();
  server.listen(port, () => LOG.info('listening', { port }));

  // A crash that is not caught is still a crash, but it is a logged one.
  process.on('unhandledRejection', e => LOG.error('unhandledRejection', e));
  process.on('uncaughtException', e => { LOG.error('uncaughtException', e); process.exit(1); });
  return server;
}

if (require.main === module) start();

module.exports = server;
module.exports.start = start;
module.exports.BUILD = BUILD;   // the shell hash, so a test can prove it moves
