'use strict';
/* ============================================================================
   The restore drill, as a test.

   A backup nobody has restored is a hope. This dumps the working database,
   restores it into a fresh one, and then checks the thing that actually
   matters: that the restored rows still point at photographs that exist, so a
   completion certificate can be reproduced from the restore.

   It also runs a negative control. The first version of the photograph check
   passed against a freshly seeded database because seeded evidence rows carry
   no files, so the loop ran zero times and reported success. A check that
   cannot fail is not a check, so this uploads real photographs first and then
   proves the check catches one going missing.
   ========================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { asUser, pool } = require('../src/db');
const config = require('../src/config');
const EV = require('../src/evidence');

const ENG = { id: 'u-eng-ram', role: 'engineer' };
const PORT = 3211, BASE = 'http://127.0.0.1:' + PORT;
const server = require('../src/server');

const TARGET = 'plint_restore_' + crypto.randomBytes(3).toString('hex');
const DUMP = path.join(os.tmpdir(), 'plint-drill-' + crypto.randomBytes(3).toString('hex') + '.dump');

before(() => new Promise(r => server.listen(PORT, r)));
after(async () => {
  await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  const c = new Client(config.adminDb({ database: 'postgres' }));
  await c.connect().catch(() => {});
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                  WHERE datname = $1 AND pid <> pg_backend_pid()`, [TARGET]).catch(() => {});
  await c.query(`DROP DATABASE IF EXISTS "${TARGET}"`).catch(() => {});
  await c.end().catch(() => {});
  fs.rmSync(DUMP, { force: true });
  await pool.end();
});

/* ---------------------------------------------------------------- tooling
   pg_dump may be on PATH, or only inside WSL on a Windows box. Resolve it
   once; if neither works the test fails loudly rather than skipping, because
   "we could not run the drill" is not the same as "the drill passed". */
const toWsl = p => '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');

let runner = null;
function resolveRunner() {
  if (runner) return runner;
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    runner = { kind: 'path', dumpPath: DUMP };
    return runner;
  } catch { /* try WSL */ }
  try {
    execFileSync('wsl', ['-d', 'Ubuntu', '-u', 'root', '-e', 'bash', '-lc', 'pg_dump --version'],
      { stdio: 'ignore' });
    runner = { kind: 'wsl', dumpPath: toWsl(DUMP) };
    return runner;
  } catch { /* neither */ }
  throw new Error('neither pg_dump on PATH nor a WSL Ubuntu carrying it; the restore drill cannot run');
}

function pgTool(tool, args) {
  const r = resolveRunner();
  const env = `PGPASSWORD='${process.env.PGADMINPASSWORD}'`;
  if (r.kind === 'path') {
    return execFileSync(tool, args, {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: process.env.PGADMINPASSWORD },
    });
  }
  const quoted = args.map(a => `'${a}'`).join(' ');
  return execFileSync('wsl',
    ['-d', 'Ubuntu', '-u', 'root', '-e', 'bash', '-lc', `${env} ${tool} ${quoted}`],
    { encoding: 'utf8' });
}

const conn = () => [
  '--host=' + process.env.PGHOST,
  '--port=' + (process.env.PGPORT || '5432'),
  '--username=' + process.env.PGADMINUSER,
];

// A real 1x1 PNG, distinct per call so hashes differ.
function png(seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, seed, 40, 90]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let uploaded = [];

test('photographs exist to be lost, so the integrity check can bite', async () => {
  const cookie = (await (await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'ramachandran@nvt.in', pw: 'plint' }),
  })).headers.get('set-cookie')).split(';')[0];

  for (const seed of [11, 22]) {
    const data = png(seed);
    const B = '----drill' + crypto.randomBytes(4).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="stage"\r\n\r\nus-B-14-brick\r\n`),
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nDrill photograph ${seed}\r\n`),
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="gps"\r\n\r\n12.8391, 77.7724\r\n`),
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo"; filename="d.png"\r\nContent-Type: image/png\r\n\r\n`),
      data, Buffer.from(`\r\n--${B}--\r\n`),
    ]);
    const r = await fetch(BASE + '/evidence/upload', {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=' + B }, body,
    });
    assert.strictEqual(r.status, 302);
    uploaded.push(EV.sha256(data));
  }

  const n = await asUser(ENG, c =>
    c.query('SELECT count(*)::int n FROM evidence WHERE mime IS NOT NULL'));
  assert.ok(n.rows[0].n >= 2, 'there are stored files for the drill to check');
});

test('the database dumps and restores into a fresh one', async () => {
  const r = resolveRunner();

  pgTool('pg_dump', [...conn(), '--dbname=' + process.env.PGDATABASE,
    '--format=custom', '--compress=9', '--no-owner', '--no-privileges',
    '--file=' + r.dumpPath]);
  assert.ok(fs.existsSync(DUMP) && fs.statSync(DUMP).size > 1000, 'a dump was written');

  const admin = new Client(config.adminDb({ database: 'postgres' }));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${TARGET}"`);
  await admin.query(`CREATE DATABASE "${TARGET}" OWNER "${process.env.PGADMINUSER}"`);
  await admin.end();

  pgTool('pg_restore', [...conn(), '--dbname=' + TARGET,
    '--no-owner', '--no-privileges', '--exit-on-error', r.dumpPath]);
});

test('the restored database carries the whole evidence trail', async () => {
  const live = new Client(config.adminDb());
  const back = new Client(config.adminDb({ database: TARGET }));
  await live.connect(); await back.connect();
  try {
    for (const t of ['units', 'unit_stages', 'demands', 'audit_log', 'evidence',
                     'schema_migrations', 'pack_deliveries']) {
      const a = (await live.query(`SELECT count(*)::int n FROM plint.${t}`)).rows[0].n;
      const b = (await back.query(`SELECT count(*)::int n FROM plint.${t}`)).rows[0].n;
      assert.strictEqual(b, a, `${t}: restored ${b}, original ${a}`);
      assert.ok(a > 0, `${t} was not empty to begin with, so the comparison means something`);
    }

    // Row-level security is schema, so it must survive a restore. A database
    // restored with RLS off would serve every buyer every villa.
    const rls = await back.query(
      `SELECT count(*)::int n FROM pg_tables WHERE schemaname='plint' AND rowsecurity`);
    assert.ok(rls.rows[0].n >= 8, 'RLS is on the restored tables: ' + rls.rows[0].n);

    /* FORCE is deliberately gone as of migration 010, so the restored database
       is checked for what actually keeps a buyer out of his neighbour's villa:
       that the runtime role is not an owner and cannot bypass RLS. FORCE only
       ever bound the owner, and the owner is the migrations and the seed. */
    const bypass = await back.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'plint_app'`);
    assert.strictEqual(bypass.rows[0].rolsuper, false,
      'the restored runtime role must not be a superuser');
    assert.strictEqual(bypass.rows[0].rolbypassrls, false,
      'nor hold BYPASSRLS');

    const owned = await back.query(
      `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='plint' AND c.relkind='r'
          AND pg_get_userbyid(c.relowner) = 'plint_app'`);
    assert.strictEqual(owned.rows[0].n, 0,
      'and must own none of the tables, because an owner bypasses RLS');

    // The figures, not just the counts.
    const sum = t => t.query(
      'SELECT coalesce(sum(total_paise),0)::bigint s FROM plint.demands').then(r => r.rows[0].s);
    assert.strictEqual(String(await sum(back)), String(await sum(live)),
      'the restored demands total the same to the paise');

    /* The audit trail reconciles with what it describes. This is the check
       that found the fault in the first place: a database can restore
       perfectly and still be one where nobody signed anything. Now that the
       rows are written by a trigger rather than by whoever remembered, these
       must agree exactly, and on the restored copy as well as the live one. */
    for (const [label, t] of [['live', live], ['restored', back]]) {
      const r = (await t.query(`
        SELECT (SELECT count(*) FROM plint.unit_stages WHERE certified_at IS NOT NULL) certified,
               (SELECT count(*) FROM plint.audit_log WHERE action='certified')        audited,
               (SELECT count(*) FROM plint.demands WHERE paid_at IS NOT NULL)         settled,
               (SELECT count(*) FROM plint.audit_log WHERE action='demand_settled')   settle_audited
      `)).rows[0];
      assert.strictEqual(r.audited, r.certified,
        `${label}: ${r.certified} certified stages but ${r.audited} audit rows`);
      assert.strictEqual(r.settle_audited, r.settled,
        `${label}: ${r.settled} settled demands but ${r.settle_audited} audit rows`);
      assert.ok(Number(r.certified) > 200, `${label}: and there is real history to reconcile`);
    }

    // Every certification is attributable to somebody who exists.
    const orphan = await back.query(`
      SELECT count(*)::int n FROM plint.audit_log a
       WHERE NOT EXISTS (SELECT 1 FROM plint.users u WHERE u.id = a.actor_id)`);
    assert.strictEqual(orphan.rows[0].n, 0, 'no audit row names an actor who does not exist');
  } finally { await live.end(); await back.end(); }
});

test('every restored evidence row points at a photograph that exists', async () => {
  const back = new Client(config.adminDb({ database: TARGET }));
  await back.connect();
  try {
    const rows = (await back.query(
      'SELECT sha256 FROM plint.evidence WHERE mime IS NOT NULL')).rows;
    assert.ok(rows.length >= 2,
      'there must be stored files to check, or this test passes by doing nothing');

    for (const { sha256 } of rows) {
      assert.ok(fs.existsSync(EV.pathFor(sha256)),
        `restored row points at ${sha256}, which is not on disk`);
    }
  } finally { await back.end(); }
});

test('and the check would notice if one went missing', async () => {
  // The negative control. Without this, the test above passes on an empty set
  // and on a full one alike, which is how the first version of it shipped.
  const hash = uploaded[0];
  const file = EV.pathFor(hash);
  const stashed = file + '.stashed';

  fs.renameSync(file, stashed);
  try {
    const back = new Client(config.adminDb({ database: TARGET }));
    await back.connect();
    const rows = (await back.query(
      'SELECT sha256 FROM plint.evidence WHERE mime IS NOT NULL')).rows;
    await back.end();

    const missing = rows.filter(r => !fs.existsSync(EV.pathFor(r.sha256)));
    assert.strictEqual(missing.length, 1,
      'the integrity check must detect the photograph that was removed');
    assert.strictEqual(missing[0].sha256, hash);
  } finally {
    fs.renameSync(stashed, file);
  }

  assert.ok(fs.existsSync(file), 'and it is put back');
});

test('a certificate can still be produced from the restored data', async () => {
  // The point of the whole exercise. Not "the rows are there" but "the rows
  // and the bytes together still make the document a lender asked for".
  const back = new Client(config.adminDb({ database: TARGET }));
  await back.connect();
  let rows;
  try {
    rows = (await back.query(
      `SELECT e.sha256, e.mime FROM plint.evidence e
        WHERE e.unit_stage_id = 'us-B-14-brick' AND e.mime IS NOT NULL`)).rows;
  } finally { await back.end(); }

  assert.ok(rows.length >= 2, 'the restored stage has photographs');
  for (const r of rows) {
    const thumb = await EV.thumbnail(r.sha256);
    assert.ok(thumb.length > 0, 'a thumbnail regenerates from the restored bytes');
    assert.strictEqual(thumb.subarray(0, 3).toString('latin1'),
      Buffer.from([0xFF, 0xD8, 0xFF]).toString('latin1'), 'and it is a JPEG');
  }
});
