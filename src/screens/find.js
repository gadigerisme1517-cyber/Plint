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

  const K = require('./kit')({ esc });
  const { head, table, titled, empty, num } = K;

  /* Where a hit goes when it is tapped. The two roles keep their own villa
     screen, so the same row leads to different places - which is right: an
     engineer wants the villa they photograph and the office wants the file. */
  const to = (sess, code) => sess.role === 'engineer'
    ? '/engineer/villa/' + encodeURIComponent(code)
    : '/office/buyer/' + encodeURIComponent(code);

  function screen(sess, q, hits) {
    const body = !q
      ? empty('Type a villa code, a buyer or a lender.')
      : table(['Villa', 'Stage and buyer', 'Lender', 'Agreement value'],
        hits.map(v => [
          `<b>${esc(v.code)}</b>`,
          `<b>${esc(v.stage || 'All stages done')}</b><br><span class="hsub">`
            + esc(v.buyer_name) + (v.engineer_name ? ' &middot; ' + esc(v.engineer_name) : '')
            + '</span>',
          esc(v.bank || 'self funded'),
          num(M.money(Number(v.agreement_value_paise))),
        ]),
        '.6fr 2fr 1fr 1fr',
        { href: i => to(sess, hits[i].code), min: 620,
          empty: 'Nothing matches what you typed.' });

    return desk(sess, '', q ? 'Results for ' + q : 'Find', '', `
${head(q ? 'Results for ' + q : 'Find',
  q ? hits.length + ' villa' + (hits.length === 1 ? '' : 's') + ' match'
      + (hits.length === 1 ? 'es' : '') + ' what you typed.'
    : 'A villa code, a buyer or a lender. You see the villas you are allowed to see.')}
${titled(q ? 'Matches' : 'Search', body)}
`);
  }

  return { screen };
};
