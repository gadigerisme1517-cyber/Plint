'use strict';
/* ============================================================================
   npm test.

   Creates a scratch database, migrates it, seeds it, runs every suite against
   it, then drops it. The developer database is never touched, and a suite that
   leaves a row behind - a settled demand, an audit line that by design cannot
   be deleted - does not poison the next run.

   Each suite runs in its own process, so a pool left open or a process.exit in
   one cannot affect another.
   ========================================================================= */
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');

const SUITES = [
  'money.test.js',       // pure calculation first: if this is wrong, nothing else matters
  'isolation.test.js',   // then the boundary, as it has always run
  'smoke.test.js',       // then the three screens end to end
  'session.test.js',
  'ledger.test.js',
  'evidence.test.js',
  'pack.test.js',
];

const SCRATCH = 'plint_test_' + crypto.randomBytes(4).toString('hex');
const EVIDENCE = fs.mkdtempSync(path.join(os.tmpdir(), 'plint-evidence-'));

const env = {
  ...process.env,
  PGDATABASE: SCRATCH,
  PLINT_EVIDENCE_DIR: EVIDENCE,
  PLINT_LOG: 'silent',
  // A test run must not depend on the developer having set these.
  PLINT_SECRET: process.env.PLINT_SECRET || crypto.randomBytes(32).toString('hex'),
  PLINT_INSECURE_COOKIES: '1',
};

const admin = extra => new Client({ ...config.adminDb({ database: 'postgres' }), ...extra });

async function createScratch() {
  const c = admin();
  await c.connect();
  try {
    await c.query(`CREATE DATABASE "${SCRATCH}" OWNER "${process.env.PGADMINUSER}"`);
  } finally { await c.end(); }
  console.log('scratch database ' + SCRATCH);
}

async function dropScratch() {
  const c = admin();
  await c.connect();
  try {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [SCRATCH]);
    await c.query(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  } finally { await c.end(); }
  fs.rmSync(EVIDENCE, { recursive: true, force: true });
  console.log('scratch database dropped');
}

function step(label, args) {
  process.stdout.write('\n── ' + label + '\n');
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
  return r.status === 0;
}

(async () => {
  let failed = [];
  await createScratch();
  try {
    // The same three commands an operator runs on a new machine.
    if (!step('bootstrap', ['db/bootstrap.js'])) throw new Error('bootstrap failed');
    if (!step('migrate', ['db/migrate.js'])) throw new Error('migrate failed');
    if (!step('seed', ['db/seed.js'])) throw new Error('seed failed');

    // Migrations must be a no-op the second time, on a populated database.
    if (!step('migrate again (must be a no-op)', ['db/migrate.js'])) throw new Error('re-migrate failed');

    for (const s of SUITES) {
      if (!step(s, [path.join('test', s)])) failed.push(s);
    }
  } catch (e) {
    console.error('\n' + e.message);
    failed.push(e.message);
  } finally {
    await dropScratch().catch(e => console.error('could not drop scratch: ' + e.message));
  }

  console.log('\n' + '─'.repeat(60));
  if (failed.length) {
    console.log('FAILED: ' + failed.join(', ') + '\n');
    process.exit(1);
  }
  console.log('all suites passed\n');
})();
