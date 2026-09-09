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
  // Five tabs since pass 3: the schedule is the Journey, the ledger is Money.
  const j = await (await get('/journey', buyer)).text();
  ok(/Blockwork/.test(j) && /Every stage, in order/.test(j), 'the ten stage schedule renders');
  const mny = await (await get('/money', buyer)).text();
  ok(/₹1,84,80,000/.test(mny), 'paid so far is ₹1,84,80,000');
  const other = await get('/villa/A-11', buyer);
  ok(other.status === 404, 'another villa answers 404, the same as one that does not exist');
  ok((await get('/office', buyer)).status === 404, 'the buyer cannot open the head-office worklist');

  console.log('\nengineer');
  const e1 = await (await get('/engineer/certs', eng)).text();
  /* A row is a `.tr` in this system; it was a `.wrow` in the retired one. */
  const waiting = (e1.match(/class="tr click"|class="tr" /g) || []).length;
  ok(waiting > 0, waiting + ' stages waiting on a certificate');

  /* The certificate is signed on its own screen now, so the walk is: the list
     offers B-14 blockwork, the certificate reads the figures back, and the
     signature is what raises the demand. */
  const b14Pending = /\/engineer\/cert\/us-B-14-brick/.test(e1);
  if (b14Pending) {
    const doc = await (await get('/engineer/cert/us-B-14-brick', eng)).text();
    ok(/Engineer's certificate of stage completion/.test(doc), 'the certificate document renders');
    ok(/₹33,60,000/.test(doc), 'the certificate states what it releases before it is signed');
    ok(/KAR\/CE\/2014\/8842/.test(doc), 'the certificate carries the signing registration');
    ok(/name="id" value="us-B-14-brick"/.test(doc), 'the signature form is on the certificate');

    const r = await fetch(BASE + '/engineer/certify', {
      method: 'POST', redirect: 'manual', headers: {
        cookie: eng, 'content-type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ id: 'us-B-14-brick' }),
    });
    const msg = decodeURIComponent(r.headers.get('location') || '');
    ok(/certified/.test(msg) && /₹33,60,000/.test(msg),
       'certifying B-14 blockwork raises a demand for ₹33,60,000');
  } else {
    /* Do not simply pass. An earlier run having certified it is a claim, and
       the claim is checkable: the demand exists. Reporting ok() here without
       looking is how a suite goes green while the flow is broken - which is
       exactly what happened when the control moved screens. */
    const d = await get('/doc/demand/us-B-14-brick.pdf', eng);
    ok(d.status === 200, 'B-14 blockwork was certified on an earlier run, and its demand exists');
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
  const v = await (await get('/office/villas', office)).text();
  /* Read off Villas, which is the register: every villa, once, linked. The
     dashboard leads with what has stopped rather than with all forty-eight. */
  const rows = (v.match(/href="\/office\/villa\//g) || []).length;
  ok(rows === 48, 'the register shows all 48 villas (' + rows + ')');

  /* The dashboard leads with who is holding each villa up - the question this
     desk opens with. The pack states are the second question and are a click
     away, not gone. */
  ok(/<div class="board">/.test(o), 'there is no board on the dashboard');
  ok(/>The engineer</.test(o) && />The lender</.test(o) && />This office</.test(o)
     && />The buyer</.test(o), 'the board is not grouped by who is holding it up');
  const packView = await (await get('/office?view=packs', office)).text();
  ok(/>Certified, pack not sent</.test(packView) && />With the lender</.test(packView),
     'the pack-state view has been lost rather than moved');
  /* And the dashboard leads with the money that has stopped: what is waiting
     on evidence, as the largest thing on the screen. */
  ok(/class="eyebrow">Waiting on evidence</.test(o) && /<div class="big num">₹/.test(o),
     'the money waiting on evidence is not the headline figure');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
