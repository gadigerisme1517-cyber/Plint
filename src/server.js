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
  const templated = ASSETS['/sw.js'].bytes.toString('utf8');
  /* Anchored on the declaration, not on the token appearing anywhere: the
     comment above it mentions __BUILD__ too, so a looser check passed happily
     while VERSION had been hardcoded back to a constant. */
  if (!/^const VERSION = 'plint-shell-__BUILD__';$/m.test(templated)) {
    throw new Error("public/sw.js must declare: const VERSION = 'plint-shell-__BUILD__'; " +
                    'without it the shell cache name never changes between deploys');
  }
  // Every text asset may carry the placeholder, not just the worker.
  for (const a of Object.values(ASSETS)) {
    if (/^(text|application)\//.test(a.type) === false) continue;
    const s = a.bytes.toString('utf8');
    if (!s.includes('__BUILD__')) continue;
    a.bytes = Buffer.from(s.split('__BUILD__').join(BUILD), 'utf8');
    a.etag = '"' + crypto.createHash('sha256').update(a.bytes).digest('hex').slice(0, 16) + '"';
  }
}

/* The stylesheets are also served at a URL that contains the build hash, and
   that is the URL every page links.

   `no-cache` plus an ETag keeps a browser honest from here on, but it cannot
   reach a browser that already holds a copy: for about an hour these files
   went out as `public, max-age=604800` with no version in the URL, and a
   browser told that is right to keep them for a week and never ask again. That
   is not hypothetical - it stranded a browser on the deployed URL, which then
   rendered the new markup with the old stylesheet.
   A content-addressed URL is the only fix that reaches everyone, because the
   page asks for a different file rather than asking about the same one. */
const CSS = { plint: '/plint.' + BUILD + '.css', app: '/app.' + BUILD + '.css' };
for (const [name, url] of Object.entries(CSS)) {
  ASSETS[url] = { ...ASSETS['/' + name + '.css'], cache: IMMUTABLE };
}

/* If-None-Match is a WEAK comparison and a list, not a string equality.
   RFC 9110 s8.8.3.2: `W/"x"` and `"x"` are the same validator here.

   This was `===`, which is right on localhost and wrong everywhere the app is
   actually deployed. The proxy in front of Render compresses text and rewrites
   the ETag to its weak form, so the browser sends back `W/"ff82..."`, the
   comparison failed, and every page load re-downloaded 45KB of stylesheet that
   the browser already had. `no-cache` on the stylesheets makes that
   revalidation happen on every single navigation, so the cost was paid every
   time. Measured against the live URL: 200 with the full body for the ETag the
   server itself had just issued. */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = t => t.trim().replace(/^W\//, '');
  return header.split(',').some(t => t.trim() === '*' || bare(t) === bare(etag));
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

/* Two of these decide what an installed app looks like before a line of the
   page is drawn.

   `theme-color` paints the installed window's title bar, and the app bar sits
   directly under it. At #0A2540 that was a near-black strip above a white bar
   with a hard seam between them, across the top of every window - the one part
   of an installed app that is meant to disappear. It was reported from a
   desktop install. The colour is `--paper` now, the same as `.appbar`, and a
   test reads both sides and fails if they drift apart again.

   `apple-mobile-web-app-status-bar-style` is `default` rather than
   `black-translucent` for the same reason from the other end: translucent
   draws the page under the status bar and paints its text white, which on a
   white app bar is white on white. */
const HEAD = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Plint</title>
<meta name="theme-color" content="#FFFFFF">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Plint">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${CSS.plint}">
<link rel="stylesheet" href="${CSS.app}"></head><body>`;

/* Where each role can actually go. One list, rendered three ways: the sidebar
   on a desktop office screen, links in the app bar for the buyer, and the
   bottom tab bar on a phone. Built from the role, because an engineer offered
   the office's destinations gets two links that 404 for him. */
function destinations(sess) {
  if (!sess) return [];
  /* v21's five for the buyer: Journey, Villa, Visit, Money, More. Bank pick,
     Documents, Agreement, Loan, Choices and Questions all sit behind More,
     because five is what the bar holds and eleven is not a bar. */
  if (sess.role === 'buyer') {
    return [['/journey', 'Journey', 'path'],
            ['/villa/' + sess.unit, 'Villa', 'home'],
            ['/visit', 'Visit', 'cal'],
            ['/money', 'Money', 'money'],
            ['/more', 'More', 'more']];
  }
  /* Fifteen, in v21's nine groups. The list is flat here because this is what
     the app bar and the route table need; the groups live in the office module
     with the screens they head, and the sidebar and the phone menu are both
     drawn from that one structure. Fifteen is above `BAR_FITS`, which is what
     gives this role a menu button where the other two keep v21's bar. */
  if (sess.role === 'office') {
    return OFF.GROUPS.flatMap(([, items]) =>
      items.map(([k, label]) => [OFF.href(k), label, 'doc']));
  }
  /* v21's five-slot bottom bar, and five fits: Me, Villas, Visits, Log, Certs.
     A menu button is for the head office, whose fifteen destinations cannot be
     a bar at any width. */
  return [['/engineer', 'Me', 'home'], ['/engineer/villas', 'Villas', 'home'],
          ['/engineer/visits', 'Visits', 'doc'], ['/engineer/log', 'Log', 'doc'],
          ['/engineer/certs', 'Certs', 'tick']];
}

/* v21's bottom bar is `.nav five`: a shape that holds five and no more. The
   buyer and the engineer have exactly five. Above it a role gets a menu button
   instead, which is the head office and its fifteen. */
const BAR_FITS = 5;

const TABICON = {
  home:  'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z',
  doc:   'M6 3h8l4 4v14H6Zm8 0v4h4',
  money: 'M7 5h10M7 9h10M15 5c0 4-3 5-6 5l7 9',
  tick:  'M4.5 12.5 9 17l10.5-11',
  // The buyer's three: a route through the stages, a date, and everything else.
  path:  'M4 19h5a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h5m0 0-3-3m3 3-3 3',
  cal:   'M4 7h16v13H4zM4 11h16M8 4v4M16 4v4',
  more:  'M6 12h.01M12 12h.01M18 12h.01',
};
const tabIcon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TABICON[n]}"/></svg>`;

/* The application's own top bar. It replaces v21's `.bar`, which was the
   prototype's chrome around a phone mock - a logo, a caption and a role
   switcher sitting outside the product. This one is inside it: who you are
   signed in as, and the way out. */
function appbar(sess, current, inlineNav, screen) {
  const dests = destinations(sess);
  return `<header class="appbar">
<a class="ab-brand" href="/"><span class="ab-mark">${LOGO}</span><span class="ab-name">Plint</span></a>
<span class="ab-ctx">NVT Eterna &middot; Phase 1</span>
${screen ? `<span class="ab-screen">${esc(screen)}</span>` : ''}
${inlineNav && dests.length > 1 ? `<nav class="ab-nav">${dests.map(([href, label]) =>
  `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>` : ''}
<div class="ab-g"></div>
${dests.length > BAR_FITS ? `<a class="ab-menu" href="#menu"
 aria-label="Open the menu" style="text-decoration:none">Menu</a>` : ''}
${sess ? `<span class="ab-who">${esc(sess.name)}</span>
<a class="ab-out" href="/logout">Sign out</a>` : ''}
</header>`;
}

/* The bottom tab bar, phones only, and only when there is more than one place
   to go. See DECISIONS.md for why every dashboard here gets tabs rather than a
   menu button: none of them has more than two sections. */
function tabbar(sess, current) {
  const dests = destinations(sess);
  /* One destination is not navigation, and above five it is not a bar. v21's
     `.nav five` is a shape that holds five; the head office's fifteen become a
     menu button in the app bar instead, and squeezing fifteen tabs into 375px
     would give each of them 25 pixels. */
  if (dests.length < 2 || dests.length > BAR_FITS) return '';
  return `<nav class="tabbar" style="--tabs:${dests.length}">
${dests.map(([href, label, icon]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>
${tabIcon(icon)}<span>${esc(label)}</span></a>`).join('')}
</nav>`;
}

/* The first path segment of everything the buyer's shell serves. A set rather
   than a chain of `p === ...` so that one lookup decides whether to spend a
   round trip on `BUY.load`, and so that adding a screen without adding it here
   is a 404 rather than a page that quietly renders with no navigation. */
const BUYER_GET = new Set([
  'journey', 'villa', 'visit', 'money', 'more',
  'bank', 'loan', 'agreement', 'choices', 'questions', 'stage', 'documents',
]);

function page(title, sess, body, wide, current) {
  return `${HEAD}${appbar(sess, current, true, title)}<div class="wrap">
<div class="stagearea"><div class="phone${wide ? ' wide solo' : ''}">
<div class="scroll anim">${body}</div></div></div></div>
${tabbar(sess, current)}${SW}</body></html>`;
}

/** Office and engineer: a sidebar on a desktop, the same destinations as tabs on a phone. */
/**
 * The shell all three roles share.
 *
 * `sidebar` is an optional pre-rendered list of destinations. Two roles have a
 * flat five and get the default; the head office has fifteen under nine
 * headings, and a flat list of fifteen is not navigation - the headings are
 * what make it one. So that role hands in its own, drawn from the same
 * structure its phone menu is drawn from.
 */
function desk(sess, tab, title, sub, main, sidebar, drawer) {
  const dests = destinations(sess);
  return `${HEAD}${appbar(sess, tab, false, title)}<div class="wrap">
<div class="desk">
<div class="side">
<div class="logo">${LOGO}<span>Plint</span></div>
${sidebar || dests.map(([href, label]) => `<a class="sbtn st" href="${href}" aria-selected="${tab === href}"
 style="text-decoration:none;display:block">${esc(label)}</a>`).join('')}
<div class="foot"><p class="s">Eterna Phase 1 &middot; 48 villas<br>Reads from your ERP. Writes nothing back.</p></div>
</div>
<div class="main">
<div class="topbar"><div class="crumb"><span>NVT Eterna</span><b>${esc(title)}</b></div></div>
${main}
</div></div></div>
${tabbar(sess, tab)}${drawer || ''}${SW}</body></html>`;
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
<div class="gap l"></div>`, true, '/villa/' + u.code);
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

/* ---------------------------------------------------------- the engineer

   Five tabs and a villa detail, in src/screens/engineer.js. It is handed the
   helpers it needs rather than requiring this file back, because this file
   requires it. certify() below stays here: it is the only path that prices a
   stage and raises a demand, which is not a screen concern. */
const ROW = require('./screens/rows')({ esc });
const ENG = require('./screens/engineer')({ esc, desk, M, asUser, schedules, stageTotal, LOGO });
const BUY = require('./screens/buyer')({ esc, desk, M, asUser });
const OFF = require('./screens/office')({ esc, desk, M, asUser, schedules, stageTotal });

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
  /* Every page in this application is server-rendered behind a session cookie
     and is one person's financial position. It was going out with no
     `cache-control` at all, which does not mean "do not store" - with no
     directive, no `expires` and no `last-modified` a browser may apply its own
     heuristic and reuse the response without ever asking again.

     Chrome on Android does. The symptom reached us as a screenshot of a layout
     this stylesheet cannot produce at any width: a phone showing the bottom
     tab bar and the breadcrumb together, which stopped being possible several
     deploys ago. The page had come from the phone's own HTTP cache, and it
     named a stylesheet hash that is served `max-age=604800` - correct for a
     content-addressed file, and unreachable once the page pointing at it is
     stale too. Deploying could not fix it because the device never asked.

     `no-store` rather than `no-cache`: this is somebody's money, on a phone
     that gets handed around a site office, and there is no reason for any of
     it to be written to disk. */
  const html = (code, b) =>
    send(code, 'text/html; charset=utf-8', b, { 'cache-control': 'no-store' });
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
      if (etagMatches(req.headers['if-none-match'], a.etag)) {
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

    /* ------------------------------------------------------------ the buyer

       Five tabs and the six screens behind More, in src/screens/buyer.js. One
       read serves whichever tab was asked for, the same way the engineer's
       does: the tabs all count from the same handful of rows. */
    if (sess.role === 'buyer' && req.method === 'GET' && BUYER_GET.has(p.split('/')[1])) {
      const msg = url.searchParams.get('m');
      const d = await BUY.load(sess);
      if (!d) return html(404, page('Not found', sess,
        '<div class="blk"><h1 class="h1">No such villa.</h1></div>'));

      if (p === '/journey')   return html(200, BUY.journey(sess, d, msg));
      if (p === '/visit')     return html(200, BUY.visit(sess, d, msg));
      if (p === '/money')     return html(200, BUY.money(sess, d, msg));
      if (p === '/more')      return html(200, BUY.more(sess, d, msg));
      if (p === '/bank')      return html(200, BUY.bank(sess, d, msg));
      if (p === '/loan')      return html(200, BUY.loan(sess, d, msg));
      if (p === '/agreement') return html(200, BUY.agreement(sess, d, msg));
      if (p === '/choices')   return html(200, BUY.choices(sess, d, msg));
      if (p === '/questions') return html(200, BUY.questions(sess, d, null, msg));
      if (p === '/documents') return html(200, BUY.documents(sess, d, msg));

      if (p.startsWith('/questions/')) {
        const id = decodeURIComponent(p.slice(11));
        d.thread = await BUY.threadOf(sess, id);
        const out = BUY.questions(sess, d, id, msg);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">No such question.</h1></div>'));
      }
      if (p.startsWith('/stage/')) {
        const out = BUY.stage(sess, d, decodeURIComponent(p.slice(7)), msg);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">No such stage.</h1></div>'));
      }
      /* The code in the URL has to be this buyer's own. Rendering their villa
         for any `/villa/*` would answer 200 to a probe for a neighbour's -
         no data crosses, because `load()` reads the session's unit and never
         the path, but a 200 says the villa exists and a 404 says nothing. The
         answer for another villa and for one that was never built is the same
         answer. */
      if (p.startsWith('/villa/')) {
        return decodeURIComponent(p.slice(7)) === sess.unit
          ? html(200, BUY.villa(sess, d, msg))
          : html(404, page('Not found', sess,
              '<div class="blk"><h1 class="h1">No such villa.</h1></div>'));
      }
    }

    if (p.startsWith('/villa/')) {
      const out = await buyerScreen(sess, decodeURIComponent(p.slice(7)));
      // RLS returned nothing: the villa is not this buyer's. Same answer as
      // a villa that does not exist. No existence leak.
      return out ? html(200, out) : html(404, page('Not found', sess,
        '<div class="gap l"></div><div class="blk"><h1 class="h1">No such villa.</h1></div>'));
    }

    // ------------------------------------------------------ the engineer
    if (p.startsWith('/engineer') && sess.role === 'engineer' && req.method === 'GET') {
      const msg = url.searchParams.get('m');
      // One read for every tab: they all count from the same five queries.
      const d = await ENG.load(sess);

      if (p === '/engineer')         return html(200, ENG.me(sess, d, msg));
      if (p === '/engineer/villas')  return html(200, ENG.villas(sess, d, msg));
      if (p === '/engineer/visits')  return html(200, ENG.visits(sess, d, msg));
      if (p === '/engineer/snags')   return html(200, ENG.snags(sess, d, msg));
      if (p === '/engineer/certs')   return html(200, ENG.certs(sess, d, msg));
      if (p === '/engineer/log')     return html(200, ENG.log(sess, d, null, msg));

      if (p.startsWith('/engineer/log/')) {
        return html(200, ENG.log(sess, d, decodeURIComponent(p.slice(14)), msg));
      }
      if (p.startsWith('/engineer/cert/')) {
        const out = await ENG.certDetail(sess, decodeURIComponent(p.slice(15)), d);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">That stage is not waiting for a certificate.</h1></div>'));
      }
      if (p.startsWith('/engineer/villa/')) {
        const out = await ENG.villa(sess, decodeURIComponent(p.slice(16)),
          url.searchParams.get('mode') || 'update', d, msg);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">No such villa.</h1></div>'));
      }
    }

    if (p === '/engineer/certify' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const r = await certify(sess, f.id);
      const msg = r
        ? `${r.code} ${r.stage.toLowerCase()} certified. Demand for ${M.money(r.total)} raised. `
          + (r.bank ? `The evidence pack is queued for ${r.bank}.`
                    : 'No lender is on file, so there is no pack to send.')
        : 'That stage could not be certified.';
      res.writeHead(302, { location: '/engineer/certs?m=' + encodeURIComponent(msg) });
      return res.end();
    }

    /* ------------------------------------------------- the engineer writes

       Every one of these is the point of the whole exercise: an act on site
       that another role sees. Marking a stage moves it onto the office's
       sign-off list and off the engineer's; answering a visit is read by the
       buyer who booked it; closing a snag needs the photograph of the fix. */
    if (p === '/engineer/mark' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/engineer/villas?m=' + encodeURIComponent(m) }); res.end(); };
      const r = await asUser(sess, async c => {
        /* A stage cannot be marked without evidence. The rule lives here and
           not only in the markup, because a form is not a constraint. */
        const s = (await c.query(
          `SELECT s.id, s.status, u.code, t.name,
                  (SELECT count(*)::int FROM evidence e WHERE e.unit_stage_id = s.id) shots
             FROM unit_stages s JOIN units u ON u.id = s.unit_id
             JOIN stage_templates t ON t.code = s.stage_code AND t.project_id = u.project_id
            WHERE s.id = $1`, [f.id])).rows[0];
        if (!s || s.status !== 'pending') return null;
        if (s.shots < 1) return { refused: s };
        await c.query(
          `UPDATE unit_stages SET status = 'marked', marked_by = $2, marked_at = now()
            WHERE id = $1 AND status = 'pending'`, [f.id, sess.name]);
        return { s };
      });
      if (!r) return back('That stage could not be marked.');
      if (r.refused) return back(r.refused.code + ' ' + r.refused.name.toLowerCase()
        + ' needs a photograph before it can be marked done.');
      return back(r.s.code + ' ' + r.s.name.toLowerCase()
        + ' marked done on site. It is now waiting for a certificate.');
    }

    if (p === '/engineer/visit' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const want = ['confirmed', 'declined', 'reassign'].includes(f.do) ? f.do : null;
      const r = want && await asUser(sess, async c => (await c.query(
        `UPDATE visits SET status = $2, responded_at = now(), response_note = $3
          WHERE id = $1 AND status <> 'done'
          RETURNING (SELECT code FROM units WHERE id = unit_id) code`,
        [f.id, want, want === 'reassign' ? 'Engineer asked for this to be reassigned.' : null]
      )).rows[0]);
      const said = { confirmed: 'accepted', declined: 'declined', reassign: 'sent back to the office to reassign' };
      res.writeHead(302, { location: '/engineer/visits?m=' + encodeURIComponent(
        r ? `Visit to ${r.code} ${said[want]}. ${want === 'confirmed'
          ? 'The buyer can see it is confirmed.' : 'The office picks it up from here.'}`
          : 'That visit could not be answered.') });
      return res.end();
    }

    if (p === '/engineer/log' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const kind = Object.keys(ENG.LOG_KINDS).includes(f.kind) ? f.kind : null;
      const title = (f.title || '').trim().slice(0, 120);
      const ok = kind && title && await asUser(sess, async c => {
        const project = (await c.query(`SELECT project_id FROM units LIMIT 1`)).rows[0];
        if (!project) return false;
        await c.query(
          `INSERT INTO site_log (id, project_id, kind, title, detail, logged_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ['log-' + crypto.randomUUID(), project.project_id, kind, title,
           (f.detail || '').trim().slice(0, 200), sess.id]);
        return true;
      });
      res.writeHead(302, { location: '/engineer/log?m=' + encodeURIComponent(
        ok ? 'Logged: ' + title : 'That entry could not be logged.') });
      return res.end();
    }

    if (p === '/engineer/flag' && req.method === 'POST' && sess.role === 'engineer') {
      const f = form(await body(req));
      const reason = (f.reason || '').trim().slice(0, 60);
      const detail = (f.detail || '').trim().slice(0, 200);
      const r = reason && detail && await asUser(sess, async c => {
        const s = (await c.query(
          `SELECT s.id, u.id unit_id, u.code, u.buyer_name, u.project_id
             FROM unit_stages s JOIN units u ON u.id = s.unit_id
            WHERE u.code = $1 AND s.status IN ('pending','marked')
            ORDER BY s.stage_code LIMIT 1`, [f.code])).rows[0];
        if (!s) return null;
        /* The blocker is what the office's worklist reads, so a problem
           reported on site is on their screen without anyone being told. */
        await c.query(
          `INSERT INTO blockers (unit_stage_id, holder, holder_role, reason, since)
           VALUES ($1,$2,'engineer',$3,current_date)
           ON CONFLICT (unit_stage_id) DO UPDATE SET holder = $2, reason = $3, since = current_date`,
          [s.id, sess.name, reason + ': ' + detail]);
        await c.query(
          `INSERT INTO notifications (id, project_id, for_role, unit_id, severity, title, detail)
           VALUES ($1,$2,'office',$3,'warn',$4,$5)`,
          ['nt-' + crypto.randomUUID(), s.project_id, s.unit_id,
           s.code + ': ' + reason, detail + ' — reported by ' + sess.name]);
        return s;
      });
      res.writeHead(302, { location: r
        ? '/engineer/villa/' + encodeURIComponent(f.code) + '?mode=flag&m='
          + encodeURIComponent('Reported. ' + r.buyer_name + ' and the office both see it.')
        : '/engineer/villas?m=' + encodeURIComponent('That problem could not be reported.') });
      return res.end();
    }

    /* -------------------------------------------------------- the head office

       Fifteen destinations in nine groups, in src/screens/office.js, plus the
       buyer file every row on every one of them links to. `/office` is Today;
       the rest are `/office/<key>`. One read serves the sidebar's fifteen
       counts and the rows the asked-for screen needs - the counts are on every
       page in the role, so they are one query rather than fifteen. */
    if (sess.role === 'office' && req.method === 'GET' && p.startsWith('/office')) {
      const msg = url.searchParams.get('m');
      const key = p === '/office' ? 'today'
        : p.startsWith('/office/') ? p.slice(8) : null;

      if (key && OFF.KEYS.has(key)) {
        const d = await OFF.load(sess, key);
        return html(200, OFF.SCREENS[key](sess, d, msg));
      }

      /* The menu is a layer over whatever you were looking at rather than a
         screen of its own, so there is nothing here to render. The link stays
         valid - somebody's bookmark, an old notification - and lands on Today
         with the drawer open. */
      if (p === '/office/menu') {
        res.writeHead(302, { location: '/office#menu' });
        return res.end();
      }

      if (p.startsWith('/office/buyer/')) {
        const n = await asUser(sess, c => OFF.counts(c));
        const out = await OFF.buyerFile(sess, decodeURIComponent(p.slice(14)), n);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">No such villa.</h1></div>'));
      }

      if (p.startsWith('/office/question/')) {
        const n = await asUser(sess, c => OFF.counts(c));
        const out = await OFF.questionThread(sess, decodeURIComponent(p.slice(17)), n, msg);
        return out ? html(200, out) : html(404, page('Not found', sess,
          '<div class="blk"><h1 class="h1">No such question.</h1></div>'));
      }
    }

    /* --------------------------------------------------- the head office writes

       None of these touches money. Picking a file up, answering a lender,
       answering a buyer, closing a claim and marking a quarter filed are all
       the same kind of row: a record that somebody in this office dealt with
       something, with their name on it. The two that do touch money -
       recording a sanction and reassigning work - go through SECURITY DEFINER
       functions, further down, because `units` has no UPDATE policy at all. */

    if (p === '/office/handoff' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/office/handoff?m=' + encodeURIComponent(m) }); res.end(); };
      const r = await asUser(sess, async c => (await c.query(
        `UPDATE handoffs SET picked_up_at = now(), picked_up_by = $2
          WHERE id = $1 AND picked_up_at IS NULL
          RETURNING (SELECT code FROM units WHERE id = unit_id) code`,
        [f.id, sess.id])).rows[0]);
      return back(r
        ? r.code + ' is yours. It is off the sales handover list and on your own.'
        : 'That file could not be picked up. Somebody may already have it.');
    }

    if (p === '/office/query' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/office/query?m=' + encodeURIComponent(m) }); res.end(); };
      const answer = (f.answer || '').trim().slice(0, 300);
      if (!answer) return back('An empty answer does not move a disbursement.');
      const r = await asUser(sess, async c => (await c.query(
        `UPDATE pack_queries SET answered_at = now(), answer = $2, answered_by = $3
          WHERE id = $1 AND answered_at IS NULL RETURNING id`,
        [f.id, answer, sess.id])).rows[0]);
      return back(r ? 'Answered. The lender has what it asked for.'
                    : 'That question could not be answered. It may already be closed.');
    }

    if (p === '/office/qpr' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/office/qpr?m=' + encodeURIComponent(m) }); res.end(); };
      const ref = (f.reference || '').trim().slice(0, 60);
      if (!ref) return back('A filing is the acknowledgement reference. Without it there is no filing.');
      const r = await asUser(sess, async c => (await c.query(
        `UPDATE qpr_filings SET filed_at = now(), filed_by = $2, reference = $3
          WHERE id = $1 AND filed_at IS NULL RETURNING quarter`,
        [f.id, sess.id, ref])).rows[0]);
      return back(r ? r.quarter + ' marked filed as ' + ref + '.'
                    : 'That quarter could not be marked filed.');
    }

    /* Answering a buyer. The message goes on the same thread the buyer reads,
       and the query moves from open to answered - which is what takes it off
       this office's Today screen and tells the buyer somebody replied. */
    if (p === '/office/answer' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const to = '/office/question/' + encodeURIComponent(f.id || '');
      const back = m => { res.writeHead(302, { location: to + '?m=' + encodeURIComponent(m) }); res.end(); };
      const text = (f.body || '').trim().slice(0, 400);
      if (!text) return back('An empty message says nothing.');
      const ok = await asUser(sess, async c => {
        /* `author_id = current_user_id() AND author_role = current_role_name()`
           is in the policy, so this cannot be signed as anybody else. */
        const r = await c.query(
          `INSERT INTO query_messages (id, query_id, author_id, author_role, body)
           SELECT $1, q.id, $3, 'office', $4 FROM queries q WHERE q.id = $2 RETURNING id`,
          ['qm-' + crypto.randomUUID(), f.id, sess.id, text]);
        if (r.rowCount !== 1) return false;
        await c.query(
          `UPDATE queries SET status = 'answered' WHERE id = $1 AND status = 'open'`, [f.id]);
        return true;
      });
      return back(ok ? 'Sent. The buyer sees it on their own thread.'
                     : 'That message could not be sent.');
    }

    if (p === '/office/close' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const to = '/office/question/' + encodeURIComponent(f.id || '');
      const r = await asUser(sess, async c => (await c.query(
        `UPDATE queries SET status = 'closed', closed_at = now()
          WHERE id = $1 AND status <> 'closed' RETURNING subject`, [f.id])).rows[0]);
      res.writeHead(302, { location: to + '?m=' + encodeURIComponent(
        r ? 'Closed. The buyer can still read the thread.'
          : 'That could not be closed.') });
      return res.end();
    }

    /* Reassigning a villa. The write goes through assign_engineer(), which is
       SECURITY DEFINER because units has no UPDATE policy - the same route
       record_sanction takes, and for the same reason. */
    if (p === '/office/assign' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const r = f.unit && f.engineer && await asUser(sess, async c => {
        const ok = (await c.query('SELECT assign_engineer($1,$2) ok', [f.unit, f.engineer])).rows[0].ok;
        if (!ok) return null;
        return (await c.query(
          `SELECT u.code, e.display_name FROM units u
             JOIN users e ON e.id = u.assigned_engineer_id WHERE u.id = $1`, [f.unit])).rows[0];
      }).catch(() => null);
      /* Back to the screen the control was on. Both places that offer it -
         stages waiting on a certificate, and villas that have gone quiet -
         send the reassignment here, so the caller says where it came from. */
      const from = ['signoff', 'silent'].includes(f.from) ? f.from : 'signoff';
      res.writeHead(302, { location: '/office/' + from + '?m=' + encodeURIComponent(
        r ? `${r.code} reassigned to ${r.display_name}. It is on their list now and off the last one's.`
          : 'That villa could not be reassigned.') });
      return res.end();
    }

    if (p === '/office/sanction' && req.method === 'POST' && sess.role === 'office') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/office/chase?m=' + encodeURIComponent(m) }); res.end(); };

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

    /* ---------------------------------------------------- the buyer writes

       Four things a buyer may change, and every one of them is read by
       somebody else: a visit request appears on the engineer's Visits tab, a
       question lands in the office queue, a signed choice is what the site
       builds, and the lender pick decides how fast money moves.

       Each is checked here and again by row-level security, which is what
       actually holds: `owns_unit()` and `requested_by = current_user_id()` are
       in the policy, so a buyer who posts another villa's id gets nothing
       inserted no matter what this code believes. */

    if (p === '/visit' && req.method === 'POST' && sess.role === 'buyer') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/visit?m=' + encodeURIComponent(m) }); res.end(); };
      const day = /^\d{4}-\d{2}-\d{2}$/.test(f.day || '') ? f.day : null;
      if (!day) return back('That is not a date the site can book.');
      // Ten in the morning: a site visit is a daylight thing, and asking a
      // buyer to pick a time as well is a field they will get wrong.
      const slot = new Date(day + 'T10:00:00+05:30');
      if (!(slot > new Date())) return back('Ask for a day that has not happened yet.');
      const note = (f.note || '').trim().slice(0, 140);
      const ok = await asUser(sess, async c => {
        const u = (await c.query('SELECT id FROM units WHERE code = $1', [sess.unit])).rows[0];
        if (!u) return false;
        /* The engineer the villa is already assigned to, so the request lands
           on somebody's list rather than in a pool nobody owns. */
        await c.query(
          `INSERT INTO visits (id, unit_id, slot_at, note, requested_by, engineer_id)
           SELECT $1, $2, $3, $4, $5, assigned_engineer_id FROM units WHERE id = $2`,
          ['visit-' + crypto.randomUUID(), u.id, slot.toISOString(), note, sess.id]);
        return true;
      });
      return back(ok
        ? 'Asked for ' + M.longDate(slot) + '. The engineer answers from their own list.'
        : 'That visit could not be booked.');
    }

    if (p === '/questions' && req.method === 'POST' && sess.role === 'buyer') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/questions?m=' + encodeURIComponent(m) }); res.end(); };
      const kind = ['query', 'warranty'].includes(f.kind) ? f.kind : 'query';
      const subject = (f.subject || '').trim().slice(0, 120);
      if (!subject) return back('A question needs a line saying what it is about.');
      const ok = await asUser(sess, async c => {
        const u = (await c.query('SELECT id FROM units WHERE code = $1', [sess.unit])).rows[0];
        if (!u) return false;
        await c.query(
          `INSERT INTO queries (id, unit_id, kind, subject, raised_by)
           VALUES ($1,$2,$3,$4,$5)`,
          ['q-' + crypto.randomUUID(), u.id, kind, subject, sess.id]);
        return true;
      });
      return back(ok
        ? 'Asked. It is in the office queue with your villa attached.'
        : 'That question could not be raised.');
    }

    if (p === '/questions/reply' && req.method === 'POST' && sess.role === 'buyer') {
      const f = form(await body(req));
      const to = '/questions/' + encodeURIComponent(f.id || '');
      const back = m => { res.writeHead(302, { location: to + '?m=' + encodeURIComponent(m) }); res.end(); };
      const text = (f.body || '').trim().slice(0, 400);
      if (!text) return back('An empty message says nothing.');
      const ok = await asUser(sess, async c => {
        /* `author_id = current_user_id() AND author_role = current_role_name()`
           is in the policy, so a message cannot be signed as anyone else. */
        const r = await c.query(
          `INSERT INTO query_messages (id, query_id, author_id, author_role, body)
           SELECT $1, q.id, $3, 'buyer', $4 FROM queries q WHERE q.id = $2
           RETURNING id`,
          ['qm-' + crypto.randomUUID(), f.id, sess.id, text]);
        return r.rowCount === 1;
      });
      return back(ok ? 'Sent. The office picks it up from here.' : 'That message could not be sent.');
    }

    if (p === '/choices' && req.method === 'POST' && sess.role === 'buyer') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/choices?m=' + encodeURIComponent(m) }); res.end(); };
      const r = await asUser(sess, async c => {
        /* `selected = ANY(options)` and `choices_signed_whole` are both table
           constraints, so an option that is not on the list, or a selection
           without a signature, is refused by the database rather than by this
           line. Signing an already-signed choice is refused here: it is not a
           constraint violation, it is a second decision on a settled one. */
        const row = await c.query(
          `UPDATE choices SET selected = $2, signed_at = now(), signed_by = $3
            WHERE id = $1 AND selected IS NULL
            RETURNING label, selected`,
          [f.id, f.option, sess.id]);
        return row.rows[0] || null;
      });
      return back(r
        ? r.label + ': ' + r.selected + ' signed. The site builds that.'
        : 'That choice could not be signed. It may already be settled.');
    }

    if (p === '/bank' && req.method === 'POST' && sess.role === 'buyer') {
      const f = form(await body(req));
      const back = m => { res.writeHead(302, { location: '/bank?m=' + encodeURIComponent(m) }); res.end(); };
      const r = await asUser(sess, async c => {
        const u = (await c.query('SELECT id FROM units WHERE code = $1', [sess.unit])).rows[0];
        if (!u) return null;
        /* `choose_lender` is SECURITY DEFINER and takes the actor from the
           transaction rather than from a parameter, because picking a lender
           writes `units.bank`, which a buyer may not update directly - the
           sanction figures live on the same row.

           The third argument is an outside bank's name, not the actor, and the
           function raises unless exactly one of the two is given. A buyer
           picking from the panel passes null. */
        const ok = (await c.query('SELECT choose_lender($1,$2,null) ok',
          [u.id, f.lender])).rows[0].ok;
        if (!ok) return null;
        return (await c.query('SELECT name FROM lenders WHERE id = $1', [f.lender])).rows[0];
      });
      return back(r
        ? r.name + ' is your lender. The office prepares your file for them.'
        : 'That lender could not be picked. A lender is chosen once.');
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
      /* Where to land afterwards. The villa detail screen posts its own path
         so the engineer stays on the villa he is photographing instead of
         being thrown back to a list. Only a local path is honoured: a `back`
         value is attacker-controlled input like any other. */
      let dest = '/engineer/certs';
      const back = m => {
        res.writeHead(302, { location: dest + (dest.includes('?') ? '&' : '?') + 'm=' + encodeURIComponent(m) });
        res.end();
      };
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
      // A relative path on this site, nothing else. Not a URL, not a host.
      if (/^\/[A-Za-z0-9/_-]{1,80}$/.test(parsed.fields.back || '')) dest = parsed.fields.back;
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

    /* Closing a snag is the same act as filing evidence - a photograph, taken
       and stamped - so it goes through the same store and the same integrity
       check. What differs is where the hash lands: a snag closed without one
       is a claim rather than a record, which the table's own constraint says. */
    if (p === '/engineer/snag' && req.method === 'POST' && sess.role === 'engineer') {
      const back = m => { res.writeHead(302, { location: '/engineer/snags?m=' + encodeURIComponent(m) }); res.end(); };
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
      const id = (parsed.fields.id || '').trim();
      const caption = (parsed.fields.caption || '').trim().slice(0, 120);
      if (!file || !id || !caption) return back('A photograph of the fix and a note are both required.');

      let stored;
      try { stored = await EV.store(file.data); }
      catch (e) {
        return back(e.code === 'BAD_TYPE' ? 'Only JPEG and PNG photographs are accepted.'
                  : 'That photograph could not be stored.');
      }

      const r = await asUser(sess, async c => (await c.query(
        `UPDATE snags SET status = 'fixed', fixed_at = now(), fixed_by = $2, fix_sha256 = $3
          WHERE id = $1 AND status = 'open'
          RETURNING title, (SELECT code FROM units WHERE id = unit_id) code`,
        [id, sess.id, stored.sha256])).rows[0]);
      return back(r ? r.code + ': "' + r.title + '" photographed and sent to the buyer to sign off.'
                    : 'That snag is not open.');
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
module.exports.ASSET_ROUTES = Object.keys(ASSETS);  // every URL served as a static file
module.exports.CSS = CSS;       // the content-addressed stylesheet URLs the pages link
