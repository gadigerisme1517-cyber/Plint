'use strict';
/* ============================================================================
   THE ONLY WAY WORK LEAVES THIS MACHINE.

   WHY THIS FILE EXISTS. A commit went out on a red suite. The command was

       npm test 2>&1 | tail -3 && git commit ... && git push ...

   and a shell pipeline reports the exit code of its LAST stage, so `tail`
   succeeding meant the `&&` chain ran however the suite had gone. The failing
   test was a one-pixel flake, which is not the point: the point is that the
   gate was a habit rather than a mechanism, and the next person to pipe output
   would have walked through it exactly the same way.

   So the gate is a program. It runs the suite as a child process and reads
   that child's own exit status - there is no pipe, no shell, and nothing in
   between to swallow it. If the suite is not green it prints why and exits
   without committing and without pushing. Nothing here can be made to skip
   the suite: there is no --force, no --skip-tests and no environment variable
   that turns it off, and adding one is the thing to argue about rather than
   the thing to do quietly.

   BELT AND BRACES. test/run.js writes var/last-run.json when it finishes. This
   script deletes that file before it starts and refuses to go on if what comes
   back is missing, is not this run, or does not say the suite passed - so a
   suite that dies without reporting cannot read as success either.

   USE:
     node scripts/ship.js -m "Subject line"
     node scripts/ship.js -F path/to/message.txt
     node scripts/ship.js -m "Subject" --no-push        commit only
     node scripts/ship.js --check                       run the gate, do nothing

   `npm run ship -- -m "..."` is the same thing.
   ========================================================================= */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RESULT = path.join(ROOT, 'var', 'last-run.json');

const RED = s => '\x1b[31m' + s + '\x1b[0m';
const GREEN = s => '\x1b[32m' + s + '\x1b[0m';
const rule = () => console.log('─'.repeat(64));

function die(why, detail) {
  rule();
  console.error(RED('REFUSED: ' + why));
  if (detail) console.error(detail);
  console.error(RED('Nothing was committed. Nothing was pushed.'));
  rule();
  process.exit(1);
}

/** A child process, with its own exit status read directly. No shell, no pipe. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT, stdio: 'inherit', shell: false, ...opts,
  });
  if (r.error) die('could not run ' + cmd, r.error.message);
  if (r.signal) die(cmd + ' was killed by ' + r.signal);
  return r.status;
}

/** The same, but capturing output, for the git reads. */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (r.error) die('could not run ' + cmd, r.error.message);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// ------------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valueOf = f => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const checkOnly = has('--check');
const noPush = has('--no-push');
const subject = valueOf('-m') || valueOf('--message');
const messageFile = valueOf('-F') || valueOf('--file');

if (!checkOnly && !subject && !messageFile) {
  die('no commit message', 'Give one with -m "Subject line" or -F path/to/message.txt.\n'
    + 'Use --check to run the gate without committing.');
}

let message = null;
if (!checkOnly) {
  /* An absolute path is used as given; a relative one is read from the repo. */
  message = messageFile
    ? fs.readFileSync(path.isAbsolute(messageFile) ? messageFile : path.join(ROOT, messageFile), 'utf8')
    : subject;
  if (!message.trim()) die('the commit message is empty');
  if (!/Co-Authored-By:/i.test(message)) {
    message = message.replace(/\s*$/, '\n')
      + '\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n';
  }
}

// ------------------------------------------------------------------ the gate

rule();
console.log('Running the full suite. Nothing is committed until it is green.');
rule();

fs.rmSync(RESULT, { force: true });
const startedAt = Date.now();

/* The suite, as a child of this process. `status` is that child's own exit
   code, which is the thing the pipeline destroyed. */
const suite = run(process.execPath, [path.join('test', 'run.js')]);

if (suite !== 0) {
  die('the suite exited ' + suite,
    'Read the failures above. A red suite is never shipped.');
}

/* And the report it wrote, so a suite that vanished cannot read as a pass. */
let result;
try {
  result = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
} catch (e) {
  die('the suite exited 0 but left no report at var/last-run.json',
    'test/run.js must write it. Without it, "green" is only an exit code.');
}
if (result.passed !== true) {
  die('the suite reported ' + JSON.stringify(result.failed || []) + ' as failed',
    'It exited 0 anyway, which is a bug in the runner, not permission to ship.');
}
if (!result.finishedAt || result.finishedAt < startedAt) {
  die('var/last-run.json is from an earlier run',
    'Finished at ' + new Date(result.finishedAt || 0).toISOString()
    + ', this run started at ' + new Date(startedAt).toISOString() + '.');
}

rule();
console.log(GREEN('The suite is green: ' + result.suites + ' steps, '
  + Math.round((result.finishedAt - result.startedAt) / 1000) + 's.'));
rule();

if (checkOnly) {
  console.log('--check: stopping here, as asked.');
  process.exit(0);
}

// ------------------------------------------------------------------ the commit

const dirty = capture('git', ['status', '--porcelain']);
if (!dirty.out) die('there is nothing to commit', 'The working tree is clean.');

console.log('Committing:');
console.log(dirty.out.split('\n').map(l => '  ' + l).join('\n'));

if (run('git', ['add', '-A']) !== 0) die('git add failed');

const msgFile = path.join(ROOT, 'var', 'commit-message.txt');
fs.mkdirSync(path.dirname(msgFile), { recursive: true });
fs.writeFileSync(msgFile, message, 'utf8');
if (run('git', ['commit', '-F', msgFile]) !== 0) die('git commit failed');
fs.rmSync(msgFile, { force: true });

const head = capture('git', ['log', '--oneline', '-1']);
console.log(GREEN('Committed: ' + head.out));

if (noPush) {
  console.log('--no-push: stopping here, as asked.');
  process.exit(0);
}

// -------------------------------------------------------------------- the push

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
if (run('git', ['push', 'origin', branch]) !== 0) {
  die('git push failed', 'The commit is on ' + branch + ' locally and has not gone out.');
}
rule();
console.log(GREEN('Pushed ' + head.out + ' to origin/' + branch + '.'));
rule();
