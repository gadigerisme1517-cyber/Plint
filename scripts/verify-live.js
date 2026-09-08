'use strict';
/* ============================================================================
   Walks the deployed site as every role and reports what actually works.

   Written after a hand-rolled check reported a reassignment flow "verified"
   while the second engineer did not exist on that database: the login returned
   no cookie, the request went out unauthenticated, the grep found nothing, and
   the absence read as success. Every step here fails loudly instead - a login
   that yields no cookie is an error, not an empty string passed onward.

     node scripts/verify-live.js https://plint-o0vr.onrender.com

   It performs real writes. Point it at a demo, not at anything that matters.
   ========================================================================= */

const BASE = (process.argv[2] || 'https://plint-o0vr.onrender.com').replace(/\/$/, '');
const PW = 'plint';

const WHO = {
  buyer:    'arjun@example.in',
  engineer: 'ramachandran@nvt.in',
  second:   'venkatesh@nvt.in',
  office:   'priya@nvt.in',
};

const SCREENS = {
  buyer:    ['/villa/B-14', '/documents'],
  engineer: ['/engineer', '/engineer/villas', '/engineer/visits', '/engineer/log',
             '/engineer/certs', '/engineer/snags', '/engineer/log/material'],
  office:   ['/office', '/office/packs', '/office/wait', '/office/query',
             '/office/chase', '/office/stages', '/office/evidence', '/office/silent',
             '/office/signoff', '/office/villas', '/office/documents', '/office/choices',
             '/office/visits', '/office/warranty', '/office/rera', '/office/escrow',
             '/office/possession', '/office/schedule', '/office/lenders',
             '/office/logins', '/office/settings', '/office/help'],
};

let failures = 0;
const ok   = (cond, what) => { console.log((cond ? '  pass  ' : '  FAIL  ') + what); if (!cond) failures++; };
const note = what => console.log('        ' + what);

const cookies = {};

async function signIn(role) {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: WHO[role], pw: PW }),
  });
  const raw = r.headers.get('set-cookie');
  // The whole point: no cookie is a failure, never an empty string to carry on with.
  if (!raw) throw new Error(role + ' (' + WHO[role] + ') could not sign in: HTTP ' + r.status);
  cookies[role] = raw.split(';')[0];
}

const get = async (role, path) => {
  const r = await fetch(BASE + path, { headers: { cookie: cookies[role] }, redirect: 'manual' });
  return { status: r.status, html: r.status === 200 ? await r.text() : '' };
};
const post = async (role, path, fields) => {
  const r = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookies[role], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: r.status, said: decodeURIComponent(r.headers.get('location') || '') };
};

(async () => {
  console.log('\n' + BASE);

  console.log('\nbuild');
  const home = await (await fetch(BASE + '/')).text();
  const build = (/app\.([0-9a-f]{12})\.css/.exec(home) || [])[1];
  ok(!!build, 'the site reports a build hash: ' + build);

  console.log('\nsign in');
  for (const role of Object.keys(WHO)) {
    try { await signIn(role); ok(true, role + ' signs in'); }
    catch (e) { ok(false, e.message); }
  }
  if (failures) { console.log('\ncannot continue without every role\n'); process.exit(1); }

  console.log('\nscreens');
  for (const [role, paths] of Object.entries(SCREENS)) {
    for (const p of paths) {
      const r = await get(role, p);
      ok(r.status === 200, role + ' ' + p + ' -> ' + r.status);
    }
  }

  console.log('\nthe site has more than one engineer');
  const before = await get('engineer', '/engineer/villas');
  const mine = (before.html.match(/\/engineer\/villa\/[A-Z]-\d\d/g) || []).length;
  const theirs = ((await get('second', '/engineer/villas')).html.match(/\/engineer\/villa\/[A-Z]-\d\d/g) || []).length;
  ok(mine > 0 && theirs > 0,
     'work is split: ' + mine + ' villas on one engineer, ' + theirs + ' on another');

  console.log('\nengineer logs the day, the office reads it');
  const title = 'Live check ' + new Date().toISOString().slice(11, 19);
  const w = await post('engineer', '/engineer/log', { kind: 'material', title });
  ok(/Logged/.test(w.said), 'the entry was accepted: ' + w.said);
  ok((await get('engineer', '/engineer/log')).html.includes(title), 'the engineer sees it');
  ok((await get('buyer', '/engineer/log')).status === 404, 'the buyer cannot open the site log');

  console.log('\noffice reassigns a villa, it moves between engineers');
  const code = (/\/engineer\/villa\/([A-Z]-\d\d)/.exec(before.html) || [])[1];
  ok(!!code, 'picked ' + code + ' off the first engineer\'s list');
  if (code) {
    const move = await post('office', '/office/assign',
      { unit: 'unit-' + code, engineer: 'u-eng-venkat' });
    ok(/reassigned/.test(move.said), 'the office could reassign it: ' + move.said);
    const gone = !(await get('engineer', '/engineer/villas')).html.includes('villa/' + code);
    const got  =  (await get('second',   '/engineer/villas')).html.includes('villa/' + code);
    ok(gone, code + ' left the first engineer\'s list');
    ok(got,  code + ' arrived on the second engineer\'s list');
    const back = await post('office', '/office/assign',
      { unit: 'unit-' + code, engineer: 'u-eng-ram' });
    ok(/reassigned/.test(back.said), 'and it was put back');
  }

  console.log('\nthe boundary holds');
  for (const p of ['/engineer', '/engineer/villas', '/office']) {
    ok((await get('buyer', p)).status === 404, 'a buyer cannot open ' + p);
  }
  const forged = await post('buyer', '/engineer/log', { kind: 'material', title: 'forged by a buyer' });
  ok(!/Logged/.test(forged.said), 'a buyer cannot write to the site log');
  ok(!(await get('engineer', '/engineer/log')).html.includes('forged by a buyer'),
     'nothing a buyer posted reached the log');

  console.log('\n' + '-'.repeat(56));
  console.log(failures ? failures + ' FAILED\n' : 'everything checked passed\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('\n' + e.message + '\n'); process.exit(1); });
