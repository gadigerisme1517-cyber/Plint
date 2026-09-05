'use strict';
/* ============================================================================
   A deliberately small multipart/form-data reader.

   Enough for one file and a handful of text fields, which is all an evidence
   upload is. It exists so the upload can be a plain HTML form - the design is
   locked and carries no JavaScript - without taking a dependency.

   Everything is done in Buffers. Decoding a JPEG to a string and back would
   corrupt it.
   ========================================================================= */

const CRLF = Buffer.from('\r\n');
const DASH = Buffer.from('--');

/** Reads the whole body, refusing at the cap rather than buffering past it. */
function read(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > maxBytes) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return m ? (m[1] || m[2]).trim() : null;
}

/** Splits on a delimiter, in bytes. */
function split(buf, delim) {
  const out = [];
  let start = 0, i;
  while ((i = buf.indexOf(delim, start)) !== -1) {
    out.push(buf.subarray(start, i));
    start = i + delim.length;
  }
  out.push(buf.subarray(start));
  return out;
}

function headerValue(headers, name) {
  const re = new RegExp('^' + name + ':\\s*(.*)$', 'im');
  const m = re.exec(headers);
  return m ? m[1].trim() : null;
}

/**
 * @returns {{fields: object, files: object}} files are
 *          { name: { filename, contentType, data: Buffer } }
 */
function parse(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw Object.assign(new Error('no boundary'), { code: 'BAD_FORM' });

  const delim = Buffer.concat([DASH, Buffer.from(boundary)]);
  const parts = split(body, delim);
  const fields = {}, files = {};

  for (const raw of parts) {
    // The preamble, the epilogue ("--\r\n") and empty slices are not parts.
    if (raw.length < 4) continue;
    let part = raw;
    if (part.subarray(0, 2).equals(CRLF)) part = part.subarray(2);
    if (part.subarray(0, 2).equals(DASH)) continue;               // closing delimiter

    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) continue;

    const headers = part.subarray(0, sep).toString('latin1');
    let data = part.subarray(sep + 4);
    // Each part is terminated by the CRLF that precedes the next delimiter.
    if (data.subarray(data.length - 2).equals(CRLF)) data = data.subarray(0, data.length - 2);

    const disp = headerValue(headers, 'content-disposition') || '';
    const name = /name="([^"]*)"/i.exec(disp);
    if (!name) continue;

    const filename = /filename="([^"]*)"/i.exec(disp);
    if (filename) {
      // The client-supplied filename is recorded for nothing. It never reaches
      // a path. The stored name is the hash of the content.
      files[name[1]] = {
        filename: filename[1],
        contentType: headerValue(headers, 'content-type'),
        data,
      };
    } else {
      fields[name[1]] = data.toString('utf8');
    }
  }
  return { fields, files };
}

module.exports = { read, parse, boundaryOf };
