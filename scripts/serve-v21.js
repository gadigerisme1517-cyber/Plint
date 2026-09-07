'use strict';
/* Serves plint-v21.html so the design file can be opened at a phone width and
   compared against the built screens side by side.

   Reference only. It is not part of the application, nothing in src/ knows
   about it, and it binds to localhost. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

http.createServer((req, res) => {
  const asked = req.url === '/' ? '/plint-v21.html' : req.url.split('?')[0];
  const file = path.resolve(ROOT, '.' + path.normalize(asked));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (e, body) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}).listen(3901, '127.0.0.1', () => console.log('v21 reference on http://127.0.0.1:3901'));
