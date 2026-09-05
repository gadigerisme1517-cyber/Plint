'use strict';
/* Development only. Drops the schema and rebuilds it from the migrations, then
   seeds. Never wire this to anything that runs in production: the whole point
   of db/migrate.js is that it does NOT do this. */
const { Client } = require('pg');
const config = require('../src/config');

async function reset() {
  const c = new Client(config.adminDb());
  await c.connect();
  try { await c.query('DROP SCHEMA IF EXISTS plint CASCADE'); }
  finally { await c.end(); }
  console.log('reset: schema dropped');
}

if (require.main === module) {
  reset().catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { reset };
