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
  engineer: ['/engineer'],
  office:   ['/office', '/office/sanctions'],
};
/* How many destinations each role has, and therefore what navigation it gets.
   Four or fewer is a tab bar; more would be a menu button. Nothing here has
   more than two, so nothing here has a menu button. */
const DESTINATIONS = { buyer: 2, engineer: 1, office: 2 };

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
    // Nothing here has more than four, so nothing should have grown a menu.
    assert.ok(DESTINATIONS[role] <= 4, role + ' now has more than four sections: it needs a menu');
    assert.ok(!/class="ab-menu"/.test(h), role + ' rendered a menu button it does not need');
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

test('the worklists can stop being tables', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(narrow, 'no narrow-screen block in app.css');
  assert.match(narrow[1], /\.whead\s*\{\s*display:\s*none/, 'column headings survive as cards');
  assert.match(narrow[1], /\.wrow\s*\{[\s\S]*?display:\s*grid/, 'rows do not reflow to cards');
  assert.match(narrow[1], /\.uprow/, 'the forms keep their fixed field widths');
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
