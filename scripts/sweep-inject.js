/* The sweep. Injected into a rendered office screen and run there, so what it
   exercises is what a reader can actually click, with the real listeners and
   the real session attached.

   Three kinds of control, three ways of proving it does something:

     a JS control  - a filter chip, Clear, the hamburger, the search box - is
                     clicked, and the DOM before and after is compared. No
                     change is dead.
     a link        - is fetched. Anything that is not 200 or 302 is dead.
     a form submit - is POSTed with the form's own fields, and the redirect it
                     lands on is fetched. No toast on the landing page, or a
                     landing page that does not render, is dead.

   It reports every control it could not prove did something. Zero is the bar.

   `WRITE` decides whether the forms are actually submitted: a read-only pass
   proves the links and the JS, a full pass proves the writes too and changes
   the database while it does it.                                            */
window.__sweep = async function (opts) {
  const WRITE = !!(opts && opts.write);
  const out = { view: location.pathname, controls: 0, dead: [], errors: [] };
  const snap = () => document.body.innerHTML.length + '|' +
    [...document.querySelectorAll('[data-tags]')].filter(r => !r.hidden).length + '|' +
    [...document.querySelectorAll('.chip.on')].map(c => c.textContent).join(',');
  const say = (what, el) => (what + ': ' + (el.textContent || '').trim().slice(0, 40)).trim();

  // ------------------------------------------------------------ JS controls
  for (const chip of document.querySelectorAll('.filters .chip[data-filter]')) {
    out.controls++;
    const before = snap();
    chip.click();
    if (snap() === before) {
      /* Clicking the chip that is already on changes nothing, correctly. It
         is only dead if it was not already the active one. */
      if (!chip.classList.contains('on')) out.dead.push(say('filter chip', chip));
    }
  }
  /* Every bar back to All before the search is tried. The chip loop above
     leaves the last chip of each bar active, which can already have narrowed
     the list to nothing - and then typing into the search changes nothing and
     the box reads as dead when it is the sweep that filtered it away. */
  const resetBars = () => {
    for (const bar of document.querySelectorAll('.filters[data-scope]')) {
      const all = bar.querySelector('.chip[data-filter="*"]');
      if (all) all.click();
    }
  };
  for (const box of document.querySelectorAll('[data-search]')) {
    out.controls++;
    resetBars();
    const before = snap();
    box.value = 'zzqqxx';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const narrowed = snap() !== before;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    if (!narrowed) out.dead.push(say('search box', box));
  }
  for (const clear of document.querySelectorAll('[data-clear]')) {
    out.controls++;
    const scope = clear.dataset.clear;
    const bar = document.querySelector('.filters[data-scope="' + scope + '"]');
    const other = bar && [...bar.querySelectorAll('.chip')].find(c => c.dataset.filter !== '*');
    const box = document.querySelector('[data-search="' + scope + '"]');
    /* A screen may be narrowed by chips, by a search box, or by both. Clear
       has to undo whichever is there - proving it against chips alone called
       it dead on the screens that only search. */
    if (other) other.click();
    else if (box) {
      box.value = 'zzqqxx';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else { out.dead.push(say('clear', clear) + ' (nothing to clear)'); continue; }
    const filtered = snap();
    clear.click();
    if (snap() === filtered) out.dead.push(say('clear', clear));
  }
  const ham = document.getElementById('ham');
  if (ham) {
    out.controls++;
    const side = document.getElementById('side');
    ham.click();
    if (!side.classList.contains('open')) out.dead.push('hamburger');
    document.getElementById('scrim2').click();
    if (side.classList.contains('open')) out.dead.push('scrim does not close the drawer');
  }

  // ------------------------------------------------------------------ links
  const hrefs = [...new Set([...document.querySelectorAll('a[href^="/"]')]
    .map(a => a.getAttribute('href')))];
  out.controls += document.querySelectorAll('a[href^="/"]').length;
  for (const href of hrefs) {
    if (href === '/logout') continue;              // proving it would end the sweep
    try {
      const r = await fetch(href, { redirect: 'manual' });
      if (r.status !== 200 && r.status !== 302 && r.status !== 0) {
        out.dead.push('link ' + href + ' -> ' + r.status);
      }
    } catch (e) { out.errors.push('link ' + href + ': ' + e.message); }
  }

  // ------------------------------------------------------------------ forms
  for (const f of document.querySelectorAll('form[method="post"]')) {
    out.controls++;
    const action = f.getAttribute('action');
    if (action === '/logout') continue;
    if (!WRITE) continue;
    const fd = new URLSearchParams();
    for (const el of f.querySelectorAll('input,select,textarea')) {
      if (!el.name) continue;
      /* A field with nothing in it is filled with something a human would
         type, so the write is exercised rather than refused for being empty. */
      let v = el.value;
      if (!v) {
        v = el.type === 'search' || el.tagName === 'SELECT' ? (el.value || '')
          : /amount|sanction|own/.test(el.name) ? '100000'
            : 'Swept ' + Date.now();
      }
      fd.set(el.name, v);
    }
    try {
      /* The redirect is followed rather than read. A browser will not show a
         script the `Location` of a manual redirect - the response comes back
         opaque with status 0 - so the first version of this called every write
         in the console dead for "redirecting nowhere". Following it lands on
         the page the reader would land on, which is the thing to check. */
      const r = await fetch(action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: fd.toString(),
      });
      if (!r.ok) { out.dead.push('form ' + action + ' -> ' + r.status); continue; }
      if (!/^\/office/.test(new URL(r.url).pathname)) {
        out.dead.push('form ' + action + ' lands outside the console: ' + r.url);
        continue;
      }
      const html = await r.text();
      const toast = /<div class="toast" id="toast">([^<]*)</.exec(html);
      if (!toast || !toast[1].trim()) {
        out.dead.push('form ' + action + ' changed nothing and said nothing');
      }
    } catch (e) { out.errors.push('form ' + action + ': ' + e.message); }
  }

  // ----------------------------------------------- what the screen renders
  const text = document.body.innerText;
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    if (text.includes(bad)) out.errors.push('renders ' + bad);
  }
  /* Money is rupees, rolled to lakh and crore. Anything with a rupee sign has
     to be one of those shapes, or a plain grouped figure. */
  const money = text.match(/₹[^\s,]*[\d,.]+\s*(?:Cr|L)?/g) || [];
  for (const m of money) {
    if (!/^₹[\d,]+(\.\d+)?( Cr| L)?$/.test(m.trim())) out.errors.push('money reads "' + m + '"');
  }
  out.money = money.length;
  return out;
};
'sweep installed';
