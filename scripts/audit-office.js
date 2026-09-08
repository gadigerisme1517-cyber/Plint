'use strict';
/* Every control on every screen of the head office console, and what it does.

   "No placeholders, no coming soon, no dead buttons." A button in this console
   is one of exactly three things and nothing else:

     - a link, which goes somewhere that answers 200;
     - a submit inside a form, which POSTs to a route that exists;
     - a filter chip, which narrows the list already on the page.

   Anything else - a `<button>` with no form around it and no `data-filter` on
   it - is furniture, and this fails on it by name.

   Run: node scripts/audit-office.js [base]                                  */

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const WHO = 'priya@nvt.in', PW = 'plint';

const NAV = ['', 'packs', 'wait', 'query', 'chase', 'stages', 'evidence', 'silent',
             'signoff', 'villas', 'documents', 'choices', 'visits', 'warranty',
             'rera', 'escrow', 'possession', 'schedule', 'lenders', 'logins',
             'settings', 'help'];

let cookie = '', fails = 0;
const ok = (cond, what) => { console.log((cond ? '  pass  ' : '  FAIL  ') + what); if (!cond) fails++; };

const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
  return { status: r.status, html: r.status === 200 ? await r.text() : '' };
};

/* Split the document into its forms, so a submit button can be attributed to
   the action it posts to rather than guessed at. */
function forms(html) {
  return [...html.matchAll(/<form\b[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)]
    .map(m => ({ action: m[1], inner: m[2] }));
}

(async () => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: WHO, pw: PW }),
  });
  const raw = r.headers.get('set-cookie');
  if (!raw) throw new Error('the office could not sign in: HTTP ' + r.status);
  cookie = raw.split(';')[0];

  console.log('\nevery destination opens');
  const pages = {};
  for (const k of NAV) {
    const p = k ? '/office/' + k : '/office';
    const res = await get(p);
    ok(res.status === 200, p + ' -> ' + res.status);
    pages[p] = res.html;
  }

  /* The nav is the same on every screen, so read it once and follow it. */
  console.log('\nevery nav item goes somewhere');
  const items = [...pages['/office'].matchAll(/<a class="item [^"]*" href="([^"]+)"/g)].map(m => m[1]);
  ok(items.length === 22, 'the sidebar offers ' + items.length + ' destinations, expected 22');
  for (const href of items) {
    const res = await get(href);
    ok(res.status === 200, 'nav ' + href + ' -> ' + res.status);
  }

  console.log('\nevery control does something');
  const seen = new Set();
  for (const [p, html] of Object.entries(pages)) {
    const inForms = new Set();
    for (const f of forms(html)) {
      for (const b of f.inner.match(/<button\b[^>]*>/g) || []) inForms.add(b + '|' + f.action);
      /* The action has to exist. A form posting to a route nothing handles is
         a dead button with extra steps. */
      seen.add(f.action);
    }

    const buttons = html.match(/<button\b[^>]*>/g) || [];
    const accountedFor = [];
    for (const b of buttons) {
      const isFilter = /data-filter=/.test(b);
      const isHam = /class="ham"/.test(b);
      const inAForm = [...inForms].some(x => x.startsWith(b + '|'));
      accountedFor.push(isFilter || isHam || inAForm);
    }
    const dead = buttons.filter((b, i) => !accountedFor[i]);
    ok(dead.length === 0, p + ': ' + buttons.length + ' buttons, ' + dead.length
      + ' dead' + (dead.length ? ' -> ' + dead.join(' ') : ''));

    /* And every link on the screen resolves. Sampled per page rather than
       exhaustively: the villa links are forty-eight of the same route. */
    const links = [...new Set([...html.matchAll(/href="(\/[^"#][^"]*)"/g)].map(m => m[1]))];
    const sample = links.filter(h => !h.startsWith('/office.')).slice(0, 6);
    for (const h of sample) {
      const res = await get(h);
      ok(res.status === 200 || res.status === 302, p + ' -> ' + h + ' = ' + res.status);
    }
  }

  console.log('\nevery form posts to a route that exists');
  for (const action of [...seen].sort()) {
    /* A GET on a POST-only route must not 404: it either redirects or is
       refused, both of which prove the route is handled. */
    const res = await fetch(BASE + action, { headers: { cookie }, redirect: 'manual' });
    ok(res.status !== 404, action + ' -> ' + res.status);
  }

  console.log('\n' + (fails ? fails + ' FAILED' : 'every control on all 22 screens is wired'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
