'use strict';
/* ============================================================================
   THE PAGES, RUN AS A BROWSER RUNS THEM.

   Every other suite in this project reads markup. Not one of them has ever
   executed a line of page script, and that gap has shipped twice: a stray
   `})();` left in an extracted filter runtime threw a SyntaxError in BOTH
   shells and every filter, search box and Clear on every screen stopped
   working. The markup was perfect. Every test was green. It was caught by a
   person clicking a chip.

   So this suite loads real pages in a real browser and runs their script.

   THE BAR, ON EVERY SINGLE PAGE LOAD:
     - no console error
     - no uncaught exception
     - no failed request from the page
     - no "undefined", "NaN" or "[object Object]" in the rendered text
   Any one of those fails the test. Not a warning.

   Then it drives the things that only exist in script - a chip, a search box,
   Clear, the drawer, a toast - because a runtime that loads without throwing
   can still do nothing at all, which is the other half of what shipped.

   THE BROWSER. playwright-core drives the Chrome or Edge already installed on
   the machine, so nothing is downloaded. If neither is there this suite FAILS
   rather than skipping: a browser test that quietly does not run is exactly
   the hole this suite exists to close.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { pool } = require('../src/db');

const PORT = 3243, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const ROLES = {
  buyer: 'arjun@example.in',
  engineer: 'ramachandran@nvt.in',
  office: 'priya@nvt.in',
};

/* Every screen, by the role that owns it. Kept explicit so that adding one
   without deciding it must survive a browser is a failure here, not an
   orphan. */
const SCREENS = {
  office: ['/office', '/office?view=packs', '/office/packs', '/office/wait',
           '/office/query', '/office/chase', '/office/stages', '/office/evidence',
           '/office/silent', '/office/signoff', '/office/villas', '/office/documents',
           '/office/choices', '/office/visits', '/office/warranty', '/office/rera',
           '/office/escrow', '/office/possession', '/office/dpdp',
           '/office/news', '/office/plans',
           '/office/schedule', '/office/lenders',
           '/office/logins', '/office/settings', '/office/help'],
  engineer: ['/engineer', '/engineer/news', '/engineer/villas', '/engineer/visits', '/engineer/log',
             '/engineer/certs', '/engineer/snags', '/engineer/log/material',
             '/engineer/villa/A-01', '/engineer/villa/A-01?mode=flag',
             '/engineer/villa/A-01?mode=snag'],
  buyer: ['/journey', '/villa/B-14', '/visit', '/money', '/more', '/bank', '/loan',
          '/agreement', '/choices', '/questions', '/documents', '/news', '/plans',
          '/stage/book', '/questions/q-b14-1'],
};

let browser, contexts = {};
/* Counted so the report cannot claim more coverage than was run. */
const stats = { pages: 0, interactions: 0 };

before(async () => {
  await new Promise(r => server.listen(PORT, r));

  const exe = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  assert.ok(exe, 'no Chrome or Edge found in any of:\n  ' + CHROMES.join('\n  ')
    + '\nThis suite drives a real browser and will not pretend to pass without one.');
  browser = await chromium.launch({ executablePath: exe });

  for (const [role, email] of Object.entries(ROLES)) {
    const r = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, pw: 'plint' }),
    });
    const raw = r.headers.get('set-cookie');
    assert.ok(raw, role + ' could not sign in');
    const value = raw.split(';')[0].split('=')[1];
    contexts[role] = await browser.newContext();
    await contexts[role].addCookies([{
      name: 'plint', value, domain: '127.0.0.1', path: '/',
      httpOnly: true, secure: false, sameSite: 'Lax',
    }]);
  }
});

after(async () => {
  for (const c of Object.values(contexts)) await c.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

/**
 * Open a page with every alarm armed, and hand it back still armed so the
 * caller can drive it. `check()` throws with everything that went wrong.
 */
async function open(role, path_, viewport) {
  const page = await contexts[role].newPage();
  if (viewport) await page.setViewportSize(viewport);
  const problems = [];
  page.on('console', m => {
    if (m.type() === 'error') problems.push('console error: ' + m.text());
  });
  page.on('pageerror', e => problems.push('uncaught: ' + e.message));
  page.on('requestfailed', r => {
    /* A navigation the test itself abandons is not a page fault. */
    if (r.failure() && !/ERR_ABORTED/.test(r.failure().errorText)) {
      problems.push('request failed: ' + r.url() + ' ' + r.failure().errorText);
    }
  });
  const res = await page.goto(BASE + path_, { waitUntil: 'load' });
  stats.pages++;
  if (!res || res.status() !== 200) problems.push('HTTP ' + (res && res.status()));

  page.check = async (what) => {
    const text = await page.evaluate(() => document.body.innerText);
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      if (text.includes(bad)) problems.push('renders "' + bad + '"');
    }
    assert.deepStrictEqual(problems, [], (what || role + ' ' + path_) + ' — ' + problems.join(' | '));
  };
  return page;
}

// ---------------------------------------------------------------------------

test('every screen of every role loads in a browser without a single error',
  async () => {
    for (const [role, paths] of Object.entries(SCREENS)) {
      for (const p of paths) {
        const page = await open(role, p);
        await page.check(role + ' ' + p);
        await page.close();
      }
    }
    /* Plus the two screens that sit behind a row rather than behind a
       destination, discovered rather than hardcoded. */
    const office = await open('office', '/office/villas');
    const villa = await office.$eval('a[href^="/office/villa/"]', a => a.getAttribute('href'));
    await office.close();
    for (const p of [villa, '/office/question/q-b14-w']) {
      const page = await open('office', p);
      await page.check('office ' + p);
      await page.close();
    }
  });

test('the office filter runtime actually runs', async () => {
  const page = await open('office', '/office/villas');
  await page.check('office /office/villas');

  const count = () => page.$eval('[data-count="villalist"] .fnum', e => e.textContent.trim());
  const before = await count();
  assert.match(before, /^\d+$/, 'the count is not a plain total on load: ' + before);

  // a chip
  await page.click('.filters[data-scope="villalist"] .chip[data-filter="stuck"]');
  stats.interactions++;
  const filtered = await count();
  assert.match(filtered, /^\d+ of \d+$/, 'a chip did not narrow the list: ' + filtered);
  assert.notStrictEqual(filtered, before, 'the chip changed nothing');

  // the search box
  await page.fill('[data-search="villalist"]', 'zzqqxx');
  stats.interactions++;
  const searched = await count();
  assert.match(searched, /^0 of \d+$/, 'a search that matches nothing left rows showing: ' + searched);
  const none = await page.$eval('#villalist .filtered-empty', e => !e.hidden);
  assert.ok(none, 'a list filtered to nothing does not say so');

  // Clear
  await page.click('[data-clear="villalist"]');
  stats.interactions++;
  assert.strictEqual(await count(), before, 'Clear did not return the list to its full count');
  assert.strictEqual(await page.inputValue('[data-search="villalist"]'), '',
    'Clear left the search box full');
  await page.check('office /office/villas after filtering');
  await page.close();
});

test('the engineer filter runtime actually runs', async () => {
  /* The engineer's shell is a different document from the office's and loads a
     different stylesheet; the runtime is shared. When it was extracted it
     broke in BOTH, so both are driven. */
  const page = await open('engineer', '/engineer/villas');
  await page.check('engineer /engineer/villas');

  const count = () => page.$eval('[data-count="engvillas"] .fnum', e => e.textContent.trim());
  const before = await count();
  assert.match(before, /^\d+$/, 'the count is not a plain total on load: ' + before);

  await page.click('.filters[data-scope="engvillas"] .chip[data-filter="quiet"]');
  stats.interactions++;
  const filtered = await count();
  assert.match(filtered, /^\d+ of \d+$/, 'a chip did not narrow the engineer list: ' + filtered);

  await page.fill('[data-search="engvillas"]', 'zzqqxx');
  stats.interactions++;
  assert.match(await count(), /^0 of \d+$/, 'the engineer search box does nothing');

  await page.click('[data-clear="engvillas"]');
  stats.interactions++;
  assert.strictEqual(await count(), before, 'Clear did not restore the engineer list');
  await page.check('engineer /engineer/villas after filtering');
  await page.close();
});

test('the office drawer opens at 375 and the scrim closes it', async () => {
  const page = await open('office', '/office', { width: 375, height: 812 });
  await page.check('office /office at 375');

  const shut = await page.$eval('.side', e => getComputedStyle(e).transform);
  assert.notStrictEqual(shut, 'none', 'the sidebar is not off-canvas at 375');

  await page.click('#ham');
  stats.interactions++;
  /* Waited for where it ENDS, not for the class. `.side` slides on a 200ms
     transition, so reading the box the instant the class lands catches it
     mid-flight - the first version of this measured -225 and called a working
     drawer broken. */
  await page.waitForFunction(
    () => Math.round(document.querySelector('.side').getBoundingClientRect().left) === 0,
    null, { timeout: 4000 });
  const left = await page.$eval('.side', e => Math.round(e.getBoundingClientRect().left));
  /* `Math.round(-0.4)` is negative zero, and `strictEqual` compares with
     Object.is - which says -0 is not 0. A drawer sitting exactly where it
     should was reported as broken, with a message reading "left is 0". */
  assert.ok(Math.abs(left) < 1, 'the drawer did not slide in: left is ' + left);

  /* Clicked to the RIGHT of the drawer. `.scrim2` is `inset: 0`, so its centre
     - where a plain click lands - is underneath the 250px drawer on a 375px
     screen, the drawer swallows the event and the click times out waiting for
     an element that will never receive it. A reader dismisses a drawer by
     tapping the part of the page they can still see. */
  await page.click('#scrim2', { position: { x: 330, y: 500 } });
  stats.interactions++;
  await page.waitForFunction(
    () => Math.round(document.querySelector('.side').getBoundingClientRect().left) < 0,
    null, { timeout: 4000 });
  await page.check('office /office at 375 after the drawer');
  await page.close();
});

test('a toast appears when a write says what it did', async () => {
  /* The toast is the only thing on these screens that reports a write, and it
     is put on the screen by script - `requestAnimationFrame` then a class.
     Markup alone cannot prove it ever becomes visible. */
  const page = await open('office',
    '/office?m=' + encodeURIComponent('Swept by the browser suite.'));
  /* Waited for the opacity it ends at. The toast fades in over 200ms, so the
     moment the class lands it is still at 0.98 and an equality check on "1"
     fails on a toast that works perfectly. */
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('toast')).opacity === '1',
    null, { timeout: 4000 });
  stats.interactions++;
  const shown = await page.$eval('#toast', e => ({
    text: e.textContent.trim(), opacity: getComputedStyle(e).opacity,
  }));
  assert.strictEqual(shown.text, 'Swept by the browser suite.');
  assert.strictEqual(shown.opacity, '1', 'the toast is in the markup but never becomes visible');
  await page.check('office toast');
  await page.close();
});

test('the drawer opens for the buyer and the engineer too', async () => {
  /* All three roles are one shell from Pass 4, so the drawer is not the office's
     any more. It was a bottom tab bar for these two, and the bar is gone. */
  for (const role of ['buyer', 'engineer']) {
    const page = await open(role, role === 'buyer' ? '/journey' : '/engineer',
      { width: 375, height: 812 });
    await page.check(role + ' at 375');
    await page.click('#ham');
    stats.interactions++;
    await page.waitForFunction(
      () => Math.round(document.querySelector('.side').getBoundingClientRect().left) === 0,
      null, { timeout: 4000 });
    await page.click('#scrim2', { position: { x: 330, y: 500 } });
    stats.interactions++;
    await page.waitForFunction(
      () => Math.round(document.querySelector('.side').getBoundingClientRect().left) < 0,
      null, { timeout: 4000 });
    await page.check(role + ' drawer at 375');
    await page.close();
  }
});

test('the photographs are images the browser actually loaded', async () => {
  /* Markup can carry an <img> whose src 404s and the page still passes a text
     check. This asks the browser what it decoded. */
  for (const [role, path] of [['buyer', '/stage/book'], ['engineer', '/engineer/villa/A-01']]) {
    const page = await open(role, path);
    await page.check(role + ' ' + path);
    const shots = await page.$$eval('.phg .ph img', els => els.map(e => ({
      w: e.naturalWidth, h: e.naturalHeight, src: e.getAttribute('src'),
    })));
    assert.ok(shots.length, path + ' shows no photographs at all');
    for (const s of shots) {
      assert.ok(s.w > 0 && s.h > 0,
        path + ' has a photograph the browser could not decode: ' + s.src);
    }
    /* And tapping one opens it larger. */
    await page.click('.phg .ph');
    stats.interactions++;
    await page.waitForFunction(() => /\/evidence\/[0-9a-f]{64}$/.test(location.pathname),
      null, { timeout: 4000 });
    stats.pages++;
    await page.close();
  }
});

test('the journey timeline is drawn, and a finished stage is filled green', async () => {
  const page = await open('buyer', '/journey');
  await page.check('buyer /journey');
  const dots = await page.$$eval('.tls', els => els.map(e => ({
    state: e.className,
    fill: getComputedStyle(e.querySelector('.tld')).backgroundColor,
    op: getComputedStyle(e).opacity,
  })));
  assert.ok(dots.length >= 10, 'the timeline drew ' + dots.length + ' steps');
  const done = dots.find(d => d.state.split(' ').includes('done'));
  const wait = dots.find(d => d.state.split(' ').includes('wait'));
  assert.ok(done, 'no step reads as finished');
  assert.strictEqual(done.fill, 'rgb(18, 133, 91)',
    'a finished step is not filled with the green token: ' + done.fill);
  assert.ok(Number(wait.op) < 1, 'a step not yet reached is not quieter');

  /* The line itself fills as the work is done. */
  const fill = await page.$eval('.tlfill', e => e.getBoundingClientRect().height);
  assert.ok(fill > 0, 'the line does not fill at all');
  await page.close();
});

test('a styled file input still says which file was chosen', async () => {
  /* The control is hidden behind its own label so it can be a button in this
     system. The name of the file is the one thing hiding it loses, and script
     writes it back. */
  const page = await open('engineer', '/engineer/villa/A-01');
  await page.check('engineer villa before choosing a file');
  const id = await page.$eval('.ffi', e => e.id);
  await page.setInputFiles('#' + id, {
    name: 'blockwork-north.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]),
  });
  stats.interactions++;
  await page.waitForFunction(
    id => document.querySelector('[data-for="' + id + '"]').textContent.includes('blockwork'),
    id, { timeout: 4000 });
  await page.check('engineer villa after choosing a file');
  await page.close();
});

test('a write made with no signal is held on the phone, and goes when it comes back',
  async () => {
    /* THE OUTBOX, IN A REAL BROWSER, WITH THE NETWORK ACTUALLY CUT.

       The force quit half of this - killing the browser with rows in it and
       finding them on reopen - needs a persistent profile, which Chromium
       will not give a working CacheStorage under automation. It is proved
       separately and by hand. What is guarded here is the part that can
       regress silently: with the network down a write does not navigate, does
       not claim to be saved, and is still there afterwards; when the network
       returns it goes, in order, and the outbox empties. */
    const ctx = contexts.engineer;
    const page = await open('engineer', '/engineer/log/labour');
    await page.check('engineer log before the network goes');

    await ctx.setOffline(true);
    const before = await page.$eval('#outbox', e => e.hidden);
    assert.strictEqual(before, true, 'the outbox is showing with nothing in it');

    /* Two quick entries, in order, both while offline. */
    const buttons = await page.$$('form[action="/engineer/log"] button[type="submit"]');
    await buttons[0].click(); stats.interactions++;
    await page.waitForFunction(() => !document.getElementById('outbox').hidden, null,
      { timeout: 5000 });
    await buttons[1].click(); stats.interactions++;
    await page.waitForFunction(
      () => document.querySelectorAll('#outbox .obl li').length === 2, null, { timeout: 5000 });

    const held = await page.evaluate(() => ({
      text: document.getElementById('outbox').innerText.replace(/\s+/g, ' '),
      url: location.pathname,
      pressed: [...document.querySelectorAll('form[action="/engineer/log"] button')]
        .map(b => b.textContent.trim()),
    }));
    assert.match(held.text, /waiting on this phone/i,
      'the outbox does not say the writes are held here: ' + held.text);
    assert.match(held.text, /not sent/i,
      'the outbox does not say they have not reached the office');
    assert.ok(!/saved|filed|logged:/i.test(held.text),
      'the outbox says something that reads as saved: ' + held.text);
    assert.strictEqual(held.url, '/engineer/log/labour',
      'the page moved on as though the write had gone through');
    assert.ok(held.pressed.some(t => /held on this phone/i.test(t)),
      'the button that was pressed does not say where the write actually is');

    /* And nothing reached the office. */
    const seen = await page.evaluate(() => new Promise(res => {
      const rq = indexedDB.open('plint-outbox', 1);
      rq.onsuccess = () => {
        const g = rq.result.transaction('writes', 'readonly').objectStore('writes').getAll();
        g.onsuccess = () => res(g.result.map(r => r.kind + ':' + r.state));
      };
      rq.onerror = () => res([]);
    }));
    assert.deepStrictEqual(seen, ['log:waiting', 'log:waiting'],
      'the queue does not hold both writes as waiting: ' + seen.join(', '));

    await ctx.setOffline(false);
    stats.interactions++;
    await page.waitForFunction(
      () => document.getElementById('outbox').hidden
        || /reached the office/i.test(document.getElementById('outbox').innerText),
      null, { timeout: 15000 });
    const after = await page.evaluate(() => new Promise(res => {
      const rq = indexedDB.open('plint-outbox', 1);
      rq.onsuccess = () => {
        const g = rq.result.transaction('writes', 'readonly').objectStore('writes').getAll();
        g.onsuccess = () => res(g.result.length);
      };
      rq.onerror = () => res(-1);
    }));
    assert.strictEqual(after, 0, after + ' writes are still held after the network came back');
    await page.check('engineer log after the queue flushed');
    await page.close();
  });

test('the browser layer covered what it claims to have covered', async () => {
  /* A coverage figure nobody checks is a figure that quietly falls. */
  const planned = Object.values(SCREENS).reduce((n, l) => n + l.length, 0) + 2;
  assert.ok(stats.pages >= planned,
    'loaded ' + stats.pages + ' pages, planned at least ' + planned);
  /* Eighteen, and they are named: three on the office list (chip, search,
     Clear), three on the engineer's, two on the office drawer (open, dismiss),
     four on the buyer's and the engineer's drawers, two photographs opened
     full size, one file chosen and one toast. Raised only when more are
     actually driven. */
  assert.ok(stats.interactions >= 19,
    'drove ' + stats.interactions + ' interactions, expected at least 19');
  console.log('        browser layer: ' + stats.pages + ' page loads, '
    + stats.interactions + ' scripted interactions');
});
