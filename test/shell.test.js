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
  office:   ['/office', '/office/owner', '/office/handoff', '/office/packs',
             '/office/query', '/office/chase', '/office/signoff', '/office/silent',
             '/office/wait', '/office/escrow', '/office/choices', '/office/warranty',
             '/office/evidence', '/office/qpr', '/office/possession'],
};

/* How many destinations each role has, and therefore what navigation it gets.

   Up to five is v21's bottom bar - `.nav five` is a shape v21 designed and
   five fits a phone. Above five it becomes a menu button, which is the head
   office: fifteen destinations in nine groups are not a bar at any width. */
const BAR_FITS = 5;
const DESTINATIONS = { buyer: 5, engineer: 5, office: 15 };

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
    /* Rendered on every screen, but hidden under 480px: the head office's
       titles are long enough that the bar was clipping the screen name and
       the signed-in name at once. Two half-labels tell you less than one
       whole one. It is in the markup, so it returns the moment there is room
       and a screen reader has it at every width. */
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

    if (DESTINATIONS[role] > BAR_FITS) {
      /* Fifteen tabs in 375px is twenty-five pixels each. Above the bar's five
         a role gets a menu button and no bar at all - the head office, whose
         fifteen destinations sit under nine headings that are what make the
         list navigation rather than a list. */
      assert.strictEqual(tabs, '',
        role + ' has ' + DESTINATIONS[role] + ' destinations squeezed into a bar');
      assert.match(h, /class="ab-menu"/,
        role + ' has ' + DESTINATIONS[role] + ' destinations and no menu button');
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

  /* And all three must ask for the same shell, or an install made by one role
     precaches a stylesheet the other two never request. */
  const sheets = new Set();
  for (const [role, p] of everyScreen()) {
    const m = (await body(p, role)).match(/\/app\.[a-f0-9]+\.css/);
    assert.ok(m, role + ' ' + p + ': links no content-addressed stylesheet');
    sheets.add(m[0]);
  }
  assert.strictEqual(sheets.size, 1,
    'the three roles link different shells: ' + [...sheets].join(', '));
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

test('the office menu is a layer over the screen, not another screen', async () => {
  /* It was a screen: you tapped Menu, the page navigated, and you arrived
     somewhere that looked like every other screen in the role - which reads as
     the menu not having opened, and was reported that way. A menu is a layer.
     The thing you were reading stays behind it, dimmed, so it is obvious both
     that something opened and what it is over.

     And no JavaScript: the button is a link to `#menu`, `:target` shows the
     panel, and the back button closes it because the browser's own history is
     doing the work. */
  const h = await body('/office', 'office');
  assert.match(h, /<div class="drawer" id="menu">/, 'no menu layer on an office screen');
  assert.match(h, /class="ab-menu" href="#menu"/, 'the menu button navigates instead of opening a layer');
  assert.match(h, /<a class="dscrim" href="#"/,
    'the layer has nothing over the page behind it, and no way to dismiss it');
  /* Scoped to the layer itself: the service worker registration is a script
     further down the same document and has nothing to do with this. */
  const layer = (/<div class="drawer" id="menu">[\s\S]*?<\/nav><\/div>/.exec(h) || [''])[0];
  assert.ok(layer, 'the menu layer is not a self-contained block');
  assert.ok(!/<script|onclick|onchange/i.test(layer),
    'the menu needs script to open, so it will not open before the script runs');

  const links = (h.match(/<a href="\/office[^"]*"[^>]*><svg/g) || []).length;
  assert.strictEqual(links, 15, 'the menu offers ' + links + ' destinations, not fifteen');

  /* Every office screen carries it, or the menu is missing from wherever you
     happen to be standing - which is every screen but one. */
  for (const p of ['/office/owner', '/office/chase', '/office/qpr']) {
    assert.match(await body(p, 'office'), /<div class="drawer" id="menu">/,
      p + ' has no way into the other fourteen');
  }

  // The old URL still works. Somebody's bookmark lands on Today with it open.
  const moved = await get('/office/menu', 'office');
  assert.strictEqual(moved.status, 302, '/office/menu is still a screen of its own');
  assert.strictEqual(moved.headers.get('location'), '/office#menu',
    '/office/menu does not land anywhere useful');
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

test('the office menu names every destination and counts it', async () => {
  /* A menu drawn with the same hero, the same cards and a subtitle under every
     row reads as a sixteenth dashboard - it was reported as the menu not
     opening at all, because there was nothing to tell it apart from the screen
     it was opened from. */
  const h = await body('/office', 'office');
  const panel = h.split('<nav class="dpanel"')[1] || '';
  assert.ok(panel, 'the menu layer has no panel in it');

  /* Every group heading and every label, so a destination cannot be added to
     the route table and quietly left out of the only way to reach it. */
  for (const g of ['New from sales', 'Waiting on you', 'Buyer loans', 'Chasing your team',
                   'Waiting on the bank', 'Your own money', 'Buyer decisions', 'Compliance']) {
    assert.ok(panel.includes(g), 'the menu is missing the group "' + g + '"');
  }
  for (const label of ['Today', 'The position', 'Waiting for pickup', 'Ready to send',
                       'Lender asked a question', 'Sanction not recorded', 'Sign-off and evidence',
                       'Site gone quiet', 'Sent, not yet paid', 'Escrow drawdown',
                       'Choices not made', 'Warranty claims', 'Evidence certificates',
                       'Quarterly RERA filing', 'After possession']) {
    assert.ok(panel.includes(label), 'the menu is missing "' + label + '"');
  }

  /* An icon each. Fifteen labels with nothing beside them is a wall of text,
     and the icon is what a destination is recognised by after the second week. */
  const icons = (panel.match(/<svg /g) || []).length;
  assert.strictEqual(icons, 15, 'the menu draws ' + icons + ' icons for fifteen destinations');

  // One line each. Two lines a row is what made it scroll for two screens.
  assert.ok(!/<p class="s">/.test(panel), 'a menu row carries a subtitle, so every row is two lines');
  assert.ok(!/class="wrow/.test(panel), 'the menu is built out of worklist cards');
  assert.ok(!/class="kpin/.test(panel), 'the menu leads with a count, which is a dashboard doing that');
});

test('one platform: the dashboards are composed, not drawn', async () => {
  /* The critique that produced this test: "instead of doing from the rules,
     you are picking each dashboard separately". It was right. There were two
     copies of a `hero` helper and nine hand-written `.mhead` blocks - eleven
     places drawing the same header - so "the summary" meant something slightly
     different on every screen, and a change to the design had to be made
     eleven times and remembered a twelfth.

     The buyer, the engineer and the head office are not three products. They
     are three views of one file and they have to look like it, which means the
     furniture is defined once and composed, never redrawn. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ROLES = ['src/screens/buyer.js', 'src/screens/engineer.js', 'src/screens/office.js'];

  for (const f of ROLES) {
    assert.match(src(f), /require\('\.\/ui'\)/,
      f + ' does not use the shared dashboard furniture');
  }

  /* And nothing draws a header of its own. `.mhead` is emitted by `ui.head`,
     which is the one place that decides what a screen opens with. */
  for (const f of ROLES) {
    const drawn = (src(f).match(/class="mhead"/g) || []).length;
    assert.strictEqual(drawn, 0,
      f + ' hand-writes ' + drawn + ' page header(s) instead of composing one');
  }
  assert.match(src('src/screens/ui.js'), /class="mhead"/,
    'the shared layer does not own the header it is supposed to own');
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

  /* And the head office's own dashboard actually uses it: the money that is
     not moving is the headline, in red, with tiles under it. */
  const h = await body('/office', 'office');
  assert.match(h, /<p class="fig hot">/, 'the office dashboard has no red headline figure');
  assert.match(h, /<div class="stats">/, 'the office dashboard has no tiles to scan');
  assert.match(h, /<div class="prog">/, 'the office dashboard does not say how far along it is');
  const tiles = (h.match(/class="stat"/g) || []).length;
  assert.strictEqual(tiles, 4, 'the dashboard shows ' + tiles + ' tiles, not four');
});

test('the progress bar is not named after something v21 hides', async () => {
  /* v21 uses `.bar` for the prototype's own chrome and this application hides
     it outright, so a progress bar called that is `display: none` on every
     screen. It was, until the frame test caught it. */
  const h = await body('/office', 'office');
  assert.ok(!/class="bar"/.test(h), 'the progress bar is using v21\'s hidden chrome class');
  const css = await (await get('/app.css')).text();
  assert.match(css, /\.summary \.prog \{/, 'the progress bar has no rule of its own');
});

test('the skin is a token change, not a rule change', async () => {
  /* If restyling the product means editing rules, the rules are wrong. Every
     colour and every corner in this file has to come from `:root`, so a skin
     is one block at the top and nothing else - which is also what stops the
     worklist panel and the summary card drifting apart the way they did when
     each screen carried its own numbers. */
  /* Read off disk, the way the other source-reading tests here do. Fetched
     over HTTP this one went green while a hex colour was demonstrably sitting
     in a rule, and I could not make it fail on demand - a guard I cannot make
     fail is not a guard, whatever its name says. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/app.css'), 'utf8');
  assert.ok(css.length > 5000, 'read ' + css.length + ' bytes of app.css, not a stylesheet');
  const root = /:root \{[\s\S]*?\n\}/.exec(css);
  assert.ok(root, 'app.css defines no tokens of its own');
  for (const t of ['--ink:', '--hair:', '--hair-2:', '--card-shadow:', '--r-card:', '--r-ctl:']) {
    assert.ok(root[0].includes(t), 'the skin has no ' + t.slice(0, -1) + ' token');
  }

  // Comments and the token block itself are not rules.
  const rules = css.replace(root[0], '').replace(/\/\*[\s\S]*?\*\//g, '');

  /* No card corner typed into a rule. Anything below 10px is a chip, a swatch
     or a bar cap and is its own shape rather than a card's. */
  const radii = [...rules.matchAll(/border-radius:\s*([^;]+);/g)]
    .map(m => m[1])
    .filter(v => /\d{2,}px/.test(v) && !/var\(/.test(v))
    .filter(v => !/999px/.test(v));
  assert.deepStrictEqual(radii, [],
    'a card corner is typed into a rule instead of coming from --r-card: ' + radii.join(', '));

  /* And no hex colour outside the tokens. A hue in a rule is a hue that one
     screen has and the others do not. */
  const hexes = [...rules.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0]);
  assert.deepStrictEqual(hexes, [],
    'a colour is typed into a rule instead of coming from a token: ' + hexes.join(', '));
});

test('the stuck money is a board, and every villa is still on it', async () => {
  /* Four sections stacked down the page became four columns. Stacked you read
     it; in columns you see it - where the backlog sits is a shape, and
     forty-eight rows in one column is that shape being withheld.

     The grouping is the same grouping it always was, so the thing to prove is
     that nothing was lost in the rendering: every blocked villa is on the
     board exactly once. */
  const h = await body('/office', 'office');
  assert.match(h, /<div class="board"/, 'the stuck money is not a board');

  const cols = (h.match(/<section class="bcol">/g) || []).length;
  assert.ok(cols >= 2, 'a board with ' + cols + ' column is a list');

  /* One card per blocked villa, counted off the same rows the screen counted.
     The board drops an empty column rather than drawing a heading over
     nothing, so the columns vary; the cards must not. */
  const { asUser } = require('../src/db');
  const blocked = await asUser({ id: 'u-office', role: 'office' }, c => c.query(
    'SELECT count(*)::int n FROM blockers')).then(r => r.rows[0].n);
  const cards = (h.match(/class="bcard"/g) || []).length;
  assert.strictEqual(cards, blocked,
    'the board shows ' + cards + ' cards for ' + blocked + ' blocked stages');

  /* Every card leads to the buyer file. A card you cannot open is a tile. */
  const links = (h.match(/<a class="bcard" href="\/office\/buyer\//g) || []).length;
  assert.strictEqual(links, cards, 'a card on the board does not open anything');

  // Each column says how many are in it and what they are worth.
  const counts = (h.match(/class="bn">\d+</g) || []).length;
  assert.strictEqual(counts, cols, 'a column does not say how many are in it');
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
  const narrow = [null, atWidth(css, 'max-width: 720px')];
  assert.ok(narrow, 'no narrow-screen block in app.css');
  assert.match(narrow[1], /\.whead\s*\{\s*display:\s*none/, 'column headings survive as cards');
  assert.match(narrow[1], /\.wrow\s*\{[\s\S]*?display:\s*grid/, 'rows do not reflow to cards');
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
  /* And after the four `!important` rules that stack every other .uprow field
     full width - equal importance, so this one wins on specificity, and the
     picker needs `.mid` in its selector to outrank `.uprow .mid .fi`. */
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
    assert.match(h, /class="wrow hascode[ "]/, role + ' ' + p + ': rows do not declare they carry a code');
  }
});

test('rows are built in one place, not copied per screen', async () => {
  /* Fifteen hand-written copies drifted: the code inline here and in a column
     there, day counts written into the amount cell on one screen and the day
     cell on another. */
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['src/screens/engineer.js', 'src/screens/buyer.js',
                   'src/screens/office.js']) {
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

  const narrow = atWidth(css, 'max-width: 720px');
  /* Applied at exactly one level. It was stacking three deep - `.mbody` padded
     it, `.wl` is a bordered card that padded it again, and the row added a
     margin - so cards sat at 54..321 while the label above them sat at
     18..357 and the button between them at 36..339. */
  assert.match(narrow, /\.mhead, \.mbody, \.scroll \{[^}]*padding-left:\s*var\(--gutter\)/,
    'the gutter is not applied to the containers that own it');
  /* `.scroll` as well as `.mbody`: the buyer's screens and the sign-in page
     are built by a different function and have no `.mbody` at all, so a rule
     that names only `.mbody` leaves that whole side of the product out. */
  assert.match(narrow, /\.scroll \.item, \.scroll \.duebar \{[^}]*margin-left:\s*0/,
    "the buyer's cards keep a margin that stacks on the container's padding");
  const cleared = /\.mbody \.wl,[^{]*\.scroll \.blk[^{]*\{([^}]*)\}/.exec(narrow);
  assert.ok(cleared, 'the nested containers never give up their own padding');
  /* And only inside `.mbody`, which is the container that puts the gutter
     back. Unscoped it stripped `.blk` on every screen `page()` builds - the
     sign-in form and all of the buyer's side - where nothing re-pads it and
     the text ran into the left edge. */
  const resetSel = /((?:\.mbody|\.scroll)[^{]*)\{[^}]*padding-left:\s*0/.exec(narrow);
  assert.ok(resetSel, 'no padding reset found at all');
  for (const one of resetSel[1].split(',')) {
    const t = one.trim();
    if (!t) continue;
    assert.ok(/^(\.mbody|\.scroll) /.test(t),
      'the padding reset selector "' + t + '" is not qualified by a shell that puts the gutter back');
  }
  assert.match(cleared[1], /padding-left:\s*0/, 'a nested container still adds to the gutter');
  assert.match(cleared[1], /margin-left:\s*0/, 'a nested container still adds a margin');

  // And nothing may re-pad them afterwards, which is what happened once.
  const dupes = (narrow.match(/\.tools \{[^}]*padding-left:\s*18px/g) || []).length;
  assert.strictEqual(dupes, 0, 'a later rule pads .tools again, so its contents will not line up');

  /* Vertical space stacked the same way it did horizontally. Between the last
     card of one section and the next section's heading there were four
     separate contributions: the row's own 8px margin, 8px of padding inside
     `.wl`, `.wl`'s 18px margin, and a 36px spacer element - 70px of nothing on
     a 812px screen. On a phone `.wl` has no border and no background, so its
     padding and margin are buying nothing and the spacer is left to do the
     job alone. */
  /* The list is a card and its heading is the top of that card. It was the
     other way round - `.wl` gave up its border and every row inside became a
     tile of its own with a gap under it. Each row was legible and the screen
     was not: a heading, then five or forty separate tiles floating on a tint,
     with no edge saying where the section began or ended. */
  const panel = /\n  \.wl \{([^}]*)\}/.exec(narrow);
  assert.ok(panel, 'the list has no rule of its own on a phone');
  assert.match(panel[1], /border:\s*1px solid var\(--hair\)/, 'the list is not a card');
  assert.match(panel[1], /background:\s*var\(--paper\)/, 'the list card has no ground of its own');
  assert.match(panel[1], /overflow:\s*hidden/,
    "the last row's square corners will poke out of the card's radius");
  /* The corner is a token now, so a skin change is a token change and never a
     rule change. It was 12px typed into eight places. */
  assert.match(narrow, /\.mbody \.blk:has\(\+ \.wl\) \{[^}]*border-radius:\s*var\(--r-card\) var\(--r-card\) 0 0/,
    'a section heading is not joined to the list under it');
  /* And joined with no gap. v21 gives `.wl` an 18px top margin for a list that
     stands on its own; on one joined to its own heading that is a seam
     straight across the middle of the card. */
  assert.match(narrow, /\.mbody \.blk:has\(\+ \.wl\) \+ \.wl \{[^}]*margin-top:\s*0/,
    'the heading and its list are one card with a gap down the middle of it');
  /* But not the toolbar: it has no card of its own below it to space it from
     the next heading, and zeroing it put the Close-a-snag button hard against
     the "Office is chasing you" label. */
  // Anchored to the line start: `.wl, .tools {` also contains ".tools {".
  const tools = /\n\s*\.tools \{([^}]*)\}/.exec(narrow);
  assert.ok(tools && /margin-bottom:\s*(\d+)px/.test(tools[1]) &&
    Number(/margin-bottom:\s*(\d+)px/.exec(tools[1])[1]) >= 16,
    'the toolbar has no room under it, so its button will touch the next heading');
  /* And a row with money but no control does not spend a whole line on the
     money alone - there is nothing else on that line for it to line up with. */
  assert.match(narrow, /\.wrow\.noact \.amt\s+\{[^}]*grid-area:\s*2 \/ 3/,
    'a lone amount still takes a line of its own');
  assert.match(narrow, /\.wrow\.noact \.mid p\.s \{[^}]*grid-area:\s*2 \/ 1 \/ 3 \/ 3/,
    'the detail still spans under the amount that has moved up beside it');

  const gap = /\.mbody \.gap,[^{]*\{([^}]*)\}/.exec(narrow);
  assert.ok(gap, 'the section spacer keeps its desktop height on a phone');
  const px = Number(/height:\s*(\d+)px/.exec(gap[1])[1]);
  assert.ok(px > 0 && px <= 24,
    'the section spacer is ' + px + 'px; it is the only separator left, but it is not a screenful');
  /* All three sizes, on both shells. Ten spacers at v21's 36px and 54px is
     378px of blank on the buyer's villa screen alone. */
  assert.match(narrow, /\.mbody \.gap\.s,[^{]*\.scroll \.gap\.s\s*\{/,
    'the small spacer is not cut on one of the two shells');
  assert.match(narrow, /\.mbody \.gap\.l,[^{]*\.scroll \.gap\.l\s*\{/,
    'the large spacer is not cut on one of the two shells');
  /* And this block must come after the `.phone.wide` rules it ties with on
     specificity, or they win and nothing here applies. */
  assert.ok(css.indexOf('.phone.wide .gap ') < css.indexOf('.phone .scroll .gap '),
    'the phone spacer heights are declared before the .phone.wide ones that tie with them');
});

test('the day count sits with the status pill, on the heading line', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
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
                                 ['office', '/office', 'Today'],
                                 ['office', '/office/owner', 'The position'],
                                 ['buyer', '/journey', 'Journey']]) {
    const h = await body(p, role);
    assert.ok(h.includes('<span class="ab-screen">' + name + '</span>'),
      role + ' ' + p + ' does not name itself in the bar');
  }
});

test('the summary reads as a summary, not as body text', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
  const kpin = /\.kpin \{([^}]*)\}/.exec(narrow);
  assert.ok(kpin, 'the count has no phone rule');

  /* plint.css:417 sets `font: … !important` on `.kpin`, so a bare `font-size`
     here loses to it - the count measured 19px for a whole round while this
     rule sat in the file. The shorthand and the flag are both required. */
  assert.match(kpin[1], /font:\s*\d+ 4\dpx/, 'the count is not the largest thing in the block');
  assert.match(kpin[1], /!important/, 'plint.css sets .kpin with !important and will win');
  assert.match(narrow, /\.kpi \{[^}]*order:\s*1/, 'the count is not lifted above the title');
  /* But not a line each. The head office shows two, and one above the other
     they took 116px of the 812px before a single row of work appeared. */
  assert.match(narrow, /\.kpi \{[^}]*flex:\s*0 0 auto/,
    'a KPI still claims a whole line, so two of them cost two');
  /* And the gap between them belongs to the strip, not to the second one: as a
     margin it survived the wrap and pushed the second past the page gutter. */
  assert.ok(!/\.kpi ~ \.kpi \{[^}]*margin-left/.test(narrow),
    'the second KPI carries its own margin, which will indent it if it wraps');
  assert.match(narrow, /\.hstrip \{[^}]*column-gap:\s*18px/,
    'the header strip has no column gap to separate two counts');
  assert.match(narrow, /\.pgt \{[^}]*font-size:\s*15px/, 'the title still competes with the count');
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
  for (const [role, p] of [['engineer', '/engineer/villas'], ['office', '/office'],
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
});

test('every button in the application is the same object', async () => {
  const css = await (await get('/app.css')).text();

  /* There were four button heights - v21's 33px, the sidebar's 36, a 38px
     carve-out for the button inside a list row, and a 44px phone minimum -
     three font sizes and two corner radii, so no two buttons on one screen
     were quite the same thing. Two sizes now, from tokens, and the difference
     between them says something: one sits in a line beside other things, the
     other takes the whole width and is the only thing you can do there. */
  for (const tok of ['--btn-h', '--btn-h-full', '--btn-r', '--btn-fs', '--btn-min-w']) {
    assert.match(css, new RegExp('\\' + tok.slice(1) + ':\\s*\\S'), tok + ' is not defined');
  }

  const base = /\n\.wbtn, \.sortb \{([^}]*)\}/.exec(css);
  assert.ok(base, 'there is no single rule that sizes a button');
  assert.match(base[1], /min-height:\s*var\(--btn-h\)/, 'the button height is not the token');
  assert.match(base[1], /font:[^;]*var\(--btn-fs\)/, 'the button font is not the token');
  assert.match(base[1], /border-radius:\s*var\(--btn-r\)/, 'the button radius is not the token');

  const full = /\.act, \.authbtn, \.wbtn\.full \{([^}]*)\}/.exec(css);
  assert.ok(full, 'the full-width action has no rule of its own');
  assert.match(full[1], /min-height:\s*var\(--btn-h-full\)/,
    'the full-width action does not take the taller of the two sizes');

  /* The rule is outside every media query, so a button is the same object on
     a monitor and on a handset. It forked once by being redeclared inside the
     phone layer, and that is what produced 38px against 44px. */
  const narrow = atWidth(css, 'max-width: 720px');
  // Comments stripped first: they talk about these selectors by name.
  const code = narrow.replace(/\/\*[\s\S]*?\*\//g, '');
  const forked = code.match(/\.wbtn[^{}]*\{[^}]*(?:min-height|font-size|border-radius|padding)\s*:/g) || [];
  const bad = forked.filter(r => !/min-width/.test(r));
  assert.deepStrictEqual(bad, [],
    'the phone layer resizes a button again, which is how four heights happened: ' + bad.join(' | '));

  /* A field is not a button: you aim at a button once and it is gone, and you
     aim at a text field, miss, and aim again with the keyboard already up. */
  const fields = /([^{}]*)\{[^}]*min-height:\s*var\(--field-h\)/.exec(code);
  assert.ok(fields, 'nothing holds the fields at the field height');
  for (const sel of ['select', 'input[type="text"]', '.fld textarea']) {
    assert.ok(fields[1].includes(sel), sel + ' is not held at 44px');
  }
  assert.ok(!/\.wbtn/.test(fields[1]),
    'the button is named in the field rule again, so its height has two sources');
  /* But a button standing on a line with a field takes the field's height, or
     the pair reads as two unrelated controls: the head office's Reassign was
     36px beside a 45px picker, centred against it. */
  assert.match(css, /\.uprow \.wbtn, \.fld \.wbtn \{[^}]*min-height:\s*var\(--field-h\)/,
    'a button beside a field does not match its height');

  assert.match(narrow, /\.tab \{[^}]*min-height:\s*44px/, 'the villa detail tabs are still 34px');
  assert.match(narrow, /a\.wrow \{[^}]*min-height:\s*44px/, 'a row that is a link has no minimum height');

  /* Two controls on a line of their own split it evenly. "Accept" is 72px of
     text and "Ask to reassign" is 119px, so left to size themselves they read
     as one button and an afterthought rather than a choice between two. */
  assert.match(narrow, /\.wrow \.actc\.wide \.wbtn \{[^}]*flex:\s*1 1 0/,
    'paired controls do not share their line evenly');
  assert.match(narrow, /\.wrow \.actc:not\(\.wide\) \.wbtn \{[^}]*min-width:\s*var\(--btn-min-w\)/,
    'a single control may shrink below the shared minimum width');
});

test('the money leads its line, tabular, and never breaks mid-value', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
  const amt = /\.wrow \.amt\s+\{([^}]*)\}/.exec(narrow);
  assert.ok(amt, 'no phone rule for the amount cell');
  assert.match(amt[1], /white-space:\s*nowrap/, 'an amount may break mid-value');
  assert.match(amt[1], /tabular-nums/, 'amounts do not line up digit for digit down the column');

  /* The money starts at the card's left edge, on the same line the title and
     the detail start from, and it is the boldest thing on the row. It had been
     right-aligned inside the first column - 169px into a 375px card, lined up
     with nothing above or below it - at 400 weight and 13px, smaller and
     lighter than every other word on the row. It is the figure the row is
     about, so it is not the quietest thing on it. */
  assert.match(amt[1], /justify-self:\s*start/, 'the amount floats in the middle of the row again');
  assert.match(amt[1], /text-align:\s*left/, 'the amount is not aligned with the lines above it');
  const weight = /font:\s*(\d+)/.exec(amt[1]);
  assert.ok(weight && Number(weight[1]) >= 600,
    'the amount is lighter than 600, which is lighter than the title above it');
  assert.match(amt[1], /grid-area:\s*3 \/ 1/, 'the amount is not on the action line');

  const act = /\.wrow \.actc:not\(\.s\):not\(\.wide\) \{([^}]*)\}/.exec(narrow);
  assert.ok(act, 'a single control has no compact placement');
  assert.match(act[1], /grid-area:\s*3 \/ 2 \/ 4 \/ 4/,
    'a single control does not take the right of the amount\'s line');
  assert.match(act[1], /justify-content:\s*flex-end/, 'the control is not against the right edge');

  /* A status word is a third thing that can land on that line, and it must not
     land on top of the amount - spanning the full width printed "Too few
     photographs" straight through "33,60,000". */
  const status = /\.wrow \.actc\.s \{([^}]*)\}/.exec(narrow);
  assert.ok(status, 'no placement for a status word');
  assert.match(status[1], /grid-area:\s*3 \/ 2/, 'a status word overlaps the amount');

  /* The detail stops short of the status column. Run it to the far edge and
     the sentence sits directly under the pill and directly over the button,
     reading as though it were crowding both; a sentence this long then takes
     two lines inside its own width, which is what it should have taken. */
  assert.match(narrow, /\.wrow \.mid p\.s \{[^}]*grid-area:\s*2 \/ 1 \/ 3 \/ 3/,
    'the detail runs the full width of the card, under the pill and over the button');
  assert.match(narrow, /\.wrow \.actc\.wide \{[^}]*grid-area:\s*4 \//,
    'two or more controls must still take their own line, they will not fit beside an amount');
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

test('the phone list is v21\'s, not a table in disguise', async () => {
  const css = await (await get('/app.css')).text();
  const narrow = atWidth(css, 'max-width: 720px');
  // The list is a card, and the rows inside it are rows.
  assert.match(narrow, /\n  \.wl \{[^}]*border:\s*1px solid/, 'the worklist is not a card on a phone');
  // The wrapper is dropped so the meta line can use the full width.
  assert.match(narrow, /\.wrow \.mid \{[^}]*display:\s*contents/,
    'the row wrapper still traps the meta line in one column');
  /* Every list row is a card, in every tab and for all three roles. A flat row
     reads as loose text once the desktop table's columns are gone: there is no
     left edge for the eye to run down. */
  const card = /\n  \.wrow \{([^}]*)\}/.exec(narrow);
  assert.ok(card, 'there is no phone rule for a list row');
  /* A row inside the panel, not a card of its own: the hairline between rows
     is the only division and the panel's edge is the only edge. Forty tiles
     each with their own border and a gap under them is a jigsaw. */
  assert.match(card[1], /border:\s*0/, 'a row still draws its own border inside the card');
  assert.match(card[1], /border-bottom:\s*1px solid var\(--hair\)/,
    'nothing divides one row from the next');
  assert.match(card[1], /margin:\s*0\s*!important/, 'a row still floats on a gap of its own');
  assert.match(narrow, /\.wl > \.wrow:last-child[^{]*\{[^}]*border-bottom:\s*0/,
    'the last row draws a line along the bottom of the card');
  assert.match(card[1], /padding:\s*13px 14px/, 'a list row has no padding of its own');
  /* No margin at all now: the gutter belongs to one container, and the rows
     sit flush inside the panel rather than floating on gaps. A horizontal
     margin here is exactly how a card once ended up inset further than the
     label above it. */
  assert.ok(!/margin:[^;]*\d+px[^;]*;/.test(card[1].replace(/margin:\s*0\s*!important;/, '')),
    'the row sets a margin of its own again');

  /* plint.css:420 sets `gap: 14px !important` on `.wrow` for its desktop
     table. Without `!important` here every card carried 28px of row gaps it
     was never asked for - 20px per card, on every list on every screen. */
  assert.match(card[1], /row-gap:\s*4px\s*!important/,
    'the row gap will lose to plint.css and every card grows 20px');
  assert.match(card[1], /align-items:\s*start/,
    'baseline alignment inflates every track around a 44px control');

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
     slabs half the screen wide. Heights travel as a custom property now, and
     the chart lives in the shared layer rather than in this one screen. */
  const h = await body('/office/owner', 'office');
  const bars = h.match(/<i class="[^"]*" style="([^"]*)"><\/i>/g) || [];
  assert.ok(bars.length > 0, 'no chart columns rendered');
  for (const b of bars) {
    assert.ok(!/style="[^"]*height:/.test(b), 'a column still carries an inline height: ' + b);
    assert.match(b, /--h:|--pct:/, 'a column does not pass its size as a property: ' + b);
  }
});

test('no destination is named after the person reading it', async () => {
  /* "Owner view" and then "Owner dashboard" both named who was looking rather
     than what they were looking at, and an owner does not need telling whose
     dashboard it is. Every other destination in this role is named for its
     content - Today, Ready to send, Sanction not recorded - and this one is
     "The position", which is the question it answers and pairs with Today:
     where we stand, against what needs doing now. */
  const h = await body('/office', 'office');
  const panel = h.split('<nav class="dpanel"')[1] || '';
  assert.ok(panel, 'no menu to read the destination names from');

  /* Destination labels only. The group headings are content and may name a
     party - "Buyer decisions" is whose decisions they are, read by the office,
     which is the right way round. */
  const labels = [...panel.matchAll(/<span class="dl">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.strictEqual(labels.length, 15, 'read ' + labels.length + ' destination labels, not fifteen');
  for (const l of labels) {
    assert.ok(!/^(Owner|Admin|My|Your)/i.test(l),
      'a destination is named after who is reading it: ' + JSON.stringify(l));
  }
  assert.ok(labels.includes('The position'), 'the position has lost its name');
});

test('the owner dashboard answers the three questions it exists for', async () => {
  /* "Looks so empty." It was: one figure and two lists of totals in a column,
     which answers none of what somebody opening it wants to know. Is the money
     coming in, is the work moving, and what is stuck. */
  const h = await body('/office/owner', 'office');

  assert.match(h, /<p class="fig ok">/, 'no headline figure for what has been collected');
  const tiles = (h.match(/class="stat"/g) || []).length;
  assert.strictEqual(tiles, 4, 'the owner sees ' + tiles + ' tiles, not four');

  // Money, work, and how long things have been blocked - three charts.
  const charts = (h.match(/<div class="chart">/g) || []).length;
  assert.strictEqual(charts, 3, 'the owner gets ' + charts + ' charts, not three');
  assert.match(h, /Where the money is/, 'nothing shows how the money divides');
  assert.match(h, /Where the work is/, 'nothing shows how the work divides');
  assert.match(h, /How long things have been blocked/, 'nothing shows what is stuck and for how long');

  /* And every segment carries its own figure, so nothing on the screen is only
     a colour. A legend without numbers is a decoration. */
  /* And a column chart has to be measured against its own plot area. As a
     flex item beside its number and its label the bar's percentage height was
     capped to the space they left, so 15, 17 and 16 all drew at exactly 90px
     - three identical bars for three different counts. */
  assert.match(h, /<span class="well"><i /, 'the chart columns have no plot area to be measured in');

  const keys = (h.match(/class="mixk"/g) || []).length;
  assert.ok(keys >= 6, 'the charts have ' + keys + ' labelled segments between them');
  assert.match(h, /class="mixk">\s*<i[^>]*><\/i>[^<]*<b>/,
    'a chart segment has no figure beside it');
});
