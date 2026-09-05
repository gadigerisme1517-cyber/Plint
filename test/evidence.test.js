'use strict';
/* ============================================================================
   Evidence photographs: stored, hashed, and fetchable only by the buyer whose
   villa they belong to.

   The assertion that matters is the last kind: a buyer holding the exact
   sha256 of a neighbour's photograph - the whole secret, not a guess at it -
   still cannot fetch the file. Knowing the address of a thing is not
   authorisation to read it, because the address is not what authorises.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fs = require('node:fs');

const { asUser, pool } = require('../src/db');
const EV = require('../src/evidence');

const PORT = 3171, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const ENG = { id: 'u-eng-ram', role: 'engineer' };

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await pool.end();
});

// --------------------------------------------------------- a real 1x1 PNG
/* Built rather than pasted, so each call can differ in its pixel and produce a
   genuinely different hash. Two villas must not share a content address, or
   the isolation test below would pass for the wrong reason. */
function png(r, g, b) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const signIn = async email => {
  const r = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, pw: 'plint' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
};

/** A multipart body, assembled by hand so the test does not share the parser. */
function multipart(fields, file) {
  const B = '----plinttest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo"; ` +
      `filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${B}--\r\n`));
  return { body: Buffer.concat(parts), type: 'multipart/form-data; boundary=' + B };
}

const upload = async (cookie, fields, file) => {
  const { body, type } = multipart(fields, file);
  return fetch(BASE + '/evidence/upload', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': type }, body,
  });
};

// A stage on each of the two villas that have a real buyer behind them.
const stageOf = unit => asUser(ENG, c => c.query(
  `SELECT id FROM unit_stages WHERE unit_id=$1 ORDER BY id LIMIT 1`, [unit]))
  .then(r => r.rows[0].id);

let engCookie, b14Hash, a07Hash, b14Stage, a07Stage;

test('an engineer files a photograph against a stage', async () => {
  engCookie = await signIn('ramachandran@nvt.in');
  b14Stage = await stageOf('unit-B-14');

  const image = png(200, 30, 30);
  const r = await upload(engCookie,
    { stage: b14Stage, caption: 'External blockwork, north', gps: '12.8391, 77.7724' },
    { name: 'IMG_0042.png', type: 'image/png', data: image });

  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /Photograph filed/);

  b14Hash = EV.sha256(image);
  const row = (await asUser(ENG, c => c.query(
    'SELECT * FROM evidence WHERE sha256=$1', [b14Hash]))).rows[0];
  assert.ok(row, 'the evidence row exists');
  assert.strictEqual(row.mime, 'image/png');
  assert.strictEqual(Number(row.byte_size), image.length);
  assert.strictEqual(row.uploaded_by, ENG.id);
  assert.strictEqual(row.caption, 'External blockwork, north');
});

test('the file is on disk at its content address, and the bytes hash to it', async () => {
  const p = EV.pathFor(b14Hash);
  assert.ok(fs.existsSync(p), 'stored at the content-addressed path');
  assert.strictEqual(EV.sha256(fs.readFileSync(p)), b14Hash,
    'what is on disk hashes to the name it is stored under');
  assert.ok(p.includes(b14Hash.slice(0, 2)), 'sharded by the first bytes of the hash');
});

test('the client-supplied filename never reaches the path', async () => {
  const image = png(11, 22, 33);
  const r = await upload(engCookie,
    { stage: b14Stage, caption: 'Traversal attempt', gps: '12.8, 77.7' },
    { name: '../../../../etc/passwd', type: 'image/png', data: image });
  assert.strictEqual(r.status, 302);

  const hash = EV.sha256(image);
  assert.ok(fs.existsSync(EV.pathFor(hash)), 'stored under its hash, as always');
  assert.strictEqual(fs.existsSync('/etc/passwd.png'), false);
  const row = (await asUser(ENG, c => c.query(
    'SELECT caption FROM evidence WHERE sha256=$1', [hash]))).rows[0];
  assert.ok(row, 'and the row is ordinary');
});

test('anything that is not a JPEG or PNG is refused', async () => {
  const notAnImage = Buffer.from('%PDF-1.7\nnot a photograph at all\n');
  const r = await upload(engCookie,
    { stage: b14Stage, caption: 'Nice try', gps: '12.8, 77.7' },
    { name: 'photo.png', type: 'image/png', data: notAnImage });

  assert.match(decodeURIComponent(r.headers.get('location')), /Only JPEG and PNG/);
  const hash = EV.sha256(notAnImage);
  assert.strictEqual(fs.existsSync(EV.pathFor(hash)), false, 'nothing was written');
  const row = await asUser(ENG, c => c.query('SELECT 1 FROM evidence WHERE sha256=$1', [hash]));
  assert.strictEqual(row.rows.length, 0, 'and no row was made');
});

test('a declared content-type does not make bytes an image', async () => {
  // The part claims image/jpeg. The bytes are a PNG-shaped lie with a bad
  // signature. Sniffing wins.
  const bad = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x00]), Buffer.alloc(64)]);
  const r = await upload(engCookie,
    { stage: b14Stage, caption: 'Mislabelled', gps: '12.8, 77.7' },
    { name: 'x.jpg', type: 'image/jpeg', data: bad });
  assert.match(decodeURIComponent(r.headers.get('location')), /Only JPEG and PNG/);
});

test('a buyer cannot file evidence', async () => {
  const buyer = await signIn('arjun@example.in');
  const r = await upload(buyer,
    { stage: b14Stage, caption: 'Forged', gps: '0,0' },
    { name: 'a.png', type: 'image/png', data: png(1, 2, 3) });
  assert.strictEqual(r.status, 404, 'the route is not there for him');
});

// ------------------------------------------------------------ the acceptance

test('a buyer fetches his own villa photograph', async () => {
  const buyer = await signIn('arjun@example.in');
  const r = await fetch(BASE + '/evidence/' + b14Hash, { headers: { cookie: buyer } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  const got = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(EV.sha256(got), b14Hash, 'byte-for-byte what was stored');
});

test('a buyer cannot fetch another villa image, even holding its exact hash', async () => {
  // File a different photograph against the neighbouring villa.
  a07Stage = await stageOf('unit-A-07');
  const image = png(9, 180, 240);
  a07Hash = EV.sha256(image);
  assert.notStrictEqual(a07Hash, b14Hash, 'genuinely different content');

  const up = await upload(engCookie,
    { stage: a07Stage, caption: 'Neighbour blockwork', gps: '12.8, 77.7' },
    { name: 'n.png', type: 'image/png', data: image });
  assert.strictEqual(up.status, 302);
  assert.ok(fs.existsSync(EV.pathFor(a07Hash)), 'the file is genuinely there to be fetched');

  // Its own buyer can read it, so the 404 below is about authorisation and not
  // about a missing file.
  const sharma = await signIn('sharma@example.in');
  const his = await fetch(BASE + '/evidence/' + a07Hash, { headers: { cookie: sharma } });
  assert.strictEqual(his.status, 200, "A-07's buyer can read A-07's photograph");

  // The neighbour, holding the exact hash.
  const arjun = await signIn('arjun@example.in');
  const theirs = await fetch(BASE + '/evidence/' + a07Hash, { headers: { cookie: arjun } });
  assert.strictEqual(theirs.status, 404,
    'the correct hash of a neighbour photograph is still a 404');

  // And the same answer as a hash that was never issued: no existence leak.
  const never = await fetch(BASE + '/evidence/' + 'f'.repeat(64), { headers: { cookie: arjun } });
  assert.strictEqual(never.status, 404, 'indistinguishable from one that does not exist');
});

test('an unauthenticated request gets nothing', async () => {
  const r = await fetch(BASE + '/evidence/' + b14Hash, { redirect: 'manual' });
  assert.strictEqual(r.status, 302, 'bounced to sign in');
});

// ------------------------------------------------------- thumbnails on the PDF

test('the completion certificate carries real embedded photographs', async () => {
  // B-14 blockwork is the certified stage the other suites use. Give it a
  // photograph with actual bytes, then read the certificate.
  const image = png(70, 90, 110);
  await upload(engCookie,
    { stage: 'us-B-14-brick', caption: 'Internal partitions, filed', gps: '12.8391, 77.7724' },
    { name: 'p.png', type: 'image/png', data: image });

  const r = await fetch(BASE + '/doc/certificate/us-B-14-brick.pdf', { headers: { cookie: engCookie } });
  assert.strictEqual(r.status, 200);
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');

  const text = pdf.toString('latin1');
  assert.match(text, /\/Subtype\s*\/Image/,
    'an image XObject is embedded, not merely a caption about one');

  fs.writeFileSync(__dirname + '/../out/certificate-B-14-blockwork.pdf', pdf);
});

test('four large photographs make a certificate a lender gateway will accept', async () => {
  const sharp = require('sharp');
  const crypto = require('node:crypto');

  // Real site-photograph sizes. Random pixels so JPEG cannot compress them
  // away: this has to be genuinely several megabytes, or the test proves
  // nothing about resizing.
  async function bigPhoto(seed) {
    const w = 2400, h = 1800;
    const raw = Buffer.allocUnsafe(w * h * 3);
    crypto.randomFillSync(raw);
    raw[0] = seed;                                  // a different hash each time
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 92 }).toBuffer();
  }

  const stage = 'us-B-14-brick';
  let originalBytes = 0;
  for (let i = 0; i < 4; i++) {
    const photo = await bigPhoto(i);
    originalBytes += photo.length;
    assert.ok(photo.length > 1_000_000,
      `test photograph ${i} is only ${photo.length} bytes; it must be large to mean anything`);
    assert.ok(photo.length <= EV.MAX_BYTES, 'and within the upload cap');

    const r = await upload(engCookie,
      { stage, caption: 'Site photograph ' + (i + 1), gps: '12.8391, 77.7724' },
      { name: 'DSC_' + i + '.jpg', type: 'image/jpeg', data: photo });
    assert.strictEqual(r.status, 302);
    assert.match(decodeURIComponent(r.headers.get('location')), /Photograph filed/);
  }

  const r = await fetch(BASE + '/doc/certificate/' + stage + '.pdf', { headers: { cookie: engCookie } });
  assert.strictEqual(r.status, 200);
  const pdf = Buffer.from(await r.arrayBuffer());

  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.toString('latin1'), /\/Subtype\s*\/Image/, 'the photographs are on it');
  assert.ok(pdf.length < 1_048_576,
    `the certificate is ${(pdf.length / 1048576).toFixed(2)} MB, from ` +
    `${(originalBytes / 1048576).toFixed(1)} MB of originals; it must be under 1 MB`);

  fs.writeFileSync(__dirname + '/../out/certificate-four-large.pdf', pdf);
});

test('the thumbnail is cached beside the original, keyed by hash', async () => {
  const thumb = EV.thumbPathFor(b14Hash);
  assert.strictEqual(fs.existsSync(thumb), false,
    'nothing has needed this thumbnail yet, so it has not been made');

  const first = await EV.thumbnail(b14Hash);
  assert.ok(fs.existsSync(thumb), 'the derivative was written on first use');
  assert.ok(first.length > 0);
  assert.ok(thumb.startsWith(EV.pathFor(b14Hash)), 'beside the original, under its hash');
  assert.match(thumb, /thumb-480q70\.jpg$/, 'and keyed by the settings that made it');

  // Second call comes off the cache: same bytes, and the file is not rewritten.
  const before = fs.statSync(thumb).mtimeMs;
  const again = await EV.thumbnail(b14Hash);
  assert.strictEqual(fs.statSync(thumb).mtimeMs, before, 'not regenerated');
  assert.ok(again.equals(fs.readFileSync(thumb)));
  assert.strictEqual(again.subarray(0, 3).toString('latin1'),
    Buffer.from([0xFF, 0xD8, 0xFF]).toString('latin1'), 'a JPEG, whatever the original was');
});
