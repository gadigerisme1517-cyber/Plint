'use strict';
/* ============================================================================
   Structured logging. One JSON object per line on stdout, which is what a log
   shipper wants and what a person can still read with grep.

   Every request line carries the actor id, because the question asked of these
   logs is always "who did this".

   Nothing here ever logs a password, a session token or a cookie header. The
   session token is the one secret that passes through this process on every
   request, and a log file is exactly where it must not end up.
   ========================================================================= */
const config = require('./config');

// silent during tests, json everywhere else
const MODE = config.optional('PLINT_LOG', 'json');

function emit(level, event, fields) {
  if (MODE === 'silent') return;
  const line = { t: new Date().toISOString(), level, event, ...fields };
  process.stdout.write(JSON.stringify(line) + '\n');
}

const info  = (event, fields = {}) => emit('info', event, fields);
const warn  = (event, fields = {}) => emit('warn', event, fields);

/* An error is logged in full, with its stack, on the server. The browser is
   told only that something failed, and the id, so a user can quote it and an
   operator can find this line. */
function error(event, err, fields = {}) {
  emit('error', event, {
    ...fields,
    err: err && err.message,
    code: err && err.code,
    stack: err && err.stack,
  });
}

/** One line per completed request. */
function request(req, res, { start, sess, id }) {
  info('request', {
    id,
    method: req.method,
    path: (req.url || '').split('?')[0],
    status: res.statusCode,
    ms: Number((Date.now() - start).toFixed(0)),
    actor: sess ? sess.id : null,
    role: sess ? sess.role : null,
  });
}

module.exports = { info, warn, error, request, MODE };
