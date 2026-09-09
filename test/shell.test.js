'use strict';
/* ============================================================================
   THE SHELL, AS EVERY ROLE SEES IT. ONE SYSTEM.

   WHAT THIS FILE USED TO GUARD, AND WHY IT DOES NOT ANY MORE. Until Pass 4
   this suite held v21's shape: a phone mock widened into an application, its
   `.wrow` flex row, its `.lede` header, its bottom tab bar, `--card-shadow`
   defined only above 721px, and forty tests asserting that app.css restated
   none of plint.css's values. Every one of those tests passed while the audit
   measured what that system actually produced: no card at all below 721px, one
   font-weight declaration at 700 in 1,987 lines, body text at `--ink-2` and
   every label at 3.15:1 on white.

   The design reference changed by instruction, so those tests were asserting a
   retired specification. They are replaced - not deleted quietly - by the
   guards for the system that is shipped: office.css, from
   inbell_office_dashboard.html, drawn for all three roles out of
   src/screens/kit.js. Where a test below replaces one of them it says so.

   A test is still never rewritten to agree with a regression. The board test
   at the end is the one that exists because a view was deleted once, and it is
   carried across unchanged.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db');
const PORT = 3242, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

const ROLES = {
  buyer:    'arjun@example.in',
  engineer: 'ramachandran@nvt.in',
  office:   'priya@nvt.in',
};

/* Every screen a signed-in person can navigate to, by role. Kept explicit so
   that adding a screen without deciding where it sits in the navigation is a
   test failure rather than an orphan page. */
const SCREENS = {
  buyer:    ['/journey', '/villa/B-14', '/visit', '/money', '/more',
             '/bank', '/loan', '/agreement', '/choices', '/questions', '/documents'],
  engineer: ['/engineer', '/engineer/villas', '/engineer/visits', '/engineer/log',
             '/engineer/certs', '/engineer/snags'],
  office:   ['/office', '/office/packs', '/office/wait', '/office/query',
             '/office/chase', '/office/stages', '/office/evidence', '/office/silent',
             '/office/signoff', '/office/villas', '/office/documents', '/office/choices',
             '/office/visits', '/office/warranty', '/office/rera', '/office/escrow',
             '/office/possession', '/office/schedule', '/office/lenders',
             '/office/logins', '/office/settings', '/office/help'],
};

/* How many destinations each role has. The buyer's twelve are the point of
   Pass 4's third job: they were five, because v21's bottom bar held five, and
   Bank, Loan, Papers, Agreement, Choices and Questions were folded behind one
   called More - which is where a buyer could not find their bank. */
const DESTINATIONS = { buyer: 11, engineer: 6, office: 22 };

const cookies = {};
before(async () => {
  for (const [role, email] of Object.entries(ROLES)) {
    const r = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    const c = r.headers.get('set-cookie');
    assert.ok(c, role + ' could not sign in');
    cookies[role] = c.split(';')[0];
  }
});

const get = (p, role) =>
  fetch(BASE + p, { headers: role ? { cookie: cookies[role] } : {}, redirect: 'manual' });
const body = async (p, role) => (await get(p, role)).text();
const css = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'office.css'), 'utf8');

/** Every screen in the app. */
function everyScreen() {
  const all = [];
  for (const [role, paths] of Object.entries(SCREENS)) for (const p of paths) all.push([role, p]);
  return all;
}

/**
 * Every rule at a breakpoint, from every block that declares it. A stylesheet
 * may declare a breakpoint as many times as it likes, and reading only the
 * first block is how a rule silently leaves what a test is watching.
 */
function atWidth(sheet, query) {
  /* Whitespace-tolerant on purpose. The reference's own block is written
     `@media(max-width:860px){` and this file's are written with spaces; a
     regex that insisted on one of the two read half the rules and reported
     the other half missing. */
  const loose = query.replace(/\s+/g, '\\s*').replace(/:/g, '\\s*:\\s*');
  const re = new RegExp('@media\\s*\\(\\s*' + loose + '\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\}', 'g');
  const blocks = [...sheet.matchAll(re)].map(m => m[1]);
  assert.ok(blocks.length, 'no @media (' + query + ') block in the stylesheet');
  return blocks.join('\n');
}

// ------------------------------------------------------------- one system

test('there is one stylesheet, and the retired one is gone', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.ok(h.includes(server.CSS.office), p + ' does not link the one stylesheet');
    assert.ok(!/plint\.css|app\.css/.test(h),
      p + ' still links v21: ' + (/(plint|app)\.[0-9a-f.]*css/.exec(h) || [])[0]);
  }
  /* And the files themselves are gone, so nothing can drift back to them. */
  for (const f of ['plint.css', 'app.css']) {
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', f)),
      'public/' + f + ' is back; the retired system has two of every value');
  }
  /* Asked for as a signed-in reader, because an anonymous request for an
     unknown path is bounced to sign-in before anything looks for a file. */
  for (const p of ['/plint.css', '/app.css']) {
    assert.strictEqual((await get(p, 'buyer')).status, 404, p + ' is still served');
  }
});

test('a card is a card at every width', async () => {
  /* THE AUDIT'S FIRST FINDING. `--card-shadow: none` at the root of the retired
     stylesheet, redefined only inside `@media (min-width: 721px)`, with every
     card rule inside that same query - so a phone got hairlines on white and
     the whole surface read as text floating on a page.

     Every surface in this system draws itself unconditionally. If one of them
     is ever moved inside a `min-width` query, this fails. */
  const sheet = css();
  for (const sel of ['.card', '.tbl', '.kpi', '.dl', '.tl', '.hero']) {
    const rule = new RegExp('\\' + sel + '\\s*\\{[^}]*\\}').exec(sheet);
    assert.ok(rule, sel + ' has no rule of its own');
    assert.match(rule[0], /border:\s*1px solid var\(--hair\)/,
      sel + ' does not draw its own edge');
    assert.match(rule[0], /box-shadow:\s*var\(--sh\)/,
      sel + ' does not lift off the ground');
  }
  const minWidth = [...sheet.matchAll(/@media\s*\(min-width[^)]*\)\s*\{([\s\S]*?)\n\}/g)]
    .map(m => m[1]).join('\n');
  assert.ok(!/box-shadow:\s*var\(--sh\)/.test(minWidth),
    'a card only gets its shadow above some width, which is how the phone lost its cards');
});

test('the type has weight, and the body is ink', async () => {
  /* The audit counted 131 font-weight declarations across the retired pair:
     one at 700, none at 800, so nothing on a buyer's screen was ever emphatic.
     And `body { color: var(--ink-2) }` started every word one step faded. */
  const sheet = css();
  const weights = [...sheet.matchAll(/font-weight:\s*(\d{3})/g)].map(m => Number(m[1]));
  const heavy = weights.filter(w => w >= 700).length;
  assert.ok(heavy >= 10,
    'only ' + heavy + ' declarations at 700 or above; nothing on these screens is emphatic');
  assert.match(sheet, /body\s*\{[^}]*color:\s*var\(--ink\)/,
    'the body text is not the ink');
  assert.match(sheet, /--disp:\s*'Manrope'/, 'there is no display face');
  assert.match(sheet, /--body:\s*'Inter'/, 'there is no body face');
});

test('every screen carries the shell, and a way out of it', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.match(h, /<aside class="side" id="side">/, p + ' has no sidebar');
    assert.match(h, /<nav class="nav">/, p + ' has no destinations');
    assert.match(h, /class="ham" id="ham"/, p + ' has no way to open the drawer on a phone');
    assert.match(h, /<div class="scrim2" id="scrim2">/, p + ' has no scrim behind the drawer');
    assert.match(h, /action="\/logout"/, p + ' offers no way to sign out');
    assert.match(h, /class="uinfo"/, p + ' does not say who is signed in');
  }
});

test('each role is offered its own destinations, and only those', async () => {
  for (const [role, paths] of Object.entries(SCREENS)) {
    const h = await body(paths[0], role);
    const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(h);
    assert.ok(nav, role + ' has no nav to read');
    const hrefs = [...nav[1].matchAll(/class="item[^"]*" href="([^"]+)"/g)].map(m => m[1]);
    assert.strictEqual(hrefs.length, DESTINATIONS[role],
      role + ' is offered ' + hrefs.length + ' destinations, not ' + DESTINATIONS[role]);
    /* And every one of them opens for that role. A destination that 404s is
       navigation that lies. */
    for (const href of hrefs) {
      assert.strictEqual((await get(href, role)).status, 200,
        role + ' is offered ' + href + ', which does not open for them');
    }
  }
});

test('the current screen is marked in the navigation, exactly once', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    const on = (h.match(/class="item on"/g) || []).length;
    assert.strictEqual(on, 1, p + ' marks ' + on + ' destinations as current');
    assert.strictEqual((h.match(/aria-current="page"/g) || []).length, 1,
      p + ' does not tell a screen reader where it is');
  }
});

test('no screen is ever written to the browser cache', async () => {
  for (const [role, p] of everyScreen()) {
    const r = await get(p, role);
    assert.match(r.headers.get('cache-control') || '', /no-store/,
      p + ' may be cached, and these phones get handed around');
  }
});

// ------------------------------------------------------------- the journey

test('the journey is a run of points along a line', async () => {
  /* JOB 2. `.jline`, `.jstep` and `.jdot` shipped unused in plint.css from the
     first commit: the CSS for a timeline was in the build and no line of
     server code ever emitted it. This is that screen, in this system. */
  const h = await body('/journey', 'buyer');
  assert.match(h, /<div class="tl">/, 'the journey has no timeline');
  assert.match(h, /<i class="tlfill"/, 'the line does not fill as the work is done');

  const steps = [...h.matchAll(/<a class="tls (done|now|wait)[^"]*" href="\/stage\//g)]
    .map(m => m[1]);
  assert.strictEqual(steps.length, 10, 'the timeline draws ' + steps.length + ' stages, not ten');
  assert.ok(steps.includes('done'), 'no stage reads as finished');
  assert.ok(steps.includes('now'), 'nothing is marked as the stage in hand');
  assert.ok(steps.includes('wait'), 'nothing is marked as not yet reached');

  /* A finished step is unmistakable, not a tint: the dot is filled with green
     and carries a tick. */
  const sheet = css();
  assert.match(sheet, /\.tls\.done \.tld\s*\{[^}]*background:\s*var\(--green\)/,
    'a finished step is not filled green');
  assert.match(h, /<span class="tld"><svg/, 'a finished step carries no tick');
  assert.match(sheet, /\.tls\.now\s+\.tld\s*\{[^}]*border-color:\s*var\(--accent\)/,
    'the stage in hand is not distinct from the others');
  assert.match(sheet, /\.tls\.wait\s*\{[^}]*opacity/,
    'a stage not yet reached is not quieter');
});

test('the bank, the loan and the papers are reachable from the journey', async () => {
  /* JOB 3. They were steps on the journey in both prototypes. When the screen
     changed subject to the construction stages they became rows behind a
     destination called More, which is the second thing the audit was asked to
     explain. They are a headed section on the journey, and destinations of
     their own in the sidebar. */
  const h = await body('/journey', 'buyer');
  for (const [href, name] of [['/bank', 'your bank'], ['/loan', 'your loan'],
                              ['/documents', 'the papers'], ['/agreement', 'the agreement']]) {
    assert.ok(h.includes('href="' + href + '"'),
      'the journey has no way to reach ' + name);
  }
  const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(h)[1];
  for (const href of ['/bank', '/loan', '/documents', '/agreement']) {
    assert.ok(nav.includes('href="' + href + '"'),
      href + ' is not a destination of its own; it is folded behind a menu again');
  }
});

// --------------------------------------------------------- the photographs

test('a photograph is an image, not a caption', async () => {
  /* JOB 4. `grep -rn "<img" src/` returned one hit before this pass and it was
     inside a comment. The evidence route served the bytes, the isolation was
     tested, the thumbnail cache was built, the PDF embedded them - and no
     screen in a product about photographic evidence displayed one. */
  const screens = [
    ['/stage/book', 'buyer', "the buyer's stage screen"],
    ['/engineer/villa/A-01', 'engineer', "the engineer's villa"],
  ];
  for (const [p, role, what] of screens) {
    const h = await body(p, role);
    const imgs = [...h.matchAll(/<img src="\/evidence\/([0-9a-f]{64})\/thumb"/g)];
    assert.ok(imgs.length, what + ' still prints its photographs as text');
    /* And the tile opens the full size. */
    assert.ok(h.includes('<a class="ph" href="/evidence/' + imgs[0][1] + '"'),
      what + ' does not let you open a photograph larger');
    /* Both URLs answer for the role that may see them. */
    for (const u of ['/evidence/' + imgs[0][1], '/evidence/' + imgs[0][1] + '/thumb']) {
      const r = await get(u, role);
      assert.strictEqual(r.status, 200, u + ' does not serve for ' + role);
      assert.match(r.headers.get('content-type'), /^image\//, u + ' is not an image');
    }
  }
  /* The certificate shows what it certifies. */
  const certs = await body('/engineer/certs', 'engineer');
  const one = /href="(\/engineer\/cert\/[^"]+)"/.exec(certs);
  assert.ok(one, 'no certificate to open');
  const cert = await body(one[1], 'engineer');
  assert.match(cert, /<img src="\/evidence\/[0-9a-f]{64}\/thumb"/,
    'the certificate does not show the photographs it certifies');
});

// ------------------------------------------------------ nothing is hidden

test('no list is truncated under a count that claims more', async () => {
  /* The engineer's own screen said 33 to certify and listed eight, with
     nothing saying so; the villa listed two of the remaining stages. */
  const h = await body('/engineer', 'engineer');
  const claim = /<\/svg> To certify<\/div><b class="num[^"]*">(\d+)</.exec(h);
  assert.ok(claim, 'the engineer is not told how many certificates are waiting');
  const rows = (h.match(/href="\/engineer\/cert\//g) || []).length;
  assert.strictEqual(rows, Number(claim[1]),
    'the screen claims ' + claim[1] + ' certificates and lists ' + rows);

  const villa = await body('/engineer/villa/A-01', 'engineer');
  const marked = (villa.match(/action="\/engineer\/mark"/g) || []).length
    + (villa.match(/href="#addphoto"/g) || []).length
    + (villa.match(/href="\/engineer\/cert\//g) || []).length;
  assert.ok(marked >= 3,
    'the villa offers ' + marked + ' stages to act on; it used to show two of however many');
});

test('a day count is only red when something is late', async () => {
  /* The audit found 98d in red beside a green "Done" on the agreement, 51d
     beside "Seen" on the papers, 21d for a lender's advertised release window,
     and 175d on a stage that was paid and closed. An age is only a verdict
     while somebody is still waiting for the thing it counts. */
  for (const [p, role] of [['/agreement', 'buyer'], ['/documents', 'buyer'],
                           ['/bank', 'buyer'], ['/stage/book', 'buyer']]) {
    const h = await body(p, role);
    const late = (h.match(/class="agev a-late/g) || []).length;
    assert.strictEqual(late, 0,
      p + ' colours ' + late + ' day counts as overdue on a screen where nothing is');
  }
  /* And where something IS late, the colour is still available. */
  const sheet = css();
  assert.match(sheet, /\.agev\.a-late\s*\{\s*color:\s*var\(--red\)/,
    'there is no way left to mark a count as late');
  assert.match(sheet, /\.agev\.a-done\s*\{[^}]*color:\s*var\(--grey\)/,
    'a finished row does not get a plain figure');
});

// -------------------------------------------------------------- the phone

test('a table has a floor and scrolls, rather than crushing its middle', async () => {
  /* At 375 /engineer/certs was 10,985 pixels tall: a text action held the row
     line, `.mid` absorbed every shortfall down to nothing and the title wrapped
     one character per line. */
  const sheet = css();
  const narrow = atWidth(sheet, 'max-width: 860px');
  assert.match(narrow, /\.tbl\s*\{[^}]*overflow-x:\s*auto/,
    'a table does not scroll sideways on a phone');
  assert.match(narrow, /\.tr\s*\{[^}]*min-width:\s*var\(--tmin/,
    'a row has no floor, so the middle column can still go to nothing');
  assert.match(narrow, /\.filters\s*\{[^}]*scrollbar-width/,
    'a bar of chips wider than the screen clips silently');

  const h = await body('/engineer/certs', 'engineer');
  assert.match(h, /class="tbl" id="engcerts" style="--tmin:\d+px"/,
    'the certificates table declares no floor');

  /* And below 560 there is no width to scroll into - 343px of content against
     a six-column row - so the row becomes a block and every control it carries
     is on the page. Without this the bank list, the villa register and the
     villa's own stages all had their one control behind a sideways drag. */
  const small = atWidth(sheet, 'max-width: 560px');
  assert.match(small, /\.tr\s*\{[^}]*display:\s*block/,
    'a row still keeps its columns on a small phone');
  assert.match(small, /\.tr\.hd\s*\{[^}]*display:\s*none/,
    'the column headings are still drawn over stacked rows');
  assert.match(small, /\.tbl\s*\{[^}]*overflow-x:\s*visible/,
    'the table still scrolls sideways where it has nowhere to scroll');
});

test('the KPI strip narrows, and a rupee figure never breaks', async () => {
  const sheet = css();
  const narrow = atWidth(sheet, 'max-width: 560px');
  assert.match(narrow, /\.kpis[^{]*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/,
    'the tiles do not go to one column on a phone');
  assert.match(narrow, /\.kpi b\s*\{\s*white-space:\s*nowrap/,
    'a money figure may still break across two lines');
});

test('a conversation is not a scroll box inside a page that scrolls', async () => {
  /* `.thread` was `max-height: 280px; overflow-y: auto; column-reverse`,
     inherited from a prototype where it lived inside an 830px phone frame. At
     375 the box was 280px over 345px of content, so the buyer's own first
     question was scrolled out of sight. */
  const sheet = css();
  const rule = /\.thread\s*\{[^}]*\}/.exec(sheet);
  assert.ok(rule, 'there is no thread');
  assert.ok(!/max-height/.test(rule[0]), 'the thread is a scroll box again');
  assert.ok(!/overflow/.test(rule[0]), 'the thread scrolls inside the page again');

  const h = await body('/questions/q-b14-1', 'buyer');
  const msgs = (h.match(/<div class="msg /g) || []).length;
  assert.ok(msgs >= 2, 'the thread renders ' + msgs + ' messages');
  /* Oldest first: the buyer's own question is the first bubble in the source. */
  assert.match(h, /<div class="msg me">\s*<p>When will the plastering start/,
    'the thread does not open with the question that started it');
});

test('a native control is never left as the browser draws it', async () => {
  /* A `<select>`, an `<input type="file">` and an `<input type="date">` arrive
     with the browser's own chrome. The audit found all three among custom
     components, the file input clipped mid-word at "No fil...hosen". */
  const sheet = css();
  assert.match(sheet, /\.fsel select\s*\{[^}]*appearance:\s*none/,
    'a select still draws the browser\u2019s arrow');
  assert.match(sheet, /\.ffi\s*\{[^}]*opacity:\s*0/,
    'a file input is still the browser\u2019s own control');

  for (const [p, role] of [['/choices', 'buyer'], ['/questions', 'buyer'],
                           ['/engineer/snags', 'engineer'],
                           ['/engineer/villa/A-01', 'engineer'], ['/visit', 'buyer']]) {
    const h = await body(p, role);
    for (const m of h.matchAll(/<select[^>]*class="([^"]*)"/g)) {
      assert.match(m[1], /\bfi\b/, p + ' has a select outside this system');
    }
    for (const m of h.matchAll(/<input[^>]*type="file"[^>]*class="([^"]*)"/g)) {
      assert.match(m[1], /\bffi\b/, p + ' has a raw file input');
    }
    for (const m of h.matchAll(/<input[^>]*type="date"[^>]*class="([^"]*)"/g)) {
      assert.match(m[1], /\bfi\b/, p + ' has a raw date input');
    }
  }
});

test('the drawer is the phone navigation for all three roles', async () => {
  const sheet = css();
  const narrow = atWidth(sheet, 'max-width: 860px');
  assert.match(narrow, /\.side\s*\{[^}]*transform:\s*translateX\(-100%\)/,
    'the sidebar does not go off-canvas on a phone');
  assert.match(narrow, /\.side\.open\s*\{[^}]*translateX\(0\)/, 'the drawer never opens');
  assert.match(narrow, /\.ham\s*\{[^}]*display:\s*flex/, 'there is no way to open it');
  assert.ok(!/\.ham\s*\{\s*display:\s*flex/.test(sheet.split('@media')[0]),
    'the hamburger is on a desktop too, where the sidebar is already there');
});

// -------------------------------------------------------------- the law

test('the design law: flat, and green is a state', async () => {
  const sheet = css();
  /* No gradient anywhere. The retired stylesheet carried ten and app.css spent
     a section turning each of them off. */
  assert.ok(!/gradient\(/.test(sheet), 'a gradient is back in the stylesheet');

  /* Green marks a state on a row. It is not the ground of a progress bar and
     it is not a page accent. */
  assert.match(sheet, /\.bar span\s*\{\s*background:\s*var\(--accent\)/,
    'the progress bar is green again, which makes green the largest area on the screen');
  const greenUsers = [...sheet.matchAll(/([^{}]+)\{[^}]*var\(--green\)/g)].map(m => m[1].trim());
  for (const sel of greenUsers) {
    /* `.bar span` is the reference's own rule; the ADDED block at the end of
       the file overrides its fill to the accent, which is what ships. */
    assert.match(sel, /p-paid|mini-v\.g|tls\.done|tlfill|agev|t-ok|bar span/,
      'green is used on "' + sel + '", which is not a state on a row');
  }

  /* And one palette. Every colour in the file is a token or one of the handful
     the reference itself writes literally. */
  const literals = [...sheet.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0].toUpperCase());
  const allowed = new Set(['#F8F9FB', '#FFF', '#FFFFFF', '#0C0D10', '#71737A', '#A6A8AF',
    '#ECEDF0', '#F4F5F7', '#2F6BFF', '#EAF0FF', '#0F1014', '#12855B', '#E9F6EF',
    '#B4530B', '#FFF2E8', '#B42318', '#FEEDEC', '#FDECEA', '#D8E3FF', '#274690',
    '#BFE6D2', '#0B5B3F']);
  for (const lit of literals) {
    assert.ok(allowed.has(lit), lit + ' is a colour that is not in the palette');
  }
});

test('the certificate names itself in text, not in entities', async () => {
  /* `desk()` escapes the title it is given, and one screen handed it a
     pre-encoded `&middot;` - so the tab and the phone bar both printed
     "Certificate &middot; Villa A-02" as source. */
  const certs = await body('/engineer/certs', 'engineer');
  const one = /href="(\/engineer\/cert\/[^"]+)"/.exec(certs);
  const h = await body(one[1], 'engineer');
  assert.ok(!/&amp;(middot|nbsp|rsquo|mdash);/.test(h),
    'a screen is printing an HTML entity as source');
});

test('a screen does not draw a box around nothing', async () => {
  /* An empty card is dead space, and the retired system had several: a 190px
     handover card holding one centred sentence, a hero card 1170px wide
     holding a single digit. An empty state says why it is empty and offers a
     way off it. */
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.ok(!/<div class="cb">\s*<\/div>/.test(h), p + ' draws a card around nothing');
    assert.ok(!/<div class="tbl"[^>]*>\s*<\/div>/.test(h), p + ' draws an empty table');
  }
});

// ------------------------------------------------------------- the board

test('the office board groups by who is holding it up, and accounts for every villa', async () => {
  /* THIS TEST EXISTS BECAUSE THE VIEW WAS DELETED ONCE.

     "Stuck money, by who is holding it up" - four columns, The engineer / This
     office / The lender / The buyer - was the most useful view in the product,
     because it answers "who do I chase today" rather than "what state is this
     pack in". It was dropped when the console was rebuilt on a new reference,
     and the test that asserted it was rewritten at the same time to match the
     new behaviour. That is the failure this test is here to make loud.

     A test is never rewritten to agree with a regression. If these columns go
     again, this fails, and it fails saying what is missing by name. */
  const h = await body('/office', 'office');

  for (const label of ['The engineer', 'This office', 'The lender', 'The buyer']) {
    assert.ok(h.includes('<span class="ctt">' + label + '</span>'),
      'the holder board has lost the "' + label + '" column');
  }

  const board = (/<div class="board">[\s\S]*?(?=<div class="hsub")/.exec(h) || [''])[0];
  assert.ok(board, 'there is no board on the office dashboard');
  const counts = [...board.matchAll(/<span class="cnt">(\d+)<\/span>/g)].map(m => Number(m[1]));
  assert.strictEqual(counts.length, 4,
    'the board draws ' + counts.length + ' columns, not four');
  const summed = counts.reduce((a, b) => a + b, 0);

  const villas = await body('/office/villas', 'office');
  const total = (villas.match(/data-tags=/g) || []).length;
  assert.ok(total > 0, 'the villa register is empty, so this proves nothing');
  assert.strictEqual(summed, total,
    'the holder columns hold ' + summed + ' villas but the register has ' + total
    + ': ' + counts.join(' + '));

  assert.match(h, new RegExp(summed + ' of ' + total + ' villas have a stage blocked'),
    'the board does not say how much of the project it accounts for');

  assert.match(h, /class="chip on" href="\/office"/,
    'the holder view is not the one the dashboard opens on');
  const packs = await body('/office?view=packs', 'office');
  for (const label of ['Certified, pack not sent', 'With the lender',
                       'Lender has asked', 'Disbursed']) {
    assert.ok(packs.includes('<span class="ctt">' + label + '</span>'),
      'the pack-state view has lost the "' + label + '" column');
  }
  assert.match(packs, /class="chip on" href="\/office\?view=packs"/,
    'the pack view does not mark itself as the one showing');
});

// ------------------------------------------------------------ the install

test('every role can install the app, and the install belongs to the app', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.match(h, /rel="manifest" href="\/manifest\.webmanifest"/, p + ' cannot be installed');
    assert.match(h, /name="apple-mobile-web-app-capable" content="yes"/,
      p + ' is not an installed-app screen on iOS');
    assert.match(h, /viewport-fit=cover/, p + ' ignores the notch');
  }
  const manifest = JSON.parse(await (await get('/manifest.webmanifest')).text());
  assert.strictEqual(manifest.start_url, '/', 'the install starts in one role');
});

test('the stylesheet parses: no rule is stranded in prose', () => {
  /* Every other test here matches the text of the stylesheet, and text cannot
     tell a rule from a comment. A comment closed twice once dropped a rule and
     every text assertion stayed green. */
  const sheet = css();
  let depth = 0;
  for (const ch of sheet.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0, 'a closing brace with nothing open: the stylesheet is broken');
  }
  assert.strictEqual(depth, 0, 'the stylesheet has ' + depth + ' unclosed blocks');
  assert.ok(!/\/\*[^*]*\/\*/.test(sheet), 'a comment is opened inside a comment');
});
