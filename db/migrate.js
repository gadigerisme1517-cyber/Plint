'use strict';
/* ============================================================================
   The migration runner.

   Forward-only. Every file in db/migrations is applied once, in filename
   order, inside its own transaction, and recorded in plint.schema_migrations
   with a checksum of the text that was applied.

   Running it twice is a no-op. Running it against a populated database loses
   nothing: there is no DROP in the path, and a file that has already been
   applied is skipped without being read for effect.

   If a file changes after it has been applied, the runner stops rather than
   guessing. Migrations are history; you add to history, you do not edit it.
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const config = require('../src/config');

const DIR = path.join(__dirname, 'migrations');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function files() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
}

async function ensureLedger(c) {
  // Not itself a migration: it is the thing that records migrations.
  await c.query('CREATE SCHEMA IF NOT EXISTS plint');
  await c.query(`
    CREATE TABLE IF NOT EXISTS plint.schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

async function migrate({ quiet = false } = {}) {
  const say = m => { if (!quiet) console.log(m); };
  const c = new Client(config.adminDb());
  await c.connect();
  let applied = 0;
  try {
    await ensureLedger(c);
    const done = new Map((await c.query('SELECT filename, checksum FROM plint.schema_migrations'))
      .rows.map(r => [r.filename, r.checksum]));

    for (const f of files()) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      const sum = sha(sql.replace(/\r\n/g, '\n'));

      if (done.has(f)) {
        if (done.get(f) !== sum) {
          throw new Error(
            `${f} has already been applied but its contents have changed.\n` +
            `  Migrations are forward-only. Add a new file rather than editing this one.`);
        }
        say('  skip   ' + f);
        continue;
      }

      // One transaction per migration: a file either lands whole or not at all.
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO plint.schema_migrations (filename, checksum) VALUES ($1,$2)', [f, sum]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw new Error(`${f} failed and was rolled back: ${e.message}`);
      }
      say('  apply  ' + f);
      applied++;
    }
  } finally { await c.end(); }

  say(applied ? `migrate: applied ${applied}` : 'migrate: already up to date');
  return applied;
}

if (require.main === module) {
  migrate().catch(e => { console.error('\nmigrate failed: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { migrate, files };
