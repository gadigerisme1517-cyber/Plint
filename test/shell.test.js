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

/* THE HEAD OFFICE IS ITS OWN SYSTEM.

   The buyer's and the engineer's screens are v21: plint.css and app.css,
   Instrument Sans, the app bar and the phone's tab bar. The head office
   console is inbell_office_dashboard.html's system: office.css alone, Manrope
   and Inter, a 250px sidebar and an off-canvas drawer under 860px. Neither
   stylesheet is ever loaded beside the other.

   So a test about the shell has to say which shell it means. This is the two
   that share v21's; the office is checked against its own. */
const PHONE_ROLES = ['buyer', 'engineer'];

/* How many destinations each role has, and therefore what navigation it gets.

   Up to five is v21's bottom bar - `.nav five` is a shape v21 designed and
   five fits a phone. Above five it becomes a menu button, which is the head
   office: fifteen destinations in nine groups are not a bar at any width. */
const BAR_FITS = 5;
const DESTINATIONS = { buyer: 5, engineer: 5, office: 22 };

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

/**
 * Every rule at a breakpoint, from every block that declares it.
 *
 * These tests used to read `/@media \(max-width: 900px\) \{...\}/` and take the
 * first block the regex found. A stylesheet may declare a breakpoint as many
 * times as it likes, and three separate times in this project adding a second
 * block silently moved a rule out of what a test was reading - the test went
 * red, the rule was fine, and the half hour went on the wrong thing. Read all
 * of them, joined.
 */
function atWidth(css, query) {
  // Nothing in a media query is a regex metacharacter, so nothing to escape.
  const re = new RegExp('@media \\(' + query + '\\) \\{([\\s\\S]*?)\\n\\}', 'g');
  const blocks = [...css.matchAll(re)].map(m => m[1]);
  assert.ok(blocks.length, 'no @media (' + query + ') block in the stylesheet');
  return blocks.join('\n');
}

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
    /* `.bar` is v21's own prototype chrome and app.css hides it outright, so
       nothing drawn on v21's stylesheet may use the name. The head office is
       not drawn on v21's stylesheet: `.bar` there is the reference's progress
       bar, a real component with a real rule, and office.css never loads
       beside plint.css. The name is only a collision inside one system. */
    if (role !== 'office') {
      assert.ok(!/class="bar"/.test(h), role + ' ' + p + " still renders the prototype's chrome");
    }
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

test('no screen is ever written to the browser cache', async () => {
  /* Every page here is server-rendered behind a session cookie and is one
     person's financial position. These went out with no `cache-control` at
     all, which does not mean "do not store": with no directive, no `expires`
     and no `last-modified`, a browser may apply its own heuristic and reuse
     the response without asking again. Chrome on Android does.

     It reached us as a screenshot of a layout this stylesheet cannot produce
     at any width - a phone showing the bottom tab bar and the breadcrumb at
     once, which stopped being possible several deploys earlier. The page had
     come from the phone's own HTTP cache and named a stylesheet hash served
     `max-age=604800`, so the whole shell was frozen and no deploy could reach
     it, because the device never asked. */
  for (const [role, path] of everyScreen()) {
    const r = await get(path, role);
    const cc = r.headers.get('cache-control');
    assert.strictEqual(cc, 'no-store',
      role + ' ' + path + ' is cacheable: cache-control is ' + JSON.stringify(cc));
  }
  // The sign-in page too: it is the one that carries the sign-in form.
  assert.strictEqual((await get('/')).headers.get('cache-control'), 'no-store',
    'the sign-in page is cacheable');
});

// ------------------------------------------------------------- app bar

test('every screen carries the chrome its own system defines', async () => {
  /* Two systems, two answers. The buyer and the engineer are on v21 and carry
     its app bar. The head office console is the reference's: a 250px sidebar
     that is sticky on a desktop and slides in under 860px, with a `.topbar`
     holding the hamburger at that width. Asking for an app bar on an office
     screen is asking the wrong question of the wrong system. */
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    if (role === 'office') {
      assert.match(h, /<aside class="side" id="side">/, p + ' has no sidebar');
      assert.match(h, /<div class="topbar">/, p + ' has no top bar for narrow widths');
      assert.match(h, /class="ham"/, p + ' has no hamburger');
      assert.ok(!/<header class="appbar">/.test(h), p + " carries v21's app bar as well");
    } else {
      assert.match(h, /<header class="appbar">/, role + ' ' + p + ' has no app bar');
    }
  }
  for (const p of ['/', '/offline']) {
    assert.match(await body(p), /<header class="appbar">/, p + ' has no app bar');
  }
});

test('a signed-in person always has a way out, and is told who they are', async () => {
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    /* Rendered on every screen, but hidden under 480px: the head office's
       titles are long enough that the bar was clipping the screen name and
       the signed-in name at once. Two half-labels tell you less than one
       whole one. It is in the markup, so it returns the moment there is room
       and a screen reader has it at every width. */
    if (role === 'office') {
      /* The reference's `.urow` at the foot of the sidebar: initials, name,
         and the button that ends the session. A POST, not a link, because
         signing out is a write. */
      assert.match(h, /class="uinfo"><b>/, p + ' does not say who is signed in');
      assert.match(h, /action="\/logout"[\s\S]{0,120}class="sout"/, p + ' has no sign out');
    } else {
      assert.match(h, /class="ab-who"/, role + ' ' + p + ' does not say who is signed in');
      assert.match(h, /class="ab-out" href="\/logout"/, role + ' ' + p + ' has no sign out');
    }
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

    if (role === 'office') {
      /* Twenty-two destinations in 375px is seventeen pixels each. The office
         console does not have a bar at any width: it has the reference's
         sidebar, which is sticky on a desktop and slides in from the left
         under 860px behind `.scrim2`. */
      assert.strictEqual(tabs, '',
        role + ' has ' + DESTINATIONS[role] + ' destinations squeezed into a bar');
      assert.match(h, /class="ham"/, role + ' has no way to open its navigation on a phone');
      assert.match(h, /class="scrim2"/, role + ' has no scrim behind the drawer');
      const items = (h.match(/class="item /g) || []).length;
      assert.strictEqual(items, DESTINATIONS[role],
        role + ' draws ' + items + ' nav items for ' + DESTINATIONS[role] + ' destinations');
    } else if (DESTINATIONS[role] > 1) {
      assert.ok(tabs, role + ' has ' + DESTINATIONS[role] + ' sections and no tab bar');
      assert.strictEqual(count, DESTINATIONS[role],
        role + ' has ' + DESTINATIONS[role] + ' sections but ' + count + ' tabs');
      assert.match(tabs, /--tabs:/, role + ': the tab bar does not size its own columns');
      assert.ok(!/class="ab-menu"/.test(h), role + ' rendered a menu button it does not need');
    } else {
      /* One section is not navigation. A bar with a single tab in it is
         furniture that never does anything. */
      assert.strictEqual(tabs, '', role + ' has one section and still gets a tab bar');
    }
  }
});

test('the current screen is marked in the navigation', async () => {
  for (const [role, paths] of Object.entries(SCREENS)) {
    if (DESTINATIONS[role] < 2) continue;
    for (const p of paths) {
      const h = await body(p, role);
      /* The tab bar and the buyer's app-bar links use `aria-current`; the head
         office's grouped sidebar marks the open destination the same way. A
         screen behind a destination rather than being one - a buyer file, a
         question thread, the phone menu - marks nothing, and says so by being
         listed here. */
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
    /* iOS reads this, not the manifest, when someone adds to the home screen.
       Without it the buyer's villa page opens in Safari's chrome. */
    assert.match(h, /name="apple-mobile-web-app-capable" content="yes"/,
      role + ' ' + p + ': iOS will not install this as a standalone app');
    assert.match(h, /navigator\.serviceWorker\.register\('\/sw\.js'\)/,
      role + ' ' + p + ': the worker is named but never registered');
  }
});

test('the install belongs to the application, not to one role', async () => {
  /* `start_url` decides what an installed icon opens. Anything narrower than
     "/" - "/engineer", say - installs one role's app on everybody's phone;
     "/" lands on the redirect that reads the session and sends each role to
     its own home, which is the only reason one install serves three. */
  const man = JSON.parse(await (await get('/manifest.webmanifest')).text());
  assert.strictEqual(man.start_url, '/', 'start_url is one role\'s screen');
  assert.strictEqual(man.scope, '/', 'the scope does not cover every role');
  assert.strictEqual(man.display, 'standalone', 'the app does not ask to be installed');

  for (const role of Object.keys(ROLES)) {
    const r = await get('/', role);
    assert.strictEqual(r.status, 302, role + ': start_url does not redirect a signed-in person');
    const to = r.headers.get('location');
    assert.ok(to && to !== '/', role + ': start_url redirects nowhere');
    assert.strictEqual((await get(to, role)).status, 200,
      role + ': the installed app would open on ' + to + ', which does not load');
  }

  /* Every screen links a content-addressed stylesheet, and there are exactly
     two of them across the product: v21's, which the buyer and the engineer
     share, and the head office's own. A third would mean a role had quietly
     grown a stylesheet of its own again. */
  const sheets = new Set();
  for (const [role, p] of everyScreen()) {
    const m = (await body(p, role)).match(/\/(?:app|office)\.[a-f0-9]+\.css/);
    assert.ok(m, role + ' ' + p + ': links no content-addressed stylesheet');
    sheets.add(m[0]);
  }
  assert.strictEqual(sheets.size, 2,
    'the product links ' + sheets.size + ' shells: ' + [...sheets].join(', '));

  /* And both are in the worker's shell, or an install made in one role
     precaches a stylesheet the other never gets offline. */
  const sw = await (await get('/sw.js')).text();
  for (const s of sheets) {
    assert.ok(sw.includes("'" + s + "'"), s + ' is not precached by the service worker');
  }
});
test('the stylesheet parses: no rule is stranded in prose', async () => {
  /* Every other test in this file matches the text of app.css, and text cannot
     tell a live rule from a dead one. A comment that was closed twice - a
     terminator left behind from an earlier edit and a second one at the end
     of the new paragraph - left five lines of English between two rules. The
     browser read that English as the start of a selector, ran on to the next
     `{`, and dropped `.wrow .mid p.s` with it. Every text assertion stayed
     green, because the rule was still in the file; the detail line auto-placed
     itself into the day-count column on every card in the application.

     So this reads the file the way a parser does. Strip the comments, then
     what is left has to be nothing but `selector { declarations }` and
     at-rules - any stray word between rules is a rule somebody has lost. */
  for (const name of ['app.css', 'plint.css']) {
    const css = await (await get('/' + name)).text();

    // Comments out, strings out (a `content:` may hold a brace or a slash).
    let bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
                  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
                  .replace(/'(?:[^'\\]|\\.)*'/g, "''");

    // An unclosed or twice-closed comment shows up here first.
    assert.ok(!bare.includes('*/'), name + ' has a stray comment terminator');
    assert.ok(!bare.includes('/*'), name + ' has an unclosed comment');

    /* Walk it: outside a block, text up to the next `{` is a selector or an
       at-rule prelude. A selector may not contain a `;` or a `}`, and it may
       not read as a sentence - the giveaway is a full stop followed by a
       space, which no selector has and every dropped paragraph does. */
    let depth = 0, buf = '', line = 1;
    for (const ch of bare) {
      if (ch === '\n') line++;
      if (ch === '{') {
        if (depth === 0) {
          const sel = buf.trim().replace(/\s+/g, ' ');
          assert.ok(!/[;}]/.test(sel),
            name + ': a selector near line ' + line + ' contains a ; or } - ' +
            'a rule above it was probably swallowed: ' + JSON.stringify(sel.slice(0, 90)));
          assert.ok(!/\.\s/.test(sel) && !/\,\s\w+\s\w+\s\w+\s\w+/.test(sel),
            name + ': prose is being read as a selector near line ' + line + ': ' +
            JSON.stringify(sel.slice(0, 90)));
        }
        depth++; buf = '';
      } else if (ch === '}') {
        depth--; buf = '';
        assert.ok(depth >= 0, name + ' closes a block it never opened, near line ' + line);
      } else if (depth === 0) {
        buf += ch;
      }
    }
    assert.strictEqual(depth, 0, name + ' ends inside an unclosed block');
    assert.strictEqual(buf.trim(), '', name + ' ends with text outside any rule');
  }
});

test('the rules the phone layout depends on are rules, not prose', async () => {
  /* The handful whose loss is silent: they change where something sits rather
     than whether it is drawn, so the page still renders and simply renders
     wrong. Each is asserted elsewhere by text; here they are counted as
     declarations inside a block, which is what the text assertions cannot see. */
  const css = await (await get('/app.css')).text();
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const sel of ['.wrow .mid p.s', '.wrow .amt', '.wrow .days', '.wrow .stc',
                     '.mhead, .mbody, .scroll', '.wbtn, .sortb']) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*\\}');
    assert.match(bare, re, sel + ' is not a live rule once the comments are gone');
  }
});

test('no screen prints a number it could not work out', async () => {
  /* `M.money(undefined)` is "\u20B9NaN", and it renders as confidently as any
     other figure. It happened: three screens read `gross_paise` off a demand
     and the column is `total_paise`, so every settled demand on the buyer's
     Money screen said \u20B9NaN. The office screen that joined the same column
     failed loudly with a 500 and that is how it was found - the buyer's did
     not fail at all, because JavaScript is happy to format a NaN.

     This is the cheap guard: no screen in the application, for any role, may
     contain NaN, undefined, null or [object Object] in its rendered text. */
  for (const [role, p] of everyScreen()) {
    const h = await body(p, role);
    for (const bad of ['NaN', 'undefined', '[object Object]', '>null<']) {
      assert.ok(!h.includes(bad),
        role + ' ' + p + ' renders ' + JSON.stringify(bad) + ' to the reader');
    }
  }
});

test('a phone has one scroll, not three nested ones', async () => {
  /* This one renders perfectly and only breaks under a finger, so nothing that
     looks at the page can see it.

     v21's `.desk` is a rounded card holding a fixed sidebar beside a scrolling
     pane: `overflow: hidden` on the card, `overflow-y: auto` on `.mbody`, and
     a min-height so the card keeps its shape. Right for that card on a
     monitor. On a phone there is no card and no sidebar, and it left three
     nested scroll containers around a document that was the thing actually
     scrolling - neither inner one had any overflow of its own, so a touch
     starting inside them scrolled nothing and the gesture had to be repeated.
     It was reported as scrolling being broken, which is what it feels like. */
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 900px');

  for (const [sel, why] of [['\\.desk', 'the card clips the page'],
                            ['\\.mbody', 'the body pane is its own scroller']]) {
    const rule = new RegExp(sel + '\\s*\\{[^}]*overflow[^:]*:\\s*visible').test(narrow);
    assert.ok(rule, 'on a phone ' + why + ': it never gives up its overflow');
  }
  /* And the card's min-height with it, or a short menu still reserves 86vh of
     card and the page scrolls past its own content. */
  assert.match(narrow, /\.desk\s*\{[^}]*min-height:\s*0/,
    'the desktop card keeps its minimum height on a phone');
});

test('the office navigation is a drawer on a phone and a column on a desktop', async () => {
  /* The reference's sidebar: 250px, white, sticky beside the content, and
     under 860px it is `position: fixed` at `translateX(-100%)` with `.scrim2`
     behind it. The hamburger in `.topbar` slides it in.

     It replaced a `:target` layer that worked with no JavaScript. This one
     needs a script, which is the reference's own answer and the price of
     matching it - so the script is inline in the document rather than in a
     file, and the drawer is the only thing in this console that needs it. */
  const h = await body('/office', 'office');
  assert.match(h, /<aside class="side" id="side">/, 'no sidebar on an office screen');
  assert.match(h, /<div class="scrim2" id="scrim2"><\/div>/, 'no scrim behind the drawer');
  assert.match(h, /<button class="ham" id="ham"/, 'no hamburger to open it');
  assert.match(h, /getElementById\('ham'\)\.addEventListener\('click'/,
    'the hamburger is not wired to anything');
  assert.match(h, /classList\.add\('open'\)/, "the drawer never gets the reference's .open class");

  /* Every office screen carries it, or the navigation is missing from wherever
     you happen to be standing - which is every screen but one. */
  for (const p of ['/office/chase', '/office/rera', '/office/help']) {
    assert.match(await body(p, 'office'), /<aside class="side" id="side">/,
      p + ' has no way into the other twenty-one');
  }

  // The old menu URL still lands somewhere useful.
  const moved = await get('/office/menu', 'office');
  assert.strictEqual(moved.status, 302, '/office/menu is still a screen of its own');
});
test('the menu layer is hidden until it is asked for, and never on a desktop', async () => {
  const css = await (await get('/app.css')).text();
  assert.match(css, /\.drawer \{[^}]*visibility:\s*hidden/,
    'the layer is on the screen before anybody opens it');
  assert.match(css, /\.drawer:target \{[^}]*visibility:\s*visible/,
    'nothing opens the layer');
  /* `visibility`, not `display`, so the slide and the fade can be transitions
     and so it is out of the accessibility tree while it is shut. */
  assert.ok(!/\.drawer \{[^}]*display:\s*none/.test(css),
    'the layer is hidden with display, which cannot animate');
  /* And on a monitor the sidebar is already the menu, so `#menu` in a
     bookmarked URL must not black out the screen. */
  const wide = [null, atWidth(css, 'min-width: 901px')];
  assert.ok(wide && /\.drawer:target \{[^}]*visibility:\s*hidden/.test(wide[1]),
    'a bookmarked #menu opens the layer over a desktop screen that already lists all fifteen');
});

test('the office sidebar names every destination, in its five groups', async () => {
  const h = await body('/office', 'office');
  const side = (/<nav class="nav">[\s\S]*?<\/nav>/.exec(h) || [''])[0];
  assert.ok(side, 'the sidebar has no nav in it');

  /* Every group heading and every label, so a destination cannot be added to
     the route table and quietly left out of the only way to reach it. */
  for (const g of ['Money stuck', 'The site', 'Buyers', 'Compliance', 'Setup']) {
    assert.ok(side.includes('>' + g + '<'), 'the sidebar is missing the group "' + g + '"');
  }
  for (const label of ['Dashboard', 'Ready to send', 'At the lender', 'Lender queries',
                       'Sanction not recorded', 'Stages', 'Evidence certificates',
                       'Site gone quiet', 'Sign-off queue', 'Villas', 'Documents',
                       'Choices', 'Visits', 'Warranty', 'RERA filing', 'Escrow drawdown',
                       'After possession', 'Payment schedule', 'Lenders', 'Logins',
                       'Settings', 'Help']) {
    assert.ok(side.includes('>' + label + '</span>'), 'the sidebar is missing "' + label + '"');
  }

  /* An icon each, which is what a destination is recognised by after the
     second week, and one line each. */
  const icons = (side.match(/<svg /g) || []).length;
  assert.strictEqual(icons, 22, 'the sidebar draws ' + icons + ' icons for twenty-two destinations');
  const items = (side.match(/class="item /g) || []).length;
  assert.strictEqual(items, 22, 'the sidebar draws ' + items + ' items');

  /* The badges are counts of work, so a badge that is not a number, or one on
     a destination with nothing waiting, is noise. */
  const badges = [...side.matchAll(/class="badge">(\d+)</g)].map(m => Number(m[1]));
  assert.ok(badges.length >= 3, 'only ' + badges.length + ' destinations carry a count');
  for (const b of badges) assert.ok(b > 0, 'a badge reads ' + b + ', which is not work waiting');
});
test('one platform: the dashboards are composed, not drawn', async () => {
  /* The critique that produced this test: "instead of doing from the rules,
     you are picking each dashboard separately". It was right. There were two
     copies of a `hero` helper and nine hand-written `.mhead` blocks - eleven
     places drawing the same header - so "the summary" meant something slightly
     different on every screen, and a change to the design had to be made
     eleven times and remembered a twelfth.

     The rule survives the head office moving to its own visual system: what
     changed is which vocabulary it composes from, not that it composes. The
     buyer and the engineer compose from ./ui, which is v21's furniture. The
     office composes from its own helpers, which are the reference's. Neither
     writes a header by hand. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  for (const f of ['src/screens/buyer.js', 'src/screens/engineer.js']) {
    assert.match(src(f), /require\('\.\/ui'\)/,
      f + ' does not use the shared dashboard furniture');
    const drawn = (src(f).match(/class="mhead"/g) || []).length;
    assert.strictEqual(drawn, 0, f + ' draws ' + drawn + ' headers of its own');
  }

  /* The office defines each piece once and calls it. A screen there that
     writes `<div class="head">` by hand is the same mistake in a new alphabet. */
  const off = src('src/screens/office.js');
  for (const helper of ['const head =', 'const kpis =', 'function table(', 'const card =',
                        'const row =', 'const pill =', 'const btn =', 'const board =']) {
    assert.ok(off.includes(helper), 'the office console has no shared ' + helper.split(/[ (]/)[1]);
  }
  const handHead = (off.match(/<div class="head">/g) || []).length;
  assert.strictEqual(handHead, 1,
    'the office console writes ' + handHead + ' headers by hand; there is one, inside head()');
  const handKpi = (off.match(/<div class="kpi">/g) || []).length;
  assert.strictEqual(handKpi, 1, 'the office console draws a KPI outside kpis()');
});
test('urgency is visible, and it is the same urgency everywhere', async () => {
  /* "They are just not bleeding into the background because of the design, and
     they are getting ignored." A screen where a stuck crore and a settled
     stage are the same weight of grey is a screen where the crore is scrolled
     past. So a figure carries a tone, and the tone is not decoration: it comes
     off the same thresholds the day-count pills use, so a summary and the rows
     under it can never disagree about what late means. */
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/screens/ui.js'), 'utf8');
  assert.match(ui, /require\('\.\/rows'\)/,
    'the summary invents its own thresholds instead of using the row builder\'s');
  assert.match(ui, /AGE\.overdue/, 'the tone is not tied to the overdue threshold');
  assert.match(ui, /AGE\.ageing/, 'the tone is not tied to the ageing threshold');

  const css = await (await get('/app.css')).text();
  for (const sel of ['\\.summary \\.fig\\.hot', '\\.stat \\.n\\.hot']) {
    assert.ok(new RegExp(sel + '[^{]*\\{[^}]*var\\(--hot\\)').test(css),
      'a hot figure is not drawn in the hot colour: ' + sel.replace(/\\\\/g, ''));
  }

  /* The head office says it in the reference's vocabulary rather than v21's:
     `.p-over` on the red ground for a query or an overdue stage, `.p-due` on
     amber for something waiting, `.badge` in the sidebar for a count of work
     that has stopped. Same rule - urgency is a colour with a threshold behind
     it - in the alphabet that console is drawn in. */
  const h = await body('/office', 'office');
  const tiles = (h.match(/class="kpi"/g) || []).length;
  assert.strictEqual(tiles, 4, 'the dashboard shows ' + tiles + ' KPIs, not four');
  assert.match(h, /<div class="bar"><span style="width:\d+%"/,
    'the office dashboard does not say how far along it is');

  const office = await (await get('/office.css')).text();
  for (const [cls, token] of [['p-over', '--red'], ['p-due', '--amber'], ['p-paid', '--green']]) {
    assert.ok(new RegExp('\\.' + cls + '\\{[^}]*color:var\\(' + token + '\\)').test(office),
      '.' + cls + ' is not drawn in ' + token);
  }
  /* And a badge only ever appears where there is work waiting. */
  const q = await body('/office/query', 'office');
  assert.ok(/class="pill p-over"/.test(q) || /class="empty"/.test(q),
    'the lender queries screen neither shows an open query nor says there are none');
});

test('nothing on v21 s stylesheet is named after something v21 hides', async () => {
  /* v21 uses `.bar` for the prototype's own chrome and app.css hides it
     outright, so a progress bar called that is `display: none` on every screen
     drawn on that stylesheet. It was, until the frame test caught it, and the
     summary's bar is `.prog` now.

     The head office is not drawn on that stylesheet. `.bar` there is the
     reference's own progress bar with the reference's own rule, and office.css
     never loads beside plint.css, so the name cannot collide. */
  for (const [role, p] of [['engineer', '/engineer'], ['buyer', '/journey']]) {
    const h = await body(p, role);
    assert.ok(!/class="bar"/.test(h), role + ' ' + p + ' uses v21 s hidden chrome class');
  }
  const css = await (await get('/app.css')).text();
  assert.match(css, /\.summary \.prog \{/, 'the progress bar has no rule of its own');

  // And the office's bar is real: it has a rule and it carries a width.
  const office = await (await get('/office.css')).text();
  assert.match(office, /\.bar\{height:9px/, 'the office bar has no rule of its own');
  assert.match(await body('/office', 'office'), /<div class="bar"><span style="width:\d+%"/,
    'the office bar draws nothing');
});
test('the skin is v21 s, and this file does not restate it', async () => {
  /* plint.css is v21 byte for byte, so every colour, every hairline and every
     shadow in the product is already declared there. A second palette in
     app.css is not a skin, it is a fork: two files that will disagree with
     each other the first time either is edited, and the one that wins is
     whichever happens to be later.

     There was one. Warmer ink, warmer greys, a 16px card radius and a diffuse
     shadow, built to a different reference. It is gone, and this holds it
     gone. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/app.css'), 'utf8');
  assert.ok(css.length > 5000, 'read ' + css.length + ' bytes of app.css, not a stylesheet');
  const root = /:root \{[\s\S]*?\n\}/.exec(css);
  assert.ok(root, 'app.css defines no tokens of its own');

  const v21 = fs.readFileSync(path.join(__dirname, '..', 'public/plint.css'), 'utf8');
  const v21root = /:root\{([^}]*)\}/.exec(v21);
  assert.ok(v21root, 'plint.css declares no tokens, so it is not v21');
  const theirs = [...v21root[1].matchAll(/(--[\w-]+):/g)].map(m => m[1]);
  assert.ok(theirs.length > 10, 'only found ' + theirs.length + ' v21 tokens');
  for (const t of theirs) {
    assert.ok(!new RegExp('\\' + t + ':').test(root[0]),
      t + ' is declared again in app.css: v21 already sets it, and two declarations '
      + 'of one token is a fork, not a skin');
  }

  // Comments and the token block itself are not rules.
  const rules = css.replace(root[0], '').replace(/\/\*[\s\S]*?\*\//g, '');

  /* And no hex colour outside the tokens. A hue in a rule is a hue that one
     screen has and the others do not. */
  /* A hex is allowed only where v21 itself types one - `.msg.office` has a
     bare `#C9D9FB` for its border - because copying v21's value is the whole
     point of this pass. Anything else is a hue one screen has and the others
     do not. */
  const hexes = [...rules.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0])
    .filter(h => !v21.includes(h));
  assert.deepStrictEqual(hexes, [],
    'a colour is typed into a rule instead of coming from a token: ' + hexes.join(', '));
});

test('app.css does not overrule a value v21 already sets on a phone', async () => {
  /* THE GUARD THIS PASS EXISTS FOR.

     plint.css is v21 verbatim, so any difference between the built screens and
     the design file is a declaration here landing on a selector v21 also
     styles. This walks every one of them at 375px and fails on anything that
     is not in the list below - and everything in that list is either chrome
     v21 has no equivalent for, or a frame that has to come off before the mock
     can be an application.

     It is a whitelist rather than a count so that adding a divergence is a
     deliberate act with a reason written next to it. */
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
  /* `0 var(--gutter)` and `0 26px` are the same declaration, and so are
     v21's bare `'Instrument Sans'` and the same stack with the fallbacks this
     application adds for a phone that has not loaded the webfont yet. Both are
     normalised or the guard fills with differences that are not differences. */
  const same = v => v.replace(/var\(--gutter\)/g, '26px')
                     .replace(/, system-ui, sans-serif/g, '')
                     .replace('!important', '').trim();
  const at375 = m => {
    if (!m) return true;
    for (const lo of m.match(/min-width:\s*(\d+)px/g) || []) {
      if (Number(lo.match(/\d+/)[0]) > 375) return false;
    }
    for (const hi of m.match(/max-width:\s*(\d+)px/g) || []) {
      if (Number(hi.match(/\d+/)[0]) < 375) return false;
    }
    return true;
  };
  const parse = css => {
    const out = [];
    const walk = (text, media) => {
      let i = 0;
      while (i < text.length) {
        const at = text.indexOf('@', i), brace = text.indexOf('{', i);
        if (brace < 0) break;
        if (at >= 0 && at < brace) {
          let d = 0, k = text.indexOf('{', at);
          if (k < 0) break;
          for (let j = k; j < text.length; j++) {
            if (text[j] === '{') d++;
            else if (text[j] === '}' && --d === 0) { k = j; break; }
          }
          const head = text.slice(at, text.indexOf('{', at)).trim();
          if (head.startsWith('@media')) walk(text.slice(text.indexOf('{', at) + 1, k), head);
          i = k + 1;
          continue;
        }
        const sel = text.slice(i, brace).trim();
        const close = text.indexOf('}', brace);
        if (close < 0) break;
        const decls = {};
        for (const d of text.slice(brace + 1, close).split(';')) {
          const c = d.indexOf(':');
          if (c < 0) continue;
          decls[d.slice(0, c).trim().toLowerCase()] = d.slice(c + 1).trim();
        }
        if (sel && Object.keys(decls).length) out.push([media, sel, decls]);
        i = close + 1;
      }
    };
    walk(strip(css), null);
    return out;
  };

  const dir = path.join(__dirname, '..', 'public');
  const v21 = parse(fs.readFileSync(path.join(dir, 'plint.css'), 'utf8'));
  const app = parse(fs.readFileSync(path.join(dir, 'app.css'), 'utf8'));

  const theirs = new Map();
  for (const [media, sel, decls] of v21) {
    if (!at375(media)) continue;
    for (const one of sel.split(',').map(s => s.trim())) {
      for (const p of Object.keys(decls)) theirs.set(one + '|' + p, decls[p]);
    }
  }

  /* Every selector below is either chrome v21 does not have, or the frame
     coming off. The reason is the point of the entry. */
  const allowed = new Set([
    // v21 wraps every view in a 392px card on a slate. All of it goes.
    'body|background', '.wrap|max-width', '.bar|display', '.sysbar|display',
    '.stagearea|display', '.phone|max-width', '.phone|height', '.phone|border-radius',
    '.phone|box-shadow', '.phone|overflow', '.phone.wide|max-width', '.phone.wide|height',
    '.phone.wide|border-radius', '.desk|border-radius', '.desk|min-height',
    '.desk|overflow', '.desk|display', '.scroll|overflow-y', '.mbody|flex',
    '.main|min-height', '.topbar|display', '.side|display',
    // The application scrolls the document, not three boxes inside it.
    '.wl|padding', '.wl|margin-bottom', '.wl|background', '.wl|border',
    '.wl|border-radius', '.wl|box-shadow', '.wl|overflow',
    // The gutter moves from the shell onto the block, which is where v21 has
    // it - `.top`, `.blk`, `.lede` are padded and the scroller is not.
    '.mhead|padding', '.mbody|padding', '.blk|padding', '.lede|padding',
    '.tools|padding', '.top|padding',
    // The row is v21's `.item` rather than v21's `.wrow`, because v21's phone
    // list is `.item` and this markup has one row component for both.
    '.wrow|display', '.wrow|align-items', '.wrow|gap', '.wrow|padding',
    '.wrow|border-bottom', '.wrow|border-radius', '.wrow|background',
    '.wrow .id|font', '.wrow .id|display', '.wrow .days|font-size', '.wrow .days|color',
    '.wrow .amt|font', '.wrow .amt|text-align', '.wrow .mid p|margin-top',
    '.wrow .mid p.s|margin-top', '.wrow .mid|flex',
    // The toolbar is a card in the desk and there is no desk on a phone.
    '.tools|border', '.tools|background', '.tools|border-radius', '.tools|margin-bottom',
    '.tools|gap',
    // The header. v21's `.hstrip`/`.kpi`/`.pgt` belong to the desk; on a phone
    // the same three pieces are `.lede`'s k, mega and cap.
    '.hstrip|align-items', '.pgt|color', '.kpi|flex-direction', '.kpi|align-items',
    '.kpi|gap', '.kpin|font', '.kpin|letter-spacing',
    // Controls that have to be reachable, or fit, at 375px.
    '.ib|display', '.tab|padding', '.tabs|gap', '.lgrid|grid-template-columns',
    '.agebars|height', '.agebars|gap', '.msg|max-width',
    // The desktop, which v21 has no design for at all.
    '.wbtn|padding', '.wbtn|font', '.wbtn|border-radius',
    '.sortb|padding', '.sortb|font', '.sortb|border-radius', '.act|border-radius',
    /* The desk table's column headings. There are no columns on a phone. */
    '.whead|display',
    /* `--hair-2` is the ground v21 puts behind the DESK, because it is the
       ground a card sits on. There are no cards on a phone: v21's phone is
       `.phone { background: var(--paper) }` from the brand row to the tab
       bar, with hairlines doing all of the separating. */
    '.desk|background', '.main|background', '.mbody|background',
    /* v21's desk gives the trailing cells fixed widths - days 48px, amount
       92px, action 78px - because it is a table. v21's phone row is `.item`
       and has none of them, so they size to their content. */
    '.wrow .days|flex', '.wrow .amt|flex', '.wrow .actc|flex',
    /* `.pgt` is the desk's page title, 600 17px/22px. On a phone the same
       words are the label above the figure, which is v21's `.lede .k`. */
    '.pgt|font', '.pgt|letter-spacing',
  ]);

  /* And `.phone.wide` in full. v21 only ever puts `wide` on its desktop mock,
     so its whole rule set is a desktop one with a single responsive line in
     it. This markup carries `wide` at every width - it is what stops the
     buyer's screen being a 392px card in the middle of a monitor - which
     brought 48px side paddings and 76px figures down onto real phones. Below
     900px those are put back to v21's own PHONE values, so every line here is
     v21 overriding v21. */
  const wideMock = k => k.startsWith('.phone.wide');

  const bad = [];
  for (const [media, sel, decls] of app) {
    if (!at375(media)) continue;
    for (const one of sel.split(',').map(s => s.trim())) {
      for (const [p, v] of Object.entries(decls)) {
        const key = one + '|' + p;
        if (!theirs.has(key) || allowed.has(key) || wideMock(key)) continue;
        if (same(theirs.get(key)) === same(v)) continue;
        bad.push(key + ' -> v21 says ' + theirs.get(key) + ', this says ' + v);
      }
    }
  }
  assert.deepStrictEqual(bad, [],
    'app.css overrules v21 at 375px without saying why:\n  ' + bad.join('\n  '));
});
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

  /* And it accounts for the whole project. Every blocked stage carries exactly
     one holder, so the four column counts must sum to the number of villas
     that have something blocked - and that, in this seed, is all of them. A
     column silently dropping rows is the other way this view dies. */
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

  /* The screen says so in words too, so a reader can check it without opening
     the register. */
  assert.match(h, new RegExp(summed + ' of ' + total + ' villas have a stage blocked'),
    'the board does not say how much of the project it accounts for');

  /* And the pack-state view is kept, not replaced. Both are reachable, and the
     one that answers "who do I chase" is the one you land on. */
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

test('the board is built out of the reference s own classes', async () => {
  /* `.board` of `.col`, each with a `.colh` naming it and counting it, holding
     `.lcard`s. Not a component of this application's invention: the reference
     has this exact shape for its admissions pipeline, and the rule is to build
     out of what is there rather than to add. */
  const h = await body('/office', 'office');
  const board = (/<div class="board">[\s\S]*$/.exec(h) || [''])[0];
  assert.ok(board, 'no board on the dashboard');
  assert.match(board, /<div class="col"><div class="colh"><span class="ctt">/,
    'a column does not carry the reference s heading');
  assert.match(board, /<span class="cnt">\d+<\/span>/, 'a column does not count what is in it');

  /* Every card is a link to the villa it is about. A card you cannot open is
     a picture of work rather than a way into it. */
  const cards = [...board.matchAll(/<a class="lcard" href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(cards.length > 0, 'the board has no cards on it');
  for (const href of cards) {
    assert.match(href, /^\/office\/villa\//, 'a board card links to ' + href);
  }
  /* And each carries a pill saying which state it is in, from the five the
     reference defines and no others. */
  const pills = [...board.matchAll(/class="pill (p-[a-z]+)"/g)].map(m => m[1]);
  assert.ok(pills.length > 0, 'no card says what state it is in');
  for (const c of pills) {
    assert.ok(['p-paid', 'p-due', 'p-over', 'p-accent', 'p-grey'].includes(c),
      c + ' is not one of the five pills');
  }
});
test('the board stacks where there is no room for columns', async () => {
  /* Four columns in 375px is ninety pixels each. The columns are a shape for a
     screen that has the width for them, and below the sidebar's breakpoint the
     page stacks - the same rule that decides the sidebar and the menu. */
  const css = await (await get('/app.css')).text();
  const base = /\n\.board \{([^}]*)\}/.exec(css);
  assert.ok(base, 'the board has no rule of its own');
  assert.match(base[1], /grid-template-columns:\s*1fr/,
    'the board is columnar before it has the width for it');
  assert.match(atWidth(css, 'min-width: 901px'), /\.board \{[^}]*repeat\(var\(--cols/,
    'the board never becomes columns on a screen with the room');

  /* And one tall column must not set the height of the three beside it. */
  assert.match(css, /\.bbody \{[^}]*overflow-y:\s*auto/,
    'a column with forty rows makes the board forty rows tall');
});

test('a screen does not draw a box around nothing', async () => {
  /* One conversation was five boxes: the hero, a card holding only the words
     "Sent.", a card holding only two buttons, the thread, and a card holding
     only the reply field. Three of the five were boxes around nothing.

     Two things caused it. A flash message was built as a `.tools` block, and
     `.tools` draws as a panel on a wide screen - three files each had their
     own copy of that helper. And a way out of a screen was being put in the
     body when the header already has a place for one. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  /* v21's screens only. The head office console reports what a write did as
     the reference's own toast, which is a fixed element outside the page and
     cannot be a card around anything. */
  for (const f of ['src/screens/buyer.js', 'src/screens/engineer.js']) {
    assert.match(src(f), /const flash = UI\.flash;/,
      f + ' has its own flash helper again, which will draw a card around a sentence');
  }
  assert.match(src('src/screens/ui.js'), /class="notice"/,
    'the shared flash is not a line');

  /* A toolbar is never a card, at any width: it holds two buttons. */
  const css = await (await get('/app.css')).text();
  assert.match(css, /\n\.tools \{[^}]*background:\s*none\s*!important/,
    'a toolbar still draws as a panel somewhere');

  /* And a thread is one card. The messages, the box to add to them and the
     way to close it are one conversation, so they are one object.

     Checked on the head office's, which is the reference's `.card`: one `.ch`
     naming it, one `.cb` holding the messages and the reply box, and the ways
     out in `.hacts` beside the heading rather than loose in the body. */
  const h = await body('/office/question/q-b14-w', 'office');
  const cards = (h.match(/<div class="card"/g) || []).length;
  assert.strictEqual(cards, 1,
    'the thread screen draws ' + cards + ' cards for one conversation');
  assert.match(h, /<div class="cb">[\s\S]*<form method="post" action="\/office\/answer"/,
    'the reply box is not inside the card it belongs to');
  const afterHead = h.split('</div></div>').slice(1).join('</div></div>');
  assert.match(h.split('<div class="hero"')[0], /class="hacts"/,
    'the header offers no way out');
  assert.ok(!/class="cb">[\s\S]*?>Villa file</.test(h),
    'the way out is in the body rather than the header');
});

test('a conversation is drawn as a conversation, not as a worklist', async () => {
  /* It was two `wrow` cards: the sender's name as the heading, the message
     demoted to the grey detail line, a status pill reading "buyer" beside it
     and a day count in the age column - a sentence somebody typed, drawn as a
     stage ageing towards a deadline. Reusing the row meant never asking what
     a conversation is.

     The message is the content and everything else is a caption. Mine and
     theirs are told apart by side and by ground rather than by a label. */
  /* The head office is drawn in the reference's vocabulary now, and the
     reference has no chat component at all. Rather than invent one, its thread
     is built from `.row`: the message is the row's `<b>`, which is the content,
     and who said it and when is the `<span>` caption under it. The substance of
     the rule is kept - the sentence is the loudest thing on the line, and
     nothing scores it - in the alphabet that console is drawn in. */
  const off = await body('/office/question/q-b14-w', 'office');
  const thread = (/<div class="ct">The thread<\/div>[\s\S]*?<div class="cb">([\s\S]*?)<form/
    .exec(off) || ['', ''])[1];
  assert.ok(thread, 'the office thread is not on the screen');
  assert.ok(!/class="wrow|class="tr /.test(thread), 'the office thread is a worklist again');
  assert.match(thread, /<div class="rt"><b>[^<]+<\/b><span>/,
    'the office thread demotes the message below the name again');
  assert.ok(!/class="pill/.test(thread), 'a message in the office thread carries a status pill');
  assert.ok(!/class="badge/.test(thread), 'a message in the office thread carries a count');

  /* The buyer's end is v21's, and it keeps v21's bubbles. Pick a thread that
     actually has a message in it: a question nobody has answered yet renders
     the empty line, which proves nothing about how a message is drawn. */
  for (const [role, path] of [['buyer', '/questions']]) {
    const listing = await body(path, role);
    const ids = [...listing.matchAll(/href="\/questions\/([^"]+)"/g)].map(m => m[1]);
    assert.ok(ids.length, role + ': no question to open');
    let h = '';
    for (const id of ids) {
      const page = await body('/questions/' + id, role);
      if (/<div class="msg /.test(page)) { h = page; break; }
    }
    assert.ok(h, role + ': not one of ' + ids.length + ' threads has a message in it');

    /* v21's own markup: `.thread` holding `.msg` bubbles, the message a `<p>`
       and the caption a `.s` inside the bubble under it. Matching v21 here is
       a matter of emitting v21's elements, after which its own rules draw
       them and there is nothing left to keep in step. */
    assert.match(h, /<div class="thread">/, role + ': the thread is not a conversation');
    assert.ok(!/class="wrow/.test(h.split('class="thread"')[1] || ''),
      role + ': the messages are still worklist rows');
    assert.match(h, /<div class="msg (?:me|them)">\s*<p>/,
      role + ': the message is not the content of its own bubble');
    assert.match(h, /<\/p><span class="s">/,
      role + ': who said it is not the caption inside the bubble, the way v21 has it');

    /* No status pill on a person and no age on a sentence. */
    const talk = /<div class="thread">[\s\S]*?<\/div>\s*<form/.exec(h);
    assert.ok(talk, role + ': could not read the conversation');
    assert.ok(!/class="chip/.test(talk[0]), role + ': a message carries a status pill');
    assert.ok(!/class="days/.test(talk[0]), role + ': a message carries an age');

    // And no headline figure: nobody opens a thread to learn it has 2 messages.
    assert.ok(!/class="fig/.test(h), role + ': a conversation has a KPI on it');
    assert.ok(!/class="summary"/.test(h), role + ': a conversation has a summary card');
  }
});

test('a page has one ground, all the way down', async () => {
  /* `.desk` carries the wash and stops where its content stops. On a short
     screen - a thread holding one message - it ended two thirds of the way
     down and the document's own white took over, so one page had a seam
     across it and two backgrounds. The ground belongs to the document. */
  const css = await (await get('/app.css')).text();
  const rule = /\nbody \{[^}]*\}/.exec(css);
  assert.ok(rule, 'nothing paints the document');
  assert.match(rule[0], /background:\s*var\(--hair-2\)/,
    'the document is not painted the same colour as the shell on it');

  const shell = fs.readFileSync(path.join(__dirname, '..', 'public/plint.css'), 'utf8');
  assert.match(/\.desk\{[^}]*\}/.exec(shell)[0], /background:var\(--hair-2\)/,
    'the shell no longer uses --hair-2, so the document is painted the wrong colour');
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

test('the worklists reflow to v21 s rows, not to a table', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = [null, atWidth(css, 'max-width: 720px')];
  assert.ok(narrow, 'no narrow-screen block in app.css');
  assert.match(narrow[1], /\.whead\s*\{\s*display:\s*none/, 'column headings survive as cards');
  /* v21's phone row is `.item`: one flex line, 17px 26px, an 18px gap and a
     hairline under it. It was a three-row grid here - title and pill, then the
     detail, then the money and its button - which is not a shape v21 has. */
  assert.match(narrow[1], /\.wrow \{[\s\S]*?display:\s*flex/, 'rows do not reflow to v21 s row');
  assert.match(narrow[1], /\.uprow/, 'the forms keep their fixed field widths');
  /* The reassign form under a row: a sentence, a picker and a button. Three
     full-width lines is 145px under every row of a six-row list, so the picker
     and the button share a line. The select carries an inline `flex:0 0 220px`
     from the markup, which only `!important` will beat. */
  assert.match(narrow[1], /\.uprow\.reassign \.mid \{[^}]*display:\s*contents\s*!important/,
    'the span around the sentence and the picker is still a box, so the button cannot sit beside them');
  /* Basis 0: with `auto` the picker's flex base is its content width, that
     base plus the button overflowed the line, and the two wrapped before any
     shrinking was considered. */
  assert.match(narrow[1], /\.uprow\.reassign \.mid select\s+\{[^}]*flex:\s*1 1 0%\s*!important/,
    'the picker will wrap the button onto a line of its own unless its flex base is zero');
  assert.match(narrow[1], /\.uprow\.reassign \.mid \.s\s+\{[^}]*flex:\s*1 1 100%/,
    'the sentence does not take its own line, so it will squeeze the picker');
  /* Hooked on a class, not on position. The sanction form is a `.wrow + .uprow`
     too, and it is three text fields that do want the full width - matching by
     position took its Record button to 137px under three full-width boxes. */
  assert.ok(!/\.wrow \+ \.uprow \.wbtn/.test(narrow[1]),
    'the reassign rules still match any form under a row, including the sanction form');
  assert.ok(narrow[1].indexOf('.uprow .mid .fi') < narrow[1].indexOf('.uprow.reassign .mid select'),
    'the reassign rules come before the ones that stack every field full width');

  /* The narrow rule for the histogram must outrank the base rule rather than
     merely differ from it. The first version used the same selector, `.agebar`,
     and the base rule sits later in the file - so at equal specificity the base
     won, the width scaled, the height did not, and the deployed phone view
     still drew four slabs. */
  assert.match(narrow[1], /\.agebars \.agebar\s*\{[^}]*height:\s*calc\(/,
    'the narrow histogram rule is not specific enough to beat the base height');
  const base = /\n\.agebar \{[^}]*height:\s*var\(--h/.exec(css);
  assert.ok(base, 'no base height rule driven by --h');
});
test('the villa and the stage are one run of text, not two cells', async () => {
  /* Same font size and weight was not enough. They were separate grid cells
     with a 10px gap and a separator drawn between them, and their baselines
     sat 3px apart - so it read as two labels with a dot floating in the space.
     One run of text is the only thing that fixes that, and it has to come from
     the markup. */
  /* v21's row only. The head office's rows are the reference's `.tr`, where
     the villa is its own cell with the buyer's name under it - `.cellav` and
     `.who`, which is the shape the reference uses for a person in a table. */
  for (const [role, p] of [['engineer', '/engineer']]) {
    const h = await body(p, role);
    const codes = h.match(/<p class="rt"><span class="rcode">[^<]+<\/span>[^<]/g) || [];
    assert.ok(codes.length > 0,
      role + ' ' + p + ': no row puts the villa code inside its heading');
    // And the row says so, so the stylesheet can drop the standalone cell.
    assert.match(h, /class="wrow hascode[ "]/, role + ' ' + p + ': rows do not declare they carry a code');
  }
});

test('rows are built in one place, not copied per screen', async () => {
  /* Fifteen hand-written copies drifted: the code inline here and in a column
     there, day counts written into the amount cell on one screen and the day
     cell on another. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['src/screens/engineer.js', 'src/screens/buyer.js']) {
    const viaBuilder = (src(f).match(/\bwrow\(\{/g) || []).length;
    assert.ok(viaBuilder > 0, f + ' builds no rows through the shared builder');

    /* A few rows are a different shape: the villa detail puts a radio button,
       a stage code or a status chip in the first cell rather than a villa
       code, and the builder does not model those. What must never be written
       by hand again is a row carrying a villa code. */
    const handCoded = src(f).match(/class="id">\$\{esc\((?:x|v|s|u)\.code\)/g) || [];
    assert.deepStrictEqual(handCoded, [],
      f + ' still writes ' + handCoded.length + ' villa-code rows by hand');
  }

  /* The office's rows are the reference's `.tr` inside `.tbl`, and every one
     of them comes out of `table()`. A `<div class="tr"` written into a screen
     is the drift starting again. */
  const off = src('src/screens/office.js');
  /* Two, and both are inside `table()`: the header row and the body row. A
     third is a screen writing its own. */
  const handTr = (off.match(/<div class="tr /g) || []).length;
  assert.strictEqual(handTr, 2, 'the office console writes ' + handTr + ' table rows by hand');
  assert.ok(off.split('table(').length - 1 > 8, 'the office console barely uses its own table()');
});
test('one gutter, and everything on a phone starts on it', async () => {
  const css = await (await get('/app.css')).text();
  /* v21's phone gutter is 26px: `.top`, `.blk` and `.lede` are all padded
     `0 26px` and `.item` is `17px 26px`. It was 18px here. */
  assert.match(css, /--gutter:\s*26px/, 'the gutter is not v21 s 26px');

  const narrow = atWidth(css, 'max-width: 720px');
  /* And it sits on the block, not on the shell. v21 pads each block and leaves
     the scroller alone, which is what lets the hairline under a row run the
     full width of the screen while the text above it stops at the gutter. This
     was the other way round - the shell padded, every child stripped - so no
     line on any screen ever reached the edge. */
  assert.match(narrow, /\.mhead, \.mbody, \.scroll \{[^}]*padding-left:\s*0\s*!important/,
    'the shell still owns the gutter, so no hairline can reach the edge of the screen');
  assert.match(narrow, /\.mbody > \.blk[^{]*\{[^}]*padding-left:\s*var\(--gutter\)/,
    'the blocks do not carry the gutter themselves');
  /* The row carries it too, as vertical padding plus the gutter - v21's
     `.item { padding: 17px 26px }` - so its hairline spans the screen. */
  assert.match(narrow, /\.wrow \{[^}]*padding:\s*17px var\(--gutter\)/,
    'the row does not carry v21 s 17px/26px padding');
  /* `.scroll` as well as `.mbody`: the buyer's screens and the sign-in page
     are built by a different function and have no `.mbody` at all, so a rule
     that names only `.mbody` leaves that whole side of the product out. */
  assert.match(narrow, /\.scroll > \.blk/, 'the buyer s side of the product is left out of the gutter');
});
test('the row is one line with a detail under it, the way v21 draws it', async () => {
  /* v21's `.item`: `.mid` holds the heading and the detail with `flex: 1;
     min-width: 0`, the detail sits under the heading on a 2px margin, and
     whatever the row stands at goes at the end of the line.

     It was a grid: `.mid` was `display: contents` so its two children could be
     placed in separate tracks, the detail spanned a row of its own and the day
     count was pinned to `grid-area: 1 / 2`. None of that is a shape v21 has. */
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
  const mid = /\.wrow \.mid \{([^}]*)\}/.exec(narrow);
  assert.ok(mid, 'no phone rule for the row s middle');
  assert.match(mid[1], /display:\s*block/, 'the row wrapper is still dropped for a grid');
  /* `flex: 1` is a basis of zero. With `auto` the middle takes its content
     width first and a long detail line pushes everything else onto a line of
     its own - which it did, on every row of the buyer's journey. */
  assert.match(mid[1], /flex:\s*1 1 0%/, 'the middle does not take the line the way v21 s does');
  assert.match(narrow, /\.wrow \.mid p \{[^}]*margin-top:\s*2px/,
    'the detail does not sit 2px under the heading, which is v21 s `.item .mid p`');

  // v21's `.h2` and v21's `.s`, which is what an item is made of.
  assert.match(narrow, /\.wrow \.mid \.rt \{[^}]*font:\s*500 15px\/21px/,
    'the heading is not v21 s .h2');
  assert.match(narrow, /\.wrow \.mid p\.s \{[^}]*font:\s*400 12\.5px\/18px/,
    'the detail is not v21 s .s');
  // And nothing is placed in a grid track any more.
  assert.ok(!/grid-area/.test(narrow.replace(/\/\*[\s\S]*?\*\//g, '')),
    'something on the phone row is still placed in a grid track');
});
test('the header is one bar, not four bands', async () => {
  /* It was the brand row, a 56px breadcrumb, the title, its subtitle and then
     the count - 273px of an 812px screen before the first card. */
  const css = await (await get('/app.css')).text();
  const phone = atWidth(css, 'max-width: 900px');
  assert.match(phone, /\.topbar \{ display: none/, 'the breadcrumb band still takes a row of its own');
  assert.match(phone, /\.ab-screen \{[\s\S]*?display: block/, 'the bar does not name the screen');

  // And the screen actually says which screen it is.
  for (const [role, p, name] of [['engineer', '/engineer', 'Me'],
                                 ['engineer', '/engineer/villas', 'Villas'],
                                 ['buyer', '/journey', 'Journey']]) {
    const h = await body(p, role);
    assert.ok(h.includes('<span class="ab-screen">' + name + '</span>'),
      role + ' ' + p + ' does not name itself in the bar');
  }

  /* The office names itself in `.h1`, which is the reference's page title and
     the only band above the content. */
  for (const [p, name] of [['/office', 'Office dashboard'], ['/office/packs', 'Ready to send'],
                           ['/office/rera', 'RERA filing']]) {
    const h = await body(p, 'office');
    assert.ok(h.includes('<div class="h1">' + name + '</div>'),
      p + ' does not name itself in its heading');
  }
});
test('the header is v21 s lede: a label, a number, a sentence', async () => {
  /* v21 opens every phone screen with `.lede` - `.k` at 500 12px/16px with
     14px under it, `.mega` at 600 64px/64px on -2.2px of tracking, and `.cap`
     at 400 14px/22px 12px below that - in that order and with nothing drawn
     around it.

     This header is the same three pieces in a different order inside two extra
     boxes: a title, a sentence, and a `.hero` card holding the count. The
     boxes are dropped with `display: contents` and `order` puts the three in
     v21's order without moving anything in the markup. */
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');

  assert.match(narrow, /\.pgt \{[^}]*font:\s*500 12px\/16px/, 'the label is not v21 s .lede .k');
  assert.match(narrow, /\.pgt \{[^}]*margin:\s*0 0 14px/, 'the label has not got v21 s 14px under it');
  const fig = /\.mhead \.summary \.fig \{([^}]*)\}/.exec(narrow);
  assert.ok(fig, 'the count has no phone rule');
  /* plint.css sets `.kpin` and friends with `!important`, and the hero's own
     rule sets `.fig` outside this block, so the shorthand and the flag are
     both required - the count measured 19px for a whole round once while a
     bare `font-size` sat in the file. */
  assert.match(fig[1], /font:\s*600 64px\/64px[^;]*!important/, 'the count is not v21 s .mega');
  assert.match(fig[1], /letter-spacing:\s*-2\.2px/, 'the count is not on v21 s tracking');
  /* v21's mega is `--ink` whatever it counts. This build coloured it by tone. */
  assert.match(fig[1], /color:\s*var\(--ink\)\s*!important/, 'the count is not v21 s ink');
  assert.match(narrow, /\.mhead \.hstrip \.g > p\.s, \.mhead \.summary \.note \{[^}]*font:\s*400 14px\/22px/,
    'the sentence is not v21 s .cap');

  // And in v21's order: label, number, sentence.
  const order = s => Number((new RegExp(s + ' \\{[^}]*order:\\s*(\\d+)').exec(narrow) || [])[1]);
  assert.ok(order('\\.pgt') < order('\\.mhead \\.summary \\.fig'),
    'the number is above the label it belongs to');
  assert.ok(order('\\.mhead \\.summary \\.fig') < 3, 'the number is not the second thing in the lede');
  // v21 puts 54px between the lede and the first row: `.gap.l`.
  assert.match(narrow, /\.mhead::after \{[^}]*height:\s*54px/,
    'there is no 54px between the header and the first row, which is v21 s .gap.l');
});
test('no day count is shown without a verdict', async () => {
  /* Either the pill says what the age means, or - where the pill is busy
     saying something else - the number itself is coloured on the same
     thresholds. A bare figure asks the reader to score it, and they will
     score it differently from the screen that decides what is late. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/screens/rows.js'), 'utf8');
  assert.match(src, /AGE = \{ overdue: 21, ageing: 10 \}/,
    'the age thresholds are not in one place');
  assert.match(src, /function ageChip/, 'there is no shared age pill');
  assert.match(src, /ageClass/, 'there is no shared way to colour a bare day count');

  // Nothing may hand-roll a threshold beside the shared one.
  for (const f of ['src/screens/engineer.js', 'src/server.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const rolled = s.match(/age >= 21|age >= 10|since > 20/g) || [];
    assert.deepStrictEqual(rolled, [],
      f + ' still decides for itself what is late: ' + rolled.join(', '));
  }

  /* And every row that shows a day count says what it means. Scoped to the
     screens where the count is against a deadline: the site log shows how long
     ago an entry was made, which has no due date and must not be reddened. */
  for (const [role, p] of [['engineer', '/engineer/villas'],
                           ['engineer', '/engineer/certs']]) {
    // The desktop table's column headings reuse the same cell classes, and
    // "Age" is a label rather than a figure.
    const h = (await body(p, role)).replace(/<div class="whead">[\s\S]*?<\/div>/g, '');
    const rows = h.match(/<span class="days[^"]*">[^<]+<\/span>/g) || [];
    assert.ok(rows.length > 0, role + ' ' + p + ' has no day counts to check');
    for (const r of rows) {
      assert.match(r, /class="days age-(ok|warn|late)"/,
        role + ' ' + p + ' shows a day count with no verdict: ' + r);
    }
  }

  /* The head office says the same thing in the reference's vocabulary: a
     figure standing for how long something has waited is a pill, and a pill
     has one of five meanings. A bare number with no pill beside it would be
     the same unscored figure in a different alphabet. */
  /* Read off the quiet villas rather than the packs: nothing in this project
     is currently sitting delivered-and-unpaid, so that screen is legitimately
     empty and would prove nothing either way. */
  const off = await body('/office/silent', 'office');
  const waits = off.match(/class="pill p-over">[^<]*(days quiet|never photographed)</g) || [];
  assert.ok(waits.length > 0, 'the office shows no scored waiting times');
});

test('v21 owns the buttons on a phone; the scale is the desktop s', async () => {
  /* There was one button scale for every width - 36px and 44px, 13px text, a
     10px radius - built so no screen would show four different buttons.

     v21 does not do that. `.wbtn` is 9px/14px padding at 12.5px on a 6px
     radius, `.sortb` is 9px/12px at 12px on a 9px radius, and `.act` is a
     44px full-width bar. Where the two disagree v21 is the design, so on a
     phone none of this applies and v21's own rules are what draw a button.
     Above 720px, where v21 has no design at all, the scale stays. */
  const css = await (await get('/app.css')).text();

  const wide = atWidth(css, 'min-width: 721px');
  assert.match(wide, /\.wbtn, \.sortb \{[^}]*min-height:\s*36px/,
    'the desktop button scale is gone as well, which was not the ask');
  assert.match(wide, /\.act, \.authbtn, \.wbtn\.full \{[^}]*min-height:\s*44px/,
    'the full-width action has no rule of its own above a phone');

  /* Nothing may resize a button below 720. That is the whole point: a second
     declaration down here is exactly how four heights happened the first
     time, and now it would also be a value v21 has already set. */
  const narrow = atWidth(css, 'max-width: 720px').replace(/\/\*[\s\S]*?\*\//g, '');
  const forked = narrow.match(/\.wbtn[^{}]*\{[^}]*(?:min-height|font-size|border-radius|padding)\s*:/g) || [];
  assert.deepStrictEqual(forked, [],
    'the phone layer sizes a button again, over the top of v21: ' + forked.join(' | '));
  const base = /\n\.wbtn, \.sortb \{/.exec(css);
  assert.ok(!base, 'the button scale is declared outside a media query, so it reaches the phone');

  /* Two controls on a line of their own split it evenly. "Accept" is 72px of
     text and "Ask to reassign" is 119px, so left to size themselves they read
     as one button and an afterthought rather than a choice between two. */
  assert.match(narrow, /\.wrow \.actc\.wide \.wbtn, \.wrow \.actc\.wide form \{[^}]*flex:\s*1 1 0/,
    'paired controls do not share their line evenly');
});
test('the amount is v21 s, at the end of the row', async () => {
  /* The money was moved to the left edge of the card at 600 weight and 15px,
     the boldest thing on the row, because right-aligned at 400/13px it was
     lining up with nothing above or below it.

     v21 puts it at the end of the row - `.wrow .amt` is `text-align: right`
     at `400 13px/1` in `--ink-2` - and v21 is the design. What survives is the
     part v21 also does: it never breaks mid-value and its digits line up. */
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
  const amt = /\n  \.wrow \.amt \{([^}]*)\}/.exec(narrow);
  assert.ok(amt, 'no phone rule for the amount cell');
  assert.match(amt[1], /white-space:\s*nowrap/, 'an amount may break mid-value');
  assert.match(amt[1], /tabular-nums/, 'amounts do not line up digit for digit down the column');
  assert.match(amt[1], /text-align:\s*right/, 'the amount is not at the end of the row, as v21 has it');
  const weight = /font:\s*(\d+)\s+(\d+)px/.exec(amt[1]);
  assert.ok(weight, 'the amount has no font declaration');
  assert.strictEqual(weight[1], '400', 'the amount is heavier than v21 s 400');
  assert.strictEqual(weight[2], '13', 'the amount is not v21 s 13px');

  /* A control has no v21 line to sit on - v21 never puts a button in a list
     row - so it takes the line under the row it acts on. */
  assert.match(narrow, /\.wrow \.actc \{[^}]*flex:\s*1 1 100%/,
    'a control does not take the line under the row it acts on');
});
test('a row with one control never claims a line for it', async () => {
  /* `actc wide` takes a whole line below the amount, which is right for two
     buttons and wrong for one. The Visits tab marked every row wide, so a
     confirmed visit - which offers only "Cannot make it" - put one button on
     a row of its own with the rest of that line empty. This is the same shape
     the Review button had before it moved up beside the amount. */
  const h = await body('/engineer/visits', 'engineer');
  const rows = h.match(/<span class="actc[^"]*">[\s\S]*?<\/span>/g) || [];
  assert.ok(rows.length > 0, 'the visits list has no action cells to check');
  let single = 0;
  for (const cell of rows) {
    const buttons = (cell.match(/<button/g) || []).length;
    if (buttons === 1) {
      single++;
      assert.ok(!/class="actc[^"]*\bwide\b/.test(cell),
        'a cell with one button is marked wide, so it takes a line of its own');
    }
    if (buttons > 1) {
      assert.match(cell, /class="actc[^"]*\bwide\b/,
        'a cell with ' + buttons + ' buttons is not marked wide; they will not fit beside an amount');
    }
  }
  assert.ok(single > 0, 'no single-control row in the visits list, so this proves nothing');
});

test('the phone list is v21 s, not a table in disguise', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');

  /* v21's phone has no panel anywhere in it. Rows sit on the paper a hairline
     apart and the edge of the screen is the only edge. `.wl` is a card in v21
     - paper, a hairline, a 12px radius - but only inside the desk, and the
     desk is a desktop.

     This had gone the other way twice: first every row was a card of its own
     on a tint, then the panel came back and the rows sat inside it. v21 has
     neither. */
  const wl = /\n  \.wl \{([^}]*)\}/.exec(narrow);
  assert.ok(wl, 'there is no phone rule for the worklist panel');
  assert.match(wl[1], /border:\s*0/, 'the worklist is still a card on a phone');
  assert.match(wl[1], /background:\s*none/, 'the worklist still paints a card on a phone');

  const card = /\n  \.wrow \{([^}]*)\}/.exec(narrow);
  assert.ok(card, 'there is no phone rule for a list row');
  /* v21's `.item`, exactly: 17px 26px, an 18px gap, and a hairline in
     `--hair-2` under every row but the last. */
  assert.match(card[1], /padding:\s*17px var\(--gutter\)/, 'the row is not padded 17px 26px');
  assert.match(card[1], /border-bottom:\s*1px solid var\(--hair-2\)/,
    'the hairline between rows is not v21 s --hair-2');
  assert.match(card[1], /border:\s*0/, 'a row still draws a border of its own');
  assert.match(card[1], /margin:\s*0\s*!important/, 'a row still floats on a gap of its own');
  /* plint.css sets `gap: 14px !important` on `.wrow` for its desktop table, so
     a plain `gap` here loses to it - which it did, and every row came out with
     14px between its cells instead of v21's 18. */
  assert.match(card[1], /gap:\s*18px\s*!important/,
    'the row gap will lose to plint.css and the row will not be v21 s');
  assert.match(narrow, /\.wl > \.wrow:last-child[^{]*\{[^}]*border-bottom:\s*0/,
    'the last row draws a line under the end of the list, which v21 s .item does not');
  /* v21's spacers, unscaled: 36, 22 and 54. They had been cut to 20/12/28. */
  assert.match(narrow, /\.mbody \.gap,[^{]*\{\s*height:\s*36px/, 'the spacer is not v21 s 36px');
  assert.match(narrow, /\.mbody \.gap\.s,[^{]*\{\s*height:\s*22px/, 'the small spacer is not v21 s 22px');
  assert.match(narrow, /\.mbody \.gap\.l,[^{]*\{\s*height:\s*54px/, 'the large spacer is not v21 s 54px');
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

test('nothing is laid out with a height the page cannot override', async () => {
  /* The ageing histogram shipped with `style="height:88px"` on each bar. An
     inline height beats every rule, so on a phone the sparkline became four
     slabs half the screen wide.

     A width is a different matter, and the reference settles it: its own
     progress bar is `<span style="width:88%">`, because the fill of a bar is
     data rather than layout and there is nowhere else for it to live. */
  for (const [role, p] of [['office', '/office'], ['engineer', '/engineer'],
                           ['buyer', '/journey'], ['buyer', '/money']]) {
    const h = await body(p, role);
    /* The mark is the exception, and it is the reference's exception: its own
       top bar draws the logo at a second size with `style="width:20px;
       height:20px"` on the same three divs. A mark has one shape and two
       sizes; it is not laid out. */
    const inlineHeights = (h.match(/style="[^"]*height:[^"]*"/g) || [])
      .filter(x => !/^style="width:\d+px;height:\d+px"$/.test(x));
    assert.deepStrictEqual(inlineHeights, [],
      role + ' ' + p + ' carries an inline height: ' + inlineHeights.join(', '));
  }
  const h = await body('/office', 'office');
  assert.match(h, /<span style="width:\d+%"><\/span>/,
    'the bar does not carry its own fill, which is the one thing it is for');
});
test('no destination is named after the person reading it', async () => {
  /* "Owner view" and then "Owner dashboard" both named who was looking rather
     than what they were looking at. Every destination is named for its
     content - Dashboard, Ready to send, Sanction not recorded - and none of
     them for whoever opened it. */
  const h = await body('/office', 'office');
  const side = (/<nav class="nav">[\s\S]*?<\/nav>/.exec(h) || [''])[0];
  assert.ok(side, 'no sidebar to read the destination names from');

  /* Destination labels only. The group headings are content and may name a
     party - "Buyers" is whose decisions and documents they are, read by the
     office, which is the right way round. */
  const labels = [...side.matchAll(/<span class="lbl">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.strictEqual(labels.length, 22, 'read ' + labels.length + ' destination labels, not 22');
  for (const l of labels) {
    assert.ok(!/^(Owner|Admin|My|Your)/i.test(l),
      'a destination is named after who is reading it: ' + JSON.stringify(l));
  }
});
test('the office dashboard leads with the money that has stopped', async () => {
  /* The reference's dashboard shape, filled with this project's question:
     what is the money waiting on, and how far through the book are we. */
  const h = await body('/office', 'office');

  assert.match(h, /<div class="hero">/, 'no hero on the dashboard');
  assert.match(h, /class="eyebrow">Waiting on evidence</,
    'the hero does not say what its figure is');
  assert.match(h, /<div class="big num">₹/, 'the headline figure is not money');
  /* The bar is stages certified against stages under way, and it carries its
     own caption - a bar with no numbers beside it is a decoration. */
  assert.match(h, /<div class="bar"><span style="width:\d+%"><\/span><\/div>/,
    'the hero has no progress bar');
  assert.match(h, /class="barcap"><span><b>\d+%<\/b>/, 'the bar has no caption');

  const k = (h.match(/class="kpi"/g) || []).length;
  assert.strictEqual(k, 4, 'the dashboard shows ' + k + ' KPIs, not four');
  const cards = (h.match(/<div class="card">/g) || []).length;
  assert.ok(cards >= 2, 'the dashboard shows ' + cards + ' cards');
  assert.match(h, />Packs ready to send</, 'nothing lists the packs waiting to go out');
  assert.match(h, />Villas gone quiet</, 'nothing lists the villas nobody has photographed');
  assert.match(h, /class="tbl"/, 'there is no stage worklist');

  /* And a board. Which board is on it by default is the subject of its own
     test above: the holder grouping leads, the pack states are a click away.
     Both are four columns. */
  assert.match(h, /<div class="board">/, 'there is no board on the dashboard');
  const cols = (h.match(/<div class="col">/g) || []).length;
  assert.strictEqual(cols, 4, 'the board has ' + cols + ' columns, not four');
  const packs = await body('/office?view=packs', 'office');
  for (const c of ['Certified, pack not sent', 'With the lender', 'Lender has asked', 'Disbursed']) {
    assert.ok(packs.includes('>' + c + '<'), 'the pack view has no "' + c + '" column');
  }
});
