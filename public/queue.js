/* ============================================================================
   THE ENGINEER'S OUTBOX.                                    build __BUILD__

   A site engineer stands in a half-built villa with one bar of signal and
   marks a stage done. The write fails. Before this file the page simply did
   not move, and the four things he does all day - marking a stage complete,
   filing a photograph, writing a log entry, photographing a snag - were lost
   with it.

   WHAT THIS IS NOT. It is not a general offline mode, and it is deliberately
   only the engineer's writes. The buyer's money screens and the office's
   disbursement are not queued: a demand, a certificate and a payment are
   decisions taken against what the server holds now, and a queue in front of
   them is a way to take one against something stale.

   THE FOUR RULES IT IS BUILT TO.

     1. NEVER A TICK THAT MEANS "SAVED" WHEN IT MEANS "SAVED HERE". A queued
        write does not navigate, does not show the green sentence the server
        would have shown, and does not move the stage on screen. It says, in
        the words: held on this phone, not sent.

     2. IN ORDER. Writes replay oldest first, and while anything is waiting a
        new write joins the back of the queue rather than overtaking it. A
        photograph must not reach the office after the stage it evidences.

     3. A REFUSAL SURFACES. The server answers these four routes with JSON
        when a write is replayed - see `answer()` in src/server.js - so "that
        stage could not be marked" is a 409 and not a redirect that looks like
        every other redirect. A refused row stays in the outbox with the
        server's own sentence against it until the engineer clears it.

     4. A FORCE QUIT LOSES NOTHING. The queue is IndexedDB, not memory and not
        a variable in this closure. Killing the browser with rows in it and
        reopening finds them, because that is exactly what happens when a
        phone dies on site.

   With no JavaScript at all every one of these forms still posts normally.
   This file only ever intercepts what it can carry.
   ========================================================================= */
(function () {
  'use strict';
  if (!window.indexedDB || !window.fetch || !window.FormData) return;

  var DB = 'plint-outbox', STORE = 'writes', VERSION = 1;
  var KINDS = {
    mark:  'Stage marked done',
    photo: 'Photograph',
    log:   'Log entry',
    snag:  'Snag photographed',
  };
  var sending = false, lastTrouble = '';

  /* WHOSE WRITES THESE ARE.

     These phones get handed around, and the server records the signed-in
     session as the person who marked the stage - so a write queued by one
     engineer and replayed after somebody else has signed in would be filed
     under the wrong name. Every row carries the id of the session that made
     it. It is shown to anyone, because a phone holding unsent work should say
     so whoever is looking, and it is sent only by the person who wrote it. */
  function box() { return document.getElementById('outbox'); }
  function meId() { var b = box(); return (b && b.getAttribute('data-who')) || ''; }
  function meName() { var b = box(); return (b && b.getAttribute('data-whoname')) || ''; }
  function mine(r) { return !r.who || !meId() ? false : r.who === meId(); }

  // ------------------------------------------------------------ the store

  function open(cb) {
    var rq = indexedDB.open(DB, VERSION);
    rq.onupgradeneeded = function () {
      if (!rq.result.objectStoreNames.contains(STORE)) {
        rq.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    rq.onsuccess = function () { cb(null, rq.result); };
    rq.onerror = function () { cb(rq.error || new Error('no store')); };
  }

  function withStore(mode, fn) {
    open(function (err, db) {
      if (err) return;
      var t = db.transaction(STORE, mode);
      fn(t.objectStore(STORE), t);
    });
  }

  /* Oldest first, always. `seq` is the store's own autoincrement key, so the
     order is the order the engineer did them in and nothing can renumber it. */
  function all(cb) {
    withStore('readonly', function (st) {
      var rq = st.getAll();
      rq.onsuccess = function () {
        cb((rq.result || []).sort(function (a, b) { return a.seq - b.seq; }));
      };
      rq.onerror = function () { cb([]); };
    });
  }

  function add(row, cb) {
    withStore('readwrite', function (st, t) {
      st.add(row);
      t.oncomplete = function () { cb && cb(); };
      t.onerror = function () { cb && cb(); };
    });
  }

  function put(row, cb) {
    withStore('readwrite', function (st, t) {
      st.put(row);
      t.oncomplete = function () { cb && cb(); };
    });
  }

  /* ONE SENDER PER ROW.

     Two flushes can be in flight at once - the 'online' event fires on the
     screen being left and the next screen starts its own on load - and both
     read the queue before either has deleted anything. That sent the same
     write twice: the second copy of a stage marked done came back 409
     "could not be marked", because the first had just marked it, and a
     duplicate would have surfaced to the engineer as a refusal.

     IndexedDB serialises transactions, so claiming a row - read it, check it
     is still waiting, write it back as sending - is atomic. Whoever loses
     the race is told the row is taken and leaves it alone. */
  function claim(seq, cb) {
    withStore('readwrite', function (st) {
      var g = st.get(seq);
      g.onsuccess = function () {
        var row = g.result;
        if (!row || row.state !== 'waiting') return cb(false);
        row.state = 'sending';
        st.put(row);
        cb(true, row);
      };
      g.onerror = function () { cb(false); };
    });
  }

  /* A row left as `sending` by a force quit is not in flight any more. It
     goes back on the queue, and the write it may already have made is why
     `qkey` exists - see the log route in src/server.js. */
  function unstick(cb) {
    withStore('readwrite', function (st, t) {
      var rq = st.getAll();
      rq.onsuccess = function () {
        (rq.result || []).forEach(function (r) {
          if (r.state === 'sending') { r.state = 'waiting'; st.put(r); }
        });
      };
      t.oncomplete = function () { cb && cb(); };
    });
  }

  function drop(seq, cb) {
    withStore('readwrite', function (st, t) {
      st.delete(seq);
      t.oncomplete = function () { cb && cb(); };
    });
  }

  // ------------------------------------------------------------ the write

  /* A form, flattened into something IndexedDB can hold across a force quit.
     A File survives a structured clone, so the photograph itself is in the
     queue - not a path to it, which would be gone the moment the page was. */
  function partsOf(f) {
    var parts = [], els = f.elements, i, el;
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (!el.name || el.disabled) continue;
      if (el.type === 'file') {
        if (el.files && el.files.length) parts.push([el.name, el.files[0], el.files[0].name]);
        continue;
      }
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      if (el.tagName === 'BUTTON') continue;
      parts.push([el.name, el.value]);
    }
    return parts;
  }

  /* THE BODY HAS TO BE THE SHAPE THE ROUTE PARSES.

     A FormData body is always multipart, even with no file in it, and two of
     these four routes read a url-encoded body - so replaying a stage marked
     done as multipart handed the server an empty `id`, which it correctly
     refused as "that stage could not be marked". A form with a photograph in
     it is multipart because it has to be; a form without one is encoded the
     way the browser would have encoded it. */
  function bodyOf(row) {
    var hasFile = row.parts.some(function (p) { return p.length === 3; });
    if (!hasFile) {
      var q = new URLSearchParams();
      row.parts.forEach(function (p) { q.append(p[0], p[1]); });
      return { body: q, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
    }
    var fd = new FormData();
    row.parts.forEach(function (p) {
      if (p.length === 3) fd.append(p[0], p[1], p[2]); else fd.append(p[0], p[1]);
    });
    return { body: fd, headers: {} };   // the browser sets the multipart boundary
  }

  /* One attempt. `err` means the write never reached the office and the row
     must be kept; an answer means it did, and `said.ok` says what happened to
     it there. */
  function post(row, cb) {
    var b = bodyOf(row);
    b.headers['x-plint-queued'] = '1';
    fetch(row.url, {
      method: 'POST', body: b.body, credentials: 'same-origin', headers: b.headers,
    }).then(function (r) {
      return r.json().then(function (j) { cb(null, j); }, function () {
        /* A reply this screen cannot read is not a yes. The row is kept. */
        cb(new Error('The office answered something this screen could not read.'));
      });
    }, function () {
      cb(new Error('No connection.'));
    });
  }

  // ------------------------------------------------------------ the screen

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(extra) {
    var el = box();
    if (!el) return;
    all(function (rows) {
      var waiting = rows.filter(function (r) { return r.state !== 'refused' && mine(r); });
      var theirs = rows.filter(function (r) { return r.state !== 'refused' && !mine(r); });
      var refused = rows.filter(function (r) { return r.state === 'refused'; });
      if (!rows.length && !extra) { el.hidden = true; el.innerHTML = ''; return; }
      var h = '';
      if (waiting.length) {
        h += '<div class="obh"><b>' + waiting.length + ' '
          + (waiting.length === 1 ? 'write is' : 'writes are')
          + ' waiting on this phone</b>'
          + '<span>Held here, not sent. Nobody at the office can see '
          + (waiting.length === 1 ? 'it' : 'them') + ' yet.</span></div>'
          + '<ul class="obl">' + waiting.map(function (r) {
            return '<li><span class="obk">' + esc(KINDS[r.kind] || 'Write') + '</span>'
              + '<span class="obw">' + esc(r.label || '') + '</span>'
              + '<span class="obt">' + esc(r.at) + '</span></li>';
          }).join('') + '</ul>'
          + '<div class="oba"><button class="btn dark" type="button" data-ob="send">'
          + (sending ? 'Sending&hellip;' : 'Send them now') + '</button>'
          + (lastTrouble ? '<span class="obe">' + esc(lastTrouble) + '</span>' : '')
          + '</div>';
      }
      if (theirs.length) {
        /* Not this session's, so this session must not send them: the server
           files a write against whoever is signed in. On a page with no
           session at all - the offline page - nobody can send them, and
           saying they belong to "somebody else" would be wrong. */
        h += '<div class="obh"><b>' + theirs.length + ' '
          + (theirs.length === 1 ? 'write is' : 'writes are')
          + (meId() ? ' held here for somebody else' : ' held on this phone') + '</b>'
          + '<span>' + (meId()
            ? 'Made on this phone by another sign-in. '
              + (meName() ? esc(meName()) + ' cannot send '
                  + (theirs.length === 1 ? 'it' : 'them')
                  + ' - the office would record the wrong person. ' : '')
              + (theirs.length === 1 ? 'It goes' : 'They go')
              + ' when that person signs in here again.'
            : 'This screen is not signed in, so nothing can be sent from it. '
              + (theirs.length === 1 ? 'It goes' : 'They go')
              + ' when the person who wrote '
              + (theirs.length === 1 ? 'it' : 'them') + ' opens the app with a connection.')
          + '</span></div>'
          + '<ul class="obl">' + theirs.map(function (r) {
            return '<li><span class="obk">' + esc(KINDS[r.kind] || 'Write') + '</span>'
              + '<span class="obw">' + esc(r.label || '') + '</span>'
              + '<span class="obt">' + esc(r.at) + '</span></li>';
          }).join('') + '</ul>';
      }
      if (refused.length) {
        h += '<div class="obh obr"><b>' + refused.length + ' '
          + (refused.length === 1 ? 'write was' : 'writes were')
          + ' refused by the office</b>'
          + '<span>' + (refused.length === 1
            ? 'It reached the office and was not accepted.'
            : 'They reached the office and were not accepted.')
          + ' Nothing has been recorded.</span></div>'
          + '<ul class="obl">' + refused.map(function (r) {
            return '<li><span class="obk obkr">' + esc(KINDS[r.kind] || 'Write') + '</span>'
              + '<span class="obw">' + esc(r.label || '') + '</span>'
              + '<span class="obs">' + esc(r.said || '') + '</span>'
              + '<button class="btn" type="button" data-ob="drop" data-seq="' + r.seq
              + '">Clear</button></li>';
          }).join('') + '</ul>';
      }
      if (extra) h += '<div class="obn">' + esc(extra) + '</div>';
      el.innerHTML = h;
      el.hidden = false;
    });
  }

  // ------------------------------------------------------------- the flush

  /* Sequential and in order, and it stops at the first row that does not
     reach the office: everything behind it is newer, and sending a later
     write past an earlier one is the failure this whole file exists to
     prevent. A refusal is not a stop - it is an answer - so the queue steps
     over it and keeps going. */
  function flush(done) {
    if (sending) return;
    sending = true; lastTrouble = '';
    all(function (rows) {
      var queue = rows.filter(function (r) { return r.state !== 'refused' && mine(r); });
      var went = 0, refusedNow = 0;
      (function step() {
        if (!queue.length) {
          sending = false;
          var said = went || refusedNow
            ? (went ? went + ' ' + (went === 1 ? 'write' : 'writes') + ' reached the office' : '')
              + (went && refusedNow ? '. ' : '')
              + (refusedNow ? refusedNow + ' ' + (refusedNow === 1 ? 'was' : 'were') + ' refused' : '')
              + '.'
            : '';
          render(said);
          done && done({ went: went, refused: refusedNow });
          return;
        }
        var next = queue.shift();
        claim(next.seq, function (got, row) {
          if (!got) return step();          // another flush has this one
          post(row, function (err, j) {
            if (err) {
              lastTrouble = err.message + ' Still waiting here.';
              row.state = 'waiting';
              put(row, function () {
                sending = false; render(); done && done({ went: went, refused: refusedNow });
              });
              return;
            }
            if (j.ok) { went++; drop(row.seq, step); return; }
            refusedNow++;
            row.state = 'refused'; row.said = j.said || 'Refused.';
            put(row, step);
          });
        });
      })();
    });
  }

  // ------------------------------------------------------ what a form does

  function when() {
    var d = new Date();
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }

  function key() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function enqueue(f, why) {
    var row = {
      kind: f.getAttribute('data-q'),
      label: f.getAttribute('data-ql') || '',
      url: f.getAttribute('action'),
      parts: partsOf(f).concat([['qkey', key()]]),
      at: when(),
      who: meId(),
      state: 'waiting',
    };
    add(row, function () {
      render(why);
      /* The control that made it must not sit there looking unpressed, and it
         must not look done either. It says where the write actually is. */
      var b = f.querySelector('button[type="submit"]');
      if (b) { b.textContent = 'Held on this phone'; b.disabled = true; }
    });
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute || !f.getAttribute('data-q')) return;
    e.preventDefault();
    var row = {
      kind: f.getAttribute('data-q'), label: f.getAttribute('data-ql') || '',
      url: f.getAttribute('action'), parts: partsOf(f).concat([['qkey', key()]]),
      at: when(), who: meId(), state: 'waiting',
    };
    all(function (rows) {
      var waiting = rows.filter(function (r) { return r.state !== 'refused' && mine(r); });
      /* Rule 2. Anything already waiting goes first, or a photograph filed
         now would land before the stage marked ten minutes ago. */
      if (waiting.length || !navigator.onLine) {
        return enqueue(f, navigator.onLine
          ? 'Added behind what is already waiting.'
          : 'No connection. Held on this phone.');
      }
      post(row, function (err, j) {
        if (err) return enqueue(f, 'That did not reach the office. Held on this phone.');
        window.location.assign(j.to + (j.to.indexOf('?') < 0 ? '?' : '&')
          + 'm=' + encodeURIComponent(j.said));
      });
    });
  }, true);

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-ob]');
    if (!b) return;
    if (b.getAttribute('data-ob') === 'send') { sending = false; flush(); }
    if (b.getAttribute('data-ob') === 'drop') {
      drop(Number(b.getAttribute('data-seq')), function () { render(); });
    }
  });

  window.addEventListener('online', function () { if (meId()) flush(); });
  /* On every load: what is in the outbox is shown before anything is tried,
     so a reader who has just reopened the app sees the truth immediately. */
  unstick(function () {
    render();
    if (navigator.onLine && meId()) setTimeout(function () { flush(); }, 400);
  });

  /* For the browser test, and for anyone who wants to see it from a console. */
  window.__plintOutbox = { all: all, flush: flush, render: render };
})();
