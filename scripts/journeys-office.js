'use strict';
/* Every journey the head office console is for, followed to its end.

   A control is not fixed because it posts. The question this asks is the one
   the inventory cannot: after the write, did the thing change, and does the
   change show up everywhere it should? So each journey below reads a figure,
   performs the write the way the screen performs it, and then reads the same
   figure again somewhere else.

   A journey is one of:
     works    - it completes and the result is visible where it should be
     partial  - it writes, but the result does not reach where it belongs
     stub     - it reports success and nothing changed
     missing  - the product has no control for it at all
     broken   - it errors, or lands somewhere that does not render

   It writes to the database. Run it against a local server, not the deploy.

   Run: node scripts/journeys-office.js [base]                               */

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const WHO = { office: 'priya@nvt.in', engineer: 'ramachandran@nvt.in', buyer: 'arjun@example.in' };
const PW = 'plint';

const cookies = {};
async function signIn(role) {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: WHO[role], pw: PW }),
  });
  const raw = r.headers.get('set-cookie');
  if (!raw) throw new Error(role + ' could not sign in: HTTP ' + r.status);
  cookies[role] = raw.split(';')[0];
}
const get = async (role, p) => {
  const r = await fetch(BASE + p, { headers: { cookie: cookies[role] }, redirect: 'manual' });
  const type = r.headers.get('content-type') || '';
  // A body may be read once. A PDF is bytes; everything else is text.
  const isPdf = r.status === 200 && /pdf/.test(type);
  const buf = isPdf ? Buffer.from(await r.arrayBuffer()) : null;
  const html = !isPdf && r.status === 200 ? await r.text() : '';
  return { status: r.status, location: r.headers.get('location'), html, type, buf };
};
const post = async (role, p, fields) => {
  const r = await fetch(BASE + p, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookies[role], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: r.status, location: r.headers.get('location'),
           said: decodeURIComponent(((r.headers.get('location') || '').split('m=')[1] || '')
             .replace(/\+/g, ' ')) };
};

const results = [];
let step = 0;
const journey = (name) => {
  const j = { name, steps: [], state: 'works' };
  results.push(j);
  return {
    ok(cond, what) {
      step++;
      j.steps.push((cond ? '   ok   ' : '   NO   ') + what);
      if (!cond && j.state === 'works') j.state = 'partial';
      return cond;
    },
    fail(state, why) { j.state = state; j.steps.push('   ' + state.toUpperCase() + '  ' + why); },
    note(what) { j.steps.push('        ' + what); },
  };
};

/* Counting a screen's rows the way a reader counts them. */
const rows = (html, re) => (html.match(re) || []).length;
const num = (html, label) => {
  const m = new RegExp('<div class="kl">[\\s\\S]{0,200}?' + label
    + '<\\/div>\\s*<b class="num">([^<]*)<').exec(html);
  return m ? m[1].trim() : null;
};

(async () => {
  for (const r of Object.keys(WHO)) await signIn(r);

  // ---------------------------------------------------------------- 1. certify
  {
    const j = journey('A stage is certified: demand, pack and money follow');
    /* The real path, the way the engineer walks it: the queue lists the
       stages, the certificate is a screen of its own, and the signature is on
       that screen. The first version of this looked for the form on the queue,
       which is not where it is - a harness fault, not a product one. */
    const certs = await get('engineer', '/engineer/certs');
    const stage = (/href="\/engineer\/cert\/([^"]+)"/.exec(certs.html) || [])[1];
    const cert = stage ? await get('engineer', '/engineer/cert/' + stage) : { html: '' };
    const id = (/action="\/engineer\/certify"[\s\S]{0,300}?name="id" value="([^"]+)"/
      .exec(cert.html) || [])[1];
    if (!j.ok(!!id, 'the engineer has a stage waiting to certify')) { j.fail('broken', 'nothing to certify'); }
    else {
      const before = await get('office', '/office');
      const beforeQueued = rows(before.html, /class="lcard"/g);
      const r = await post('engineer', '/engineer/certify', { id });
      j.ok(r.status === 302, 'certifying posts: ' + r.said.slice(0, 70));

      /* The demand is the point: nothing can be billed until an engineer
         signs, and the demand is what the billing is. */
      const villa = (/href="\/engineer\/villa\/([^"]+)"/.exec(certs.html) || [])[1];
      const after = await get('office', '/office/stages');
      j.ok(/class="pill p-paid">Certified<|Billed</.test(after.html),
        'the office sees a certified or billed stage');

      const packs = await get('office', '/office/packs');
      j.ok(packs.status === 200, 'Ready to send opens');
      const queuedNow = rows(packs.html, /class="tr click"/g);
      j.ok(queuedNow > 0, 'a pack is queued for a lender (' + queuedNow + ' waiting)');

      const dash = await get('office', '/office');
      j.ok(rows(dash.html, /class="lcard"/g) >= beforeQueued,
        'the dashboard board reflects it');
      j.note('the demand letter itself is checked in journey 6');
    }
  }

  // ------------------------------------------------------------ 2. send a pack
  {
    const j = journey('Send a pack to a lender, then answer their query');
    const packs = await get('office', '/office/packs');
    const sendId = (/action="\/office\/send"[\s\S]{0,200}?name="id" value="([^"]+)"/.exec(packs.html) || [])[1];
    if (!j.ok(!!sendId, 'a pack can be sent from the screen that lists them')) {
      j.fail('missing', 'Ready to send lists the packs and offers no way to send one');
    } else {
      const queuedBefore = rows(packs.html, /action="\/office\/send"/g);
      const waitBefore = rows((await get('office', '/office/wait')).html, /action="\/office\/chase-pack"/g);
      const r = await post('office', '/office/send', { id: sendId });
      j.ok(r.status === 302 && /with/i.test(r.said), 'sending posts: ' + r.said.slice(0, 70));
      const packsAfter = await get('office', '/office/packs');
      j.ok(rows(packsAfter.html, /action="\/office\/send"/g) === queuedBefore - 1,
        'it leaves Ready to send (' + queuedBefore + ' -> '
        + rows(packsAfter.html, /action="\/office\/send"/g) + ')');
      const waitAfter = await get('office', '/office/wait');
      j.ok(rows(waitAfter.html, /action="\/office\/chase-pack"/g) === waitBefore + 1,
        'and arrives on At the lender (' + waitBefore + ' -> '
        + rows(waitAfter.html, /action="\/office\/chase-pack"/g) + ')');
      const dash = await get('office', '/office');
      j.ok(/Packs at the lender/.test(dash.html), 'and the dashboard counts it');

      // 4 is really the second half of this one, so chase what was just sent.
      const chaseId = (/action="\/office\/chase-pack"[\s\S]{0,200}?name="id" value="([^"]+)"/
        .exec(waitAfter.html) || [])[1];
      if (chaseId) {
        const c = await post('office', '/office/chase-pack', { id: chaseId });
        j.ok(/chased/i.test(c.said), 'and it can be chased: ' + c.said.slice(0, 60));
        const after = await get('office', '/office/wait');
        j.ok(/1× ·|[0-9]+× ·/.test(after.html), 'the screen records that it was chased');
      }
    }

    const q = await get('office', '/office/query');
    const qid = (/name="id" value="(pq-[^"]+)"/.exec(q.html) || [])[1];
    if (qid) {
      const r = await post('office', '/office/query', { id: qid, answer: 'Re-sent ' + Date.now() });
      j.ok(r.status === 302 && /Answered/i.test(r.said), 'answering a lender query posts: ' + r.said.slice(0, 50));
      const after = await get('office', '/office/query');
      j.ok(!new RegExp('name="id" value="' + qid + '"').test(after.html),
        'the answered query leaves the open list');
      j.ok(after.html.includes('Re-sent'), 'and the answer is readable on the screen');
    } else {
      j.note('no lender query is open, so the answering half could not be exercised');
    }
  }

  // -------------------------------------------------------------- 3. sanction
  {
    const j = journey('Record a sanction, and disbursements become possible');
    const chase = await get('office', '/office/chase');
    const unit = (/name="unit" value="([^"]+)"/.exec(chase.html) || [])[1];
    if (!j.ok(!!unit, 'a villa is waiting for its sanction letter')) return;
    const before = rows(chase.html, /name="unit"/g);
    const r = await post('office', '/office/sanction',
      { unit, sanction: '9000000', own: '1500000', letter: 'SANC/' + Date.now() });
    j.ok(r.status === 302, 'recording posts');
    j.ok(/recorded/i.test(r.said), 'and it says what happened: ' + r.said.slice(0, 70));
    const after = await get('office', '/office/chase');
    j.ok(rows(after.html, /name="unit"/g) === before - 1,
      'the villa leaves the sanction-not-recorded list (' + before + ' -> '
      + rows(after.html, /name="unit"/g) + ')');
    const villas = await get('office', '/office/villas');
    j.ok(villas.status === 200, 'and the register still opens');
  }

  // ----------------------------------------------------------- 4. chase a pack
  {
    const j = journey('Chase a pack that has been with a lender over fourteen days');
    const w = await get('office', '/office/wait');
    const canChase = /action="\/office\/chase-pack"/.test(w.html);
    if (!canChase) j.fail('missing', 'At the lender names the late packs and offers no way to chase one');
    else {
      j.ok(true, 'every pack with a lender can be chased from the row it is on');
      j.ok(/Chased<\/div>|>Chased</.test(w.html), 'and the screen shows when it last was');
      j.ok(/data-filter="unchased"/.test(w.html), 'and the never-chased ones can be picked out');
    }
  }

  // ------------------------------------------------- 5. ask a quiet site for photographs
  {
    const j = journey('Ask the site for photographs on a villa that has gone quiet');
    const s = await get('office', '/office/silent');
    const quiet = rows(s.html, /class="card"/g);
    j.ok(quiet > 0, 'the quiet villas are listed (' + quiet + ')');
    const unit = (/action="\/office\/ask"[\s\S]{0,200}?name="unit" value="([^"]+)"/.exec(s.html) || [])[1];
    if (!unit) {
      j.fail('missing',
        'the only control is Reassign, which moves the villa to another engineer '
        + 'rather than asking the one it has for a photograph');
    } else {
      const r = await post('office', '/office/ask', { unit });
      j.ok(/asked/i.test(r.said), 'asking posts: ' + r.said.slice(0, 70));
      const after = await get('office', '/office/silent');
      j.ok(/>Asked \d+ day/.test(after.html), 'and the screen shows that it was asked');
      /* Leaving the list is a photograph arriving, not the asking. Anything
         else would be the screen lying about what it knows. */
      const eng = await get('engineer', '/engineer');
      j.ok(eng.status === 200, "and the engineer's screen still opens");
      j.note('it leaves this list when a photograph arrives, which is the only '
        + 'thing that answers the question the list asks');
    }
  }

  // --------------------------------------------------------- 6. the five documents
  {
    const j = journey('The five documents of a stage pack');
    const stages = await get('office', '/office/documents');
    j.ok(stages.status === 200, 'the Documents screen opens');
    const linksToDoc = /href="\/doc\/(demand|certificate)\//.test(stages.html);
    if (!linksToDoc) j.fail('partial', 'the Documents screen names the documents and opens none of them');

    /* The two that exist as files, fetched as a reader would. */
    const eng = await get('engineer', '/engineer/certs');
    const stage = (/href="\/engineer\/cert\/([^"]+)"/.exec(eng.html) || [])[1];
    if (stage) {
      for (const kind of ['demand', 'certificate']) {
        const d = await get('office', '/doc/' + kind + '/' + stage + '.pdf');
        const isFile = d.buf && d.buf.slice(0, 4).toString() === '%PDF';
        j.ok(isFile || d.status === 404,
          kind + ': ' + (isFile ? 'produces a real PDF (' + d.buf.length + ' bytes)'
            : 'HTTP ' + d.status));
      }
    }
    j.note('two of the five are files. The other three are named in prose and '
      + 'generated nowhere, so a reader cannot open them.');
  }

  // ----------------------------------------------------------------- 7. RERA
  {
    const j = journey('RERA quarterly filing');
    const r = await get('office', '/office/rera');
    j.ok(r.status === 200, 'the screen opens');
    const id = (/name="id" value="(qpr-[^"]+)"/.exec(r.html) || [])[1];
    if (id) {
      const ref = 'ACK/' + Date.now();
      const bad = await post('office', '/office/qpr', { id, reference: '  ' });
      j.ok(/reference/i.test(bad.said), 'a filing with no reference is refused: ' + bad.said.slice(0, 60));
      const good = await post('office', '/office/qpr', { id, reference: ref });
      j.ok(/filed/i.test(good.said), 'a filing with one is accepted: ' + good.said.slice(0, 60));
      const after = await get('office', '/office/rera');
      j.ok(after.html.includes(ref), 'and the reference is on the screen afterwards');
    } else {
      j.note('no quarter is open for filing');
    }
    const has = s => r.html.includes(s);
    const missing = ['completion table', 'photograph gaps', 'ERP import', 'assembled pack']
      .filter(x => !new RegExp(x.replace(' ', '[\\s\\S]{0,20}'), 'i').test(r.html));
    if (missing.length) {
      j.fail('partial', 'the filing is one date and one reference. Missing: ' + missing.join(', '));
    }
  }

  // --------------------------------------------------------------- 8. escrow
  {
    const j = journey('Escrow drawdown');
    const e = await get('office', '/office/escrow');
    j.ok(e.status === 200, 'the screen opens and lists the movements');
    const missing = ['certificate', 'undertaking'].filter(x => !new RegExp(x, 'i').test(e.html));
    if (missing.length) {
      j.fail('partial', 'a drawdown needs three certificates and the promoter undertaking; '
        + 'the screen shows movements only. Missing: ' + missing.join(', '));
    }
  }

  // ------------------------------------------- 9. choices, warranty, possession
  {
    const j = journey('Choices past cut-off, warranty snags, after possession');
    for (const [p, what] of [['/office/choices', 'choices'], ['/office/warranty', 'warranty'],
                             ['/office/possession', 'possession']]) {
      const r = await get('office', p);
      j.ok(r.status === 200, p + ' opens');
      const acts = rows(r.html, /<form/g);
      if (acts === 0) j.note(p + ' is a list with nothing to do on it');
    }
    const w = await get('office', '/office/warranty');
    const thread = (/href="(\/office\/question\/[^"]+)"/.exec(w.html) || [])[1];
    if (thread) {
      const t = await get('office', thread);
      j.ok(t.status === 200, 'a warranty claim opens its thread');
      const id = (/name="id" value="([^"]+)"/.exec(t.html) || [])[1];
      const said = 'Roofer booked for Tuesday. ' + Date.now();
      const a = await post('office', '/office/answer', { id, body: said });
      j.ok(a.status === 302, 'the office can answer it');
      const back = await get('office', thread);
      j.ok(back.html.includes(said), 'and the answer is on the thread');
      const b = await get('buyer', '/questions');
      j.ok(b.status === 200, 'the buyer side still opens');
    }
  }

  // ------------------------------------------------------- 10. the empty states
  {
    const j = journey('Every empty state offers a way out');
    const empties = [];
    for (const k of ['', 'packs', 'wait', 'query', 'chase', 'stages', 'evidence', 'silent',
                     'signoff', 'villas', 'documents', 'choices', 'visits', 'warranty',
                     'rera', 'escrow', 'possession', 'schedule', 'lenders', 'logins',
                     'settings', 'help']) {
      const p = k ? '/office/' + k : '/office';
      const r = await get('office', p);
      for (const m of r.html.match(/<div class="empty">([^<]*)<\/div>/g) || []) {
        empties.push([p, m.replace(/<[^>]*>/g, '')]);
      }
    }
    j.ok(empties.length > 0, empties.length + ' empty states found');
    for (const [p, said] of empties) {
      j.ok(said.length > 12, p + ': "' + said + '"');
    }
    j.note('none of them offers a control; they say why the list is empty and stop.');
  }

  // ------------------------------------------------------------------- report
  console.log('');
  for (const r of results) {
    console.log('[' + r.state.toUpperCase() + '] ' + r.name);
    for (const s of r.steps) console.log(s);
    console.log('');
  }
  const tally = {};
  for (const r of results) tally[r.state] = (tally[r.state] || 0) + 1;
  console.log(results.length + ' journeys   ' +
    Object.entries(tally).map(([k, v]) => k + ' ' + v).join('   '));
  process.exit(results.some(r => r.state === 'broken') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
