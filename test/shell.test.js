'use strict';
/* ============================================================================
   The application shell, as every role sees it.

   v21 is a design file: it draws each role as a 392px phone mock with a
   painted-on `9:41` status bar, sitting on a slate inside the prototype's own
   chrome. Shipping that as the product gave a buyer a phone card in the middle
   of a monitor and an office worklist with five fixed columns on a handset.

   These tests hold the shape it was replaced with: no frame anywhere, one app
   bar, one set of destinations per role rendered as a sidebar on a desktop and
   a bottom tab bar on a phone, and the PWA head tags on every screen a signed
   in person can reach - not only the buyer's.
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
  buyer:    ['/villa/B-14', '/documents'],
  engineer: ['/engineer', '/engineer/villas', '/engineer/visits', '/engineer/log',
             '/engineer/certs', '/engineer/snags'],
  office:   ['/office', '/office/sanctions'],
};

/* How many destinations each role has, and therefore what navigation it gets.

   Up to five is v21's bottom bar - `.nav five` is a shape v21 designed and
   five fits a phone. Above five it becomes a menu button, which is the head
   office: fifteen destinations in nine groups are not a bar at any width. */
const BAR_FITS = 5;
const DESTINATIONS = { buyer: 2, engineer: 5, office: 2 };

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

/** Every screen in the app, including the two nobody signs in to reach. */
function everyScreen() {
  const all = [];
  for (const [role, paths] of Object.entries(SCREENS)) for (const p of paths) all.push([role, p]);
  return all;
}

// --------------------------------------------------------------- no frame

test('no screen renders the phone frame', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.ok(!/class="sysbar"/.test(h), role + ' ' + p + ' still paints the fake 9:41 status bar');
    assert.ok(!/class="bar"/.test(h), role + ' ' + p + " still renders the prototype's chrome");
  }
  for (const p of ['/', '/offline']) {
    const h = await body(p);
    assert.ok(!/class="sysbar"/.test(h), p + ' still paints the fake status bar');
  }
});

test('the stylesheet unfixes the card rather than leaving it 392px', async () => {
  const css = await (await get('/app.css')).text();
  // The three selectors v21 uses to pin a width. All must be released.
  for (const sel of ['.phone', '.phone.wide', '.phone.wide.solo']) {
    assert.ok(css.includes(sel), 'app.css does not mention ' + sel);
  }
  assert.match(css, /max-width:\s*none/, 'nothing releases the fixed card width');
  assert.match(css, /\.sysbar\s*\{\s*display:\s*none/, 'the fake status bar is not hidden');
  assert.match(css, /\.bar\s*\{\s*display:\s*none/, "the prototype's chrome is not hidden");
});

// ------------------------------------------------------------- app bar

test('every screen carries the app bar, signed in or not', async () => {
  for (const [role, p] of everyScreen()) {
    assert.match(await body(p, role), /<header class="appbar">/, role + ' ' + p + ' has no app bar');
  }
  for (const p of ['/', '/offline']) {
    assert.match(await body(p), /<header class="appbar">/, p + ' has no app bar');
  }
});

test('a signed-in person always has a way out, and is told who they are', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.match(h, /class="ab-who"/, role + ' ' + p + ' does not say who is signed in');
    assert.match(h, /class="ab-out" href="\/logout"/, role + ' ' + p + ' has no sign out');
  }
  // The sign-in page has neither, because there is no session to name or end.
  const h = await body('/');
  assert.ok(!/class="ab-out"/.test(h), 'the sign-in page offers a sign out');
});

// ---------------------------------------------------------- navigation

test('each role gets the navigation its number of sections earns', async () => {
  for (const [role, paths] of Object.entries(SCREENS)) {
    const h = await body(paths[0], role);
    const tabs = (h.match(/<nav class="tabbar"[\s\S]*?<\/nav>/) || [''])[0];
    const count = (tabs.match(/<a href=/g) || []).length;

    if (DESTINATIONS[role] > 1) {
      assert.ok(tabs, role + ' has ' + DESTINATIONS[role] + ' sections and no tab bar');
      assert.strictEqual(count, DESTINATIONS[role],
        role + ' has ' + DESTINATIONS[role] + ' sections but ' + count + ' tabs');
      assert.match(tabs, /--tabs:/, role + ': the tab bar does not size its own columns');
    } else {
      /* One section is not navigation. A bar with a single tab in it is
         furniture that never does anything. */
      assert.strictEqual(tabs, '', role + ' has one section and still gets a tab bar');
    }
    /* Above five destinations the bar becomes a menu. Nothing has crossed that
       line yet; when the office grows to fifteen this assertion is what makes
       forgetting the menu a failure rather than a squashed bar. */
    if (DESTINATIONS[role] > BAR_FITS) {
      assert.match(h, /class="ab-menu"/,
        role + ' has ' + DESTINATIONS[role] + ' destinations and no menu button');
    } else {
      assert.ok(!/class="ab-menu"/.test(h), role + ' rendered a menu button it does not need');
    }
  }
});

test('the current screen is marked in the navigation', async () => {
  for (const [role, paths] of Object.entries(SCREENS)) {
    if (DESTINATIONS[role] < 2) continue;
    for (const p of paths) {
      const h = await body(p, role);
      const marks = (h.match(/aria-current="page"/g) || []).length;
      assert.ok(marks >= 1, role + ' ' + p + ' marks no destination as current');
    }
  }
});

test('navigation is never offered twice on the same screen', async () => {
  /* The office had a sidebar and the same two links in the app bar. Two
     controls for one thing, both live, is a worse answer than one. */
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    const side = /class="side"/.test(h), inline = /class="ab-nav"/.test(h);
    assert.ok(!(side && inline), role + ' ' + p + ' has both a sidebar and app-bar links');
  }
});

test('a role is never offered a destination that would 404 for it', async () => {
  for (const [role, paths] of Object.entries(SCREENS)) {
    const h = await body(paths[0], role);
    const offered = [...h.matchAll(/<a[^>]+href="(\/[a-z/-]+)"/g)].map(m => m[1])
      .filter(u => !['/', '/logout'].includes(u) && !u.startsWith('/doc') && !u.startsWith('/evidence'));
    for (const u of new Set(offered)) {
      const r = await get(u, role);
      assert.ok(r.status !== 404, role + ' is offered ' + u + ', which 404s for that role');
    }
  }
});

// ------------------------------------------------------------------ PWA

test('every role can install the app, not only the buyer', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    assert.match(h, /rel="manifest" href="\/manifest\.webmanifest"/, role + ' ' + p + ': no manifest');
    assert.match(h, /rel="apple-touch-icon"/, role + ' ' + p + ': no iOS icon');
    assert.match(h, /name="theme-color"/, role + ' ' + p + ': no theme colour');
    assert.match(h, /serviceWorker/, role + ' ' + p + ': the worker is never registered');
    assert.match(h, /viewport-fit=cover/, role + ' ' + p + ': no safe-area opt-in for a notch');
  }
});

// ------------------------------------------------------- responsive rules

test('the sideways-scroll backstop does not cost a scrollbar', async () => {
  /* `overflow-x: hidden` makes an element a scroll container, which forces
     `overflow-y` from `visible` to `auto`. On `body` that meant a second
     scrollbar inside the document's own: the content box measured 1420px in a
     1430px viewport on the deployed URL, and every buyer screen sat in a dead
     ten pixel strip. `clip` clips without becoming a scroll container. */
  const css = await (await get('/app.css')).text();
  assert.ok(!/\bbody\b[^{]*\{[^}]*overflow-x:\s*hidden/.test(css),
    'body uses overflow-x: hidden, which gives it its own scrollbar');
  assert.match(css, /html\s*\{\s*overflow-x:\s*clip/, 'no horizontal backstop at all');
});

test('the worklists can stop being tables', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(narrow, 'no narrow-screen block in app.css');
  assert.match(narrow[1], /\.whead\s*\{\s*display:\s*none/, 'column headings survive as cards');
  assert.match(narrow[1], /\.wrow\s*\{[\s\S]*?display:\s*grid/, 'rows do not reflow to cards');
  assert.match(narrow[1], /\.uprow/, 'the forms keep their fixed field widths');

  /* The narrow rule for the histogram must outrank the base rule rather than
     merely differ from it. The first version used the same selector, `.agebar`,
     and the base rule sits later in the file - so at equal specificity the base
     won, the width scaled, the height did not, and the deployed phone view
     still drew four slabs. */
  assert.match(narrow[1], /\.agebars \.agebar\s*\{[^}]*height:\s*calc\(/,
    'the narrow histogram rule is not specific enough to beat the base height');
  const base = /\n\.agebar \{[^}]*height:\s*var\(--h/.exec(css);
  assert.ok(base, 'no base height rule driven by --h');
  assert.ok(css.indexOf(narrow[0]) < base.index,
    'the base rule now precedes the media block, so the ordering trap is gone - ' +
    'but the specific selector is what this test is really holding');
});

test('the villa and the stage are one run of text, not two cells', async () => {
  /* Same font size and weight was not enough. They were separate grid cells
     with a 10px gap and a separator drawn between them, and their baselines
     sat 3px apart - so it read as two labels with a dot floating in the space.
     One run of text is the only thing that fixes that, and it has to come from
     the markup. */
  for (const [role, p] of [['engineer', '/engineer'], ['office', '/office']]) {
    const h = await body(p, role);
    const codes = h.match(/<p class="rt"><span class="rcode">[^<]+<\/span>[^<]/g) || [];
    assert.ok(codes.length > 0,
      role + ' ' + p + ': no row puts the villa code inside its heading');
    // And the row says so, so the stylesheet can drop the standalone cell.
    assert.match(h, /class="wrow hascode"/, role + ' ' + p + ': rows do not declare they carry a code');
  }
});

test('rows are built in one place, not copied per screen', async () => {
  /* Fifteen hand-written copies drifted: the code inline here and in a column
     there, day counts written into the amount cell on one screen and the day
     cell on another. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['src/screens/engineer.js', 'src/server.js']) {
    const viaBuilder = (src(f).match(/\bwrow\(\{/g) || []).length;
    assert.ok(viaBuilder > 0, f + ' builds no rows through the shared builder');

    /* A few rows are a different shape: the villa detail puts a radio button,
       a stage code or a status chip in the first cell rather than a villa
       code, and the builder does not model those. What must never be written
       by hand again is a row carrying a villa code - that is the one that has
       to put the code inside its heading rather than beside it. */
    const handCoded = src(f).match(/class="id">\$\{esc\((?:x|v|s|u)\.code\)/g) || [];
    assert.deepStrictEqual(handCoded, [],
      f + ' still writes ' + handCoded.length + ' villa-code rows by hand');
  }
});

test('one gutter, and everything on a phone starts on it', async () => {
  const css = await (await get('/app.css')).text();
  assert.match(css, /--gutter:\s*18px/, 'there is no single gutter to line up against');

  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  /* Applied at exactly one level. It was stacking three deep - `.mbody` padded
     it, `.wl` is a bordered card that padded it again, and the row added a
     margin - so cards sat at 54..321 while the label above them sat at
     18..357 and the button between them at 36..339. */
  assert.match(narrow, /\.mhead, \.mbody \{[^}]*padding-left:\s*var\(--gutter\)/,
    'the gutter is not applied to the one container that owns it');
  const cleared = /\.wl, \.tools, \.blk, \.mbody \.lede \{([^}]*)\}/.exec(narrow);
  assert.ok(cleared, 'the nested containers never give up their own padding');
  assert.match(cleared[1], /padding-left:\s*0/, 'a nested container still adds to the gutter');
  assert.match(cleared[1], /margin-left:\s*0/, 'a nested container still adds a margin');

  // And nothing may re-pad them afterwards, which is what happened once.
  const dupes = (narrow.match(/\.tools \{[^}]*padding-left:\s*18px/g) || []).length;
  assert.strictEqual(dupes, 0, 'a later rule pads .tools again, so its contents will not line up');
});

test('the day count sits with the status pill, on the heading line', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  const days = /\.wrow \.days \{([^}]*)\}/.exec(narrow);
  const stc = /\.wrow \.stc\s+\{([^}]*)\}/.exec(narrow);
  assert.ok(days && stc, 'no phone rules for the day count and the status pill');
  // Row 1 for both: the day count used to be centred against a two-line
  // description on a line of its own.
  assert.match(days[1], /grid-area:\s*1 \//, 'the day count is not on the heading line');
  assert.match(stc[1], /grid-area:\s*1 \//, 'the status pill is not on the heading line');
  assert.match(days[1], /justify-self:\s*end/, 'the day count is not aligned right');
  assert.match(stc[1], /justify-self:\s*end/, 'the status pill is not aligned right');
});

test('everything you can press is at least 44px on a phone', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)[1];

  /* v21's own `.wbtn` is about 31px and its `.tab` about 34. That is fine for
     a mouse on a design file and too small for a thumb, so this is the one
     place the phone layer deliberately departs from v21's metrics. */
  const rule = /([^{}]*)\{[^}]*min-height:\s*44px/.exec(narrow);
  assert.ok(rule, 'nothing in the phone layer sets a 44px minimum');
  for (const sel of ['.wbtn', '.sortb', '.lgb', '.ib', 'select']) {
    assert.ok(rule[1].includes(sel), sel + ' is not covered by the 44px minimum');
  }
  assert.match(narrow, /\.tab \{[^}]*min-height:\s*44px/, 'the villa detail tabs are still 34px');
  assert.match(narrow, /a\.wrow \{[^}]*min-height:\s*44px/, 'a row that is a link has no minimum height');
});

test('amounts are right-aligned, tabular, and never break mid-value', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  const amt = /\.wrow \.amt\s+\{([^}]*)\}/.exec(narrow);
  assert.ok(amt, 'no phone rule for the amount cell');
  assert.match(amt[1], /text-align:\s*right/, 'amounts are not right-aligned');
  assert.match(amt[1], /white-space:\s*nowrap/, 'an amount may break mid-value');
  assert.match(amt[1], /tabular-nums/, 'amounts do not line up digit for digit down the column');

  /* Status, day count and amount all sit in the same right-hand column, one
     under the other. The day count used to get a line of its own across the
     row, right-aligned against nothing. */
  assert.match(amt[1], /justify-self:\s*end/, 'the amount is not aligned to the right edge');
  assert.match(amt[1], /grid-area:\s*2 \/ 2 \/ 3 \/ 4/,
    'the amount does not span to the right edge, so it floats in the middle of the row');
});

test('the phone list is v21\'s, not a table in disguise', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  // The list is the page: no panel border around it.
  assert.match(narrow, /\.wl \{[^}]*border:\s*0/, 'the worklist is still a bordered panel on a phone');
  // The wrapper is dropped so the meta line can use the full width.
  assert.match(narrow, /\.wrow \.mid \{[^}]*display:\s*contents/,
    'the row wrapper still traps the meta line in one column');
  /* Every list row is a card, in every tab and for all three roles. A flat row
     reads as loose text once the desktop table's columns are gone: there is no
     left edge for the eye to run down. */
  const card = /\n  \.wrow \{([^}]*)\}/.exec(narrow);
  assert.ok(card, 'there is no phone rule for a list row');
  assert.match(card[1], /border:\s*1px solid var\(--hair\)/, 'a list row has no card border');
  assert.match(card[1], /border-radius:\s*12px/, 'a list row is not v21\'s 12px radius');
  assert.match(card[1], /background:\s*var\(--paper\)/, 'a list row has no card background');
  assert.match(card[1], /padding:\s*14px 16px/, 'a list row has no card padding');
  /* No horizontal margin of its own: the gutter belongs to one container, and
     a margin here is exactly how the card ended up inset further than the
     label above it. */
  assert.match(card[1], /margin:\s*0 0 10px/, 'the card sets its own horizontal margin again');

  /* And the heading is one heading. The villa came out at 12.5px and the stage
     at 13px, so they read as two labels with a dot floating between them. */
  const head = /\.wrow \.id, \.wrow \.mid \.rt \{([^}]*)\}/.exec(narrow);
  assert.ok(head, 'the villa and the stage are not typed as one heading');
  assert.match(head[1], /font:\s*500 14\.5px\/20px/, 'the heading is not one size');
});

test('the app bar is opaque, full width, and content passes under it', async () => {
  const css = await (await get('/app.css')).text();
  const bar = /\.appbar \{([^}]*)\}/.exec(css);
  assert.ok(bar, 'no app bar rule');
  assert.match(bar[1], /position:\s*sticky/, 'the app bar is not sticky, so it scrolls away');
  assert.match(bar[1], /background:\s*var\(--paper\)/, 'the app bar is not painted, so content shows through it');
  assert.match(bar[1], /z-index:\s*\d+/, 'the app bar has no stacking order');
  assert.ok(!/\.appbar \{[^}]*position:\s*fixed/.test(css),
    'a fixed bar would sit on top of the first row of content');

  /* The width is the part that actually went wrong, and asserting `sticky` and
     an opaque background proved nothing about it. plint.css puts
     `display:flex; align-items:center` on the BODY to centre v21's phone mock,
     which makes every direct child shrink to its own content: the bar rendered
     280px wide in a 375px viewport, a floating pill with the page scrolling
     past on both sides. Both of these are needed - `width` alone loses to the
     flex item's default cross-axis sizing. */
  assert.match(bar[1], /align-self:\s*stretch/,
    'the app bar is a flex item on a centring body, so it will shrink to its content');
  assert.match(bar[1], /width:\s*100%/, 'the app bar does not claim the full width');
});

test('nothing is laid out with a width the page cannot override', async () => {
  /* The ageing histogram shipped with `style="height:88px"` on each bar. An
     inline height beats every rule, so on a phone the sparkline became four
     slabs half the screen wide. Heights travel as a custom property now. */
  const h = await body('/office', 'office');
  const bars = h.match(/class="agebar[^"]*" style="([^"]*)"/g) || [];
  assert.ok(bars.length > 0, 'no ageing bars rendered');
  for (const b of bars) {
    assert.ok(!/style="[^"]*height:/.test(b), 'an ageing bar still carries an inline height: ' + b);
    assert.match(b, /--h:/, 'an ageing bar does not pass its height as a property: ' + b);
  }
});
