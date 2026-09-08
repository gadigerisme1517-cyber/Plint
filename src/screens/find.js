'use strict';
/* ============================================================================
   One field, across the villas this person is allowed to see.

   TWO DIFFERENT THINGS DO THE SCOPING. Row-level security keeps a buyer out
   - `un_read` on units is `buyer_user_id = current_user_id()` for that role,
   so no query can reach another villa. Among staff it does not partition at
   all: the policy is `true` for both the engineer and the office, because an
   engineer certifying a stage works across the project and the assignment is
   a work allocation rather than a confidentiality boundary.

   So "the villas assigned to me" is the screen's rule and lives in the route
   with the query, not in the policy. The comment here used to claim the
   policy did it, and a test that compared what the two roles get back proved
   otherwise - the engineer was seeing all forty of them.

   The buyer has no field at all. They have one villa, and searching it would
   be searching for the screen they are already standing on.
   ========================================================================= */

module.exports = function findScreen(ctx) {
  const { esc, desk, M } = ctx;

  const { wrow, empty } = require('./rows')({ esc });
  const UI = require('./ui')({ esc });

  /* Where a hit goes when it is tapped. The two roles keep their own villa
     screen, so the same row leads to different places - which is right: an
     engineer wants the villa they photograph and the office wants the file. */
  const to = (sess, code) => sess.role === 'engineer'
    ? '/engineer/villa/' + encodeURIComponent(code)
    : '/office/buyer/' + encodeURIComponent(code);

  function screen(sess, q, hits) {
    const rows = hits.map(v => wrow({
      href: to(sess, v.code),
      code: v.code,
      title: v.stage || 'All stages done',
      detail: esc(v.buyer_name) + ' &middot; ' + esc(v.bank || 'self funded')
        + (v.engineer_name ? ' &middot; ' + esc(v.engineer_name) : ''),
      amount: M.money(Number(v.agreement_value_paise)),
    })).join('');

    const body = !q
      ? empty('Type a villa code, a buyer or a lender.')
      : hits.length ? rows
      : empty('Nothing matches &ldquo;' + esc(q) + '&rdquo;.');

    return desk(sess, null, 'Find', '', `
${UI.head(q ? 'Results for ' + q : 'Find',
  q ? hits.length + ' villa' + (hits.length === 1 ? '' : 's') + ' match'
      + (hits.length === 1 ? 'es' : '') + ' what you typed.'
    : 'A villa code, a buyer or a lender. You see the villas you are allowed to see.')}
<div class="mbody anim">
<div class="blk"><p class="k">${q ? 'Matches' : 'Search'}</p></div>
<div class="wl">${body}</div>
</div>`);
  }

  return { screen };
};
