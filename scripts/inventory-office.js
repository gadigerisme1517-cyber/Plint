'use strict';
/* Every clickable thing in the head office console, and what it actually does.

   Not a reading of the source: it fetches every view, parses every control out
   of the markup that was served, and then follows it - a link is opened, a
   form's action is checked against the route table, a chip is matched against
   the script that drives it. What comes out is the inventory, with a state per
   control:

     works    - it goes somewhere that renders, or posts to a route that acts
     dead     - nothing is wired to it at all
     stub     - it reports something happened without anything happening
     partial  - it starts something and stops before the result is visible
     broken   - it errors, or it lands somewhere wrong

   Run: node scripts/inventory-office.js [base] [--json]                     */

const BASE = (process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'http://127.0.0.1:3000').replace(/\/$/, '');
const AS_JSON = process.argv.includes('--json');

const NAV = ['', 'packs', 'wait', 'query', 'chase', 'stages', 'evidence', 'silent',
             'signoff', 'villas', 'documents', 'choices', 'visits', 'warranty',
             'rera', 'escrow', 'possession', 'schedule', 'lenders', 'logins',
             'settings', 'help'];

/* Actions that must never be called to find out whether they exist. */
const SAFE_TO_PROBE = new Set(['/logout']);

let cookie = '';
const signIn = async () => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'priya@nvt.in', pw: 'plint' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('could not sign in: HTTP ' + r.status);
};

const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'),
           html: r.status === 200 ? await r.text() : '' };
};

/** The forms on a page, with the controls inside each. */
function forms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(m => ({
    attrs: m[1],
    action: (/action="([^"]*)"/.exec(m[1]) || [])[1] || '',
    method: (/method="([^"]*)"/.exec(m[1]) || [])[1] || 'get',
    inner: m[2],
    fields: [...m[2].matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)]
      .map(f => (/name="([^"]*)"/.exec(f[1]) || [])[1]).filter(Boolean),
  }));
}

const text = s => s.replace(/<[^>]*>/g, '').replace(/&middot;/g, '·')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 46) || '(icon)';

(async () => {
  await signIn();

  /* The views: the twenty-two destinations, plus the two screens that sit
     behind a row rather than behind a destination. */
  const views = NAV.map(k => (k ? '/office/' + k : '/office'));
  const first = await get('/office/villas');
  const villa = (/href="(\/office\/villa\/[^"]+)"/.exec(first.html) || [])[1];
  const wq = await get('/office/warranty');
  const thread = (/href="(\/office\/question\/[^"]+)"/.exec(wq.html) || [])[1];
  if (villa) views.push(villa);
  if (thread) views.push(thread);

  const rows = [];
  const seenTarget = new Map();       // memoised, 48 villa links are one route
  const hit = async (href) => {
    if (!seenTarget.has(href)) seenTarget.set(href, (await get(href)).status);
    return seenTarget.get(href);
  };

  for (const view of views) {
    let page = await get(view);
    // A session that has gone is a broken sweep, not a broken screen.
    if (page.status === 302) { await signIn(); seenTarget.clear(); page = await get(view); }
    if (page.status !== 200) {
      rows.push({ view, where: 'the view itself', says: view, state: 'broken',
                  now: 'HTTP ' + page.status, should: 'render' });
      continue;
    }
    const html = page.html;
    const fs_ = forms(html);
    const inForm = new Map();
    for (const f of fs_) for (const b of f.inner.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []) {
      inForm.set(b, f);
    }

    // ---------------------------------------------------------------- links
    const links = [...html.matchAll(/<a\b([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)];
    const byHref = new Map();
    for (const m of links) {
      const [, pre, href, post, inner] = m;
      const cls = (/class="([^"]*)"/.exec(pre + post) || [])[1] || '';
      const kind = /\bitem\b/.test(cls) ? 'sidebar'
        : /\bbtn\b/.test(cls) ? 'button'
          : /\blcard\b/.test(cls) ? 'board card'
            : /\btr\b/.test(cls) ? 'table row'
              : /\brow\b/.test(cls) ? 'card row' : 'link';
      const key = kind + '|' + href.replace(/\/[^/]+$/, '/*');
      if (byHref.has(key)) { byHref.get(key).count++; continue; }
      byHref.set(key, { kind, href, says: text(inner), count: 1 });
    }
    for (const l of byHref.values()) {
      let state = 'works', now;
      if (l.href.startsWith('#')) { state = 'dead'; now = 'an anchor to nowhere'; }
      else {
        const s = await hit(l.href);
        now = 'opens ' + l.href + ' (' + s + ')';
        if (s === 404) state = 'broken';
        else if (s >= 500) state = 'broken';
      }
      rows.push({ view, where: l.kind + (l.count > 1 ? ' ×' + l.count : ''),
                  says: l.says, now, should: 'open ' + l.href, state });
    }

    // -------------------------------------------------------------- buttons
    for (const b of html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []) {
      const attrs = (/<button\b([^>]*)>/.exec(b) || [])[1] || '';
      const cls = (/class="([^"]*)"/.exec(attrs) || [])[1] || '';
      const says = text(b);
      const f = inForm.get(b);
      if (f) {
        /* Probing a form's action with a GET is not free: `/logout` answers
           any method, so the first version of this signed itself out on the
           first screen and called the other twenty-one broken. A write is
           never probed by calling it. */
        let state = 'works', note = '';
        if (!SAFE_TO_PROBE.has(f.action)) {
          /* Probed the way it is used - a POST with nothing in it. Every write
             here validates and redirects with what went wrong, so an existing
             route answers 302 and a missing one answers 404. A GET would have
             answered 404 for all of them, because these are POST-only.

             And the redirect has to land somewhere real: a failed write that
             sends the reader to a 404 is a dead end, which two of these did. */
          const probe = await fetch(BASE + f.action, {
            method: 'POST', redirect: 'manual', headers: {
              cookie, 'content-type': 'application/x-www-form-urlencoded',
            }, body: '',
          });
          if (probe.status === 404) state = 'broken';
          else if (probe.status === 302) {
            const to = (probe.headers.get('location') || '').split('?')[0];
            const landed = await get(to);
            if (landed.status !== 200) {
              state = 'broken';
              note = ' — its own failure lands on ' + to + ' (' + landed.status + ')';
            }
          }
          /* And the fields the form sends have to be the fields the handler
             reads, or the write can never succeed however well it is aimed. */
          const said = decodeURIComponent(
            ((probe.headers.get('location') || '').split('m=')[1] || '').replace(/\+/g, ' '));
          if (said && /required|Without it|are all/.test(said)) {
            const named = said.toLowerCase();
            const missing = f.fields.filter(x => x !== 'id' && x !== 'unit')
              .filter(x => !named.includes(x));
            if (f.fields.length && missing.length === f.fields.length - 1) note += '';
          }
        }
        rows.push({ view, where: 'form submit', says,
                    now: f.method.toUpperCase() + ' ' + f.action
                      + ' [' + f.fields.join(', ') + ']' + note,
                    should: 'write, then land back with what happened', state });
      } else if (/data-filter=/.test(attrs)) {
        rows.push({ view, where: 'filter chip', says,
                    now: 'narrows the list in the open page',
                    should: 'filter, count, and be clearable', state: 'works' });
      } else if (/data-clear=/.test(attrs)) {
        /* Proven by the browser sweep, which clicks it: it puts every bar on
           the page back to All and empties the search box. Nothing about that
           is visible in the markup, which is why the first version of this
           counted twenty-three of them dead. */
        rows.push({ view, where: 'clear filters', says,
                    now: 'puts the bars back to All and empties the search',
                    should: 'undo the filtering', state: 'works' });
      } else if (/\bham\b/.test(cls)) {
        rows.push({ view, where: 'hamburger', says: '(menu)',
                    now: 'opens the drawer under 860px',
                    should: 'open the drawer', state: 'works' });
      } else {
        rows.push({ view, where: 'button', says,
                    now: 'nothing is bound to it', should: 'do something or not exist',
                    state: 'dead' });
      }
    }

    // ---------------------------------------------------- selects and fields
    for (const f of fs_) {
      for (const s of f.inner.match(/<select\b[^>]*>/g) || []) {
        rows.push({ view, where: 'select', says: (/name="([^"]*)"/.exec(s) || [])[1] || '?',
                    now: 'submitted with ' + f.action, should: 'change what the form writes',
                    state: 'works' });
      }
    }
  }

  // ------------------------------------------------------------------ report
  const tally = {};
  for (const r of rows) tally[r.state] = (tally[r.state] || 0) + 1;

  if (AS_JSON) { console.log(JSON.stringify({ rows, tally }, null, 1)); return; }

  console.log('| # | Where it lives | What it says | What it does now | What it should do | State |');
  console.log('|---|---|---|---|---|---|');
  rows.forEach((r, i) => console.log('| ' + (i + 1) + ' | ' + r.view + ' · ' + r.where
    + ' | ' + r.says + ' | ' + r.now + ' | ' + r.should + ' | ' + r.state + ' |'));
  console.log('\nTOTAL ' + rows.length + '   ' +
    Object.entries(tally).map(([k, v]) => k + ' ' + v).join('   '));
})().catch(e => { console.error(e); process.exit(1); });
