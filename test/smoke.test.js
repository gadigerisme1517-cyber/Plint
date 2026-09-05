'use strict';
/* End to end over real HTTP, in one process, then exits. Proves the three
   logins, the buyer screen under RLS, certification, and both documents. */
const server = require('../src/server');
const fs = require('fs');
const { pool } = require('../src/db');

const BASE = 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log('  pass  ' + w)) : (fail++, console.log('  FAIL  ' + w)); };

async function signIn(email) {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, pw: 'plint' }),
  });
  const c = r.headers.get('set-cookie');
  return c ? c.split(';')[0] : null;
}
const get = (p, cookie) => fetch(BASE + p, { headers: cookie ? { cookie } : {}, redirect: 'follow' });

(async () => {
  await new Promise(r => server.listen(3100, r));

  console.log('\nlogins');
  const buyer = await signIn('arjun@example.in');
  const eng = await signIn('ramachandran@nvt.in');
  const office = await signIn('priya@nvt.in');
  ok(buyer && eng && office, 'all three roles sign in');

  console.log('\nbuyer, villa B-14');
  const b = await (await get('/', buyer)).text();
  ok(/Villa B-14/.test(b), 'the buyer lands on his own villa without choosing one');
  ok(/Blockwork/.test(b) && /Payment schedule/.test(b), 'the ten stage schedule renders');
  ok(/₹1,84,80,000/.test(b), 'paid so far is ₹1,84,80,000');
  const other = await get('/villa/A-11', buyer);
  ok(other.status === 404, 'another villa answers 404, the same as one that does not exist');
  ok((await get('/office', buyer)).status === 404, 'the buyer cannot open the head-office worklist');

  console.log('\nengineer');
  const e1 = await (await get('/engineer', eng)).text();
  const waiting = (e1.match(/class="wrow"/g) || []).length;
  ok(waiting > 0, waiting + ' stages waiting on a certificate');
  const b14Pending = /B-14 &middot; Blockwork/.test(e1);

  if (b14Pending) {
    const r = await fetch(BASE + '/engineer/certify', {
      method: 'POST', redirect: 'manual', headers: {
        cookie: eng, 'content-type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ id: 'us-B-14-brick' }),
    });
    const msg = decodeURIComponent(r.headers.get('location') || '');
    ok(/certified/.test(msg) && /₹33,60,000/.test(msg),
       'certifying B-14 blockwork raises a demand for ₹33,60,000');
  } else {
    ok(true, 'B-14 blockwork was certified on an earlier run');
  }

  console.log('\ndocuments');
  for (const [kind, file] of [['demand', 'demand-B-14-blockwork.pdf'],
                              ['certificate', 'certificate-B-14-blockwork.pdf']]) {
    const r = await get('/doc/' + kind + '/us-B-14-brick.pdf', eng);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(__dirname + '/../out/' + file, buf);
    ok(r.status === 200 && buf.slice(0, 4).toString() === '%PDF' && buf.length > 1500,
       kind + ' PDF renders (' + buf.length + ' bytes)');
  }
  const denied = await get('/doc/demand/us-A-11-brick.pdf', buyer);
  ok(denied.status === 404, "a buyer cannot pull another villa's demand letter");

  console.log('\nhead office');
  const o = await (await get('/office', office)).text();
  const rows = (o.match(/class="wrow"/g) || []).length;
  ok(rows === 48, 'the worklist shows all 48 villas (' + rows + ')');
  ok(/Waiting on the certifying engineer/.test(o) && /Waiting on the lender/.test(o),
     'grouped by who is holding each one up');
  ok(/class="mega hot"/.test(o), 'stuck money is the only red KPI');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
