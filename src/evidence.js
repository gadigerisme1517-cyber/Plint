'use strict';
/* ============================================================================
   Evidence photographs on disk.

   Content-addressed: the path is derived from the sha256 of the bytes, which
   is the same sha256 the evidence row has always carried. Nothing a client
   sends is ever used to build a path - not the filename, not the declared
   type, not a caption. The name of a file is a fact about its contents.

   Reading is authorised by row-level security, not by this module: a caller
   asks the database for an evidence row by hash, as itself, and only reaches
   the disk if a row came back.
   ========================================================================= */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const MAX_BYTES = Number(config.optional('PLINT_MAX_UPLOAD_BYTES', String(8 * 1024 * 1024)));

// Magic bytes. The declared content-type and the filename extension are both
// client claims; neither is consulted.
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF]);
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function sniff(buf) {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG)) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return 'image/png';
  return null;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** var/evidence/ab/cd/<full hash>. Two levels so a directory stays listable. */
function pathFor(hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('not a sha256');
  return path.join(config.evidenceDir(), hash.slice(0, 2), hash.slice(2, 4), hash);
}

/**
 * Writes the bytes and proves what landed. Returns the facts the evidence row
 * needs. Rejects anything that is not a JPEG or a PNG, and anything past the
 * cap. Storing the same photograph twice is a no-op, by construction.
 */
async function store(buf) {
  if (!buf || !buf.length) throw Object.assign(new Error('empty upload'), { code: 'EMPTY' });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });

  const mime = sniff(buf);
  if (!mime) throw Object.assign(new Error('not a JPEG or PNG'), { code: 'BAD_TYPE' });

  const hash = sha256(buf);
  const file = pathFor(hash);
  await fsp.mkdir(path.dirname(file), { recursive: true });

  // Write to a temporary name in the same directory and rename into place, so
  // a reader can never observe a half-written file at the content address.
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.part';
  await fsp.writeFile(tmp, buf, { flag: 'wx' });
  await fsp.rename(tmp, file);

  // Verify on write: read back what is actually on disk and hash it again. If
  // the path is content-addressed, this is the assertion that makes it true.
  const back = await fsp.readFile(file);
  if (sha256(back) !== hash) {
    await fsp.unlink(file).catch(() => {});
    throw Object.assign(new Error('stored bytes do not match their hash'), { code: 'HASH_MISMATCH' });
  }

  return { sha256: hash, mime, byteSize: buf.length };
}

const read = hash => fsp.readFile(pathFor(hash));
const readSync = hash => fs.readFileSync(pathFor(hash));

function exists(hash) {
  try { return fs.existsSync(pathFor(hash)); } catch { return false; }
}

module.exports = { store, read, readSync, exists, pathFor, sniff, sha256, MAX_BYTES };
