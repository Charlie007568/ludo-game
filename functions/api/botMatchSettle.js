// functions/api/botMatchSettle.js
// Random Match (bot) khatam hone pe rank ke hisaab se payout karta hai.
// PAYOUT RULE (user-defined):
//   2P: 1st = 2×fee  → pot 2×fee   (e.g. fee 500 → winner 1000)
//   3P: 1st = 2×fee, 2nd = 1×fee, 3rd = 0
//   4P: 1st = 2×fee, 2nd = 1×fee, 3rd = 1×fee, 4th = 0
// Fee sabki kat-ti hai (pot = fee × playerCount), payout total = pot.
// Idempotent hai — active record sirf ek baar settle hota hai.
// Game call karta hai: POST /api/botMatchSettle { rank }
import { requireAuth, rtdbGet, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';

function payoutForRank(rank, playerCount, bet) {
    if (rank === 1) return bet * 2;
    if (rank === 2) return bet * 1;
    if (rank === 3 && playerCount === 4) return bet * 1;
    return 0;
}

export async function onRequestOptions() {
    return optionsResponse();
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let auth;
    try { auth = await requireAuth(request); }
    catch (e) { return jsonResponse(e.statusCode || 401, { ok: false, reason: 'unauthenticated' }); }

    let data = {};
    try { data = await request.json(); } catch (e) {}
    const rank = Math.max(1, Math.min(4, parseInt(data.rank, 10) || 4));

    try {
        const rec = await rtdbGet(env, `${ONLINE_ROOT}/botMatches/${auth.uid}`);
        if (!rec || !rec.active) return jsonResponse(200, { ok: false, reason: 'no-active-match' });

        const bet = Math.max(0, parseInt(rec.bet, 10) || 0);
        const playerCount = Math.max(2, Math.min(4, parseInt(rec.playerCount, 10) || 2));
        const payout = payoutForRank(rank, playerCount, bet);

        // atomically settle (idempotent — dobara call par already-settled)
        const claim = await rtdbTransaction(env, `${ONLINE_ROOT}/botMatches/${auth.uid}`, cur => {
            if (!cur || !cur.active) return undefined;
            cur.active = false;
            cur.settledAt = Date.now();
            cur.rank = rank;
            cur.payout = payout;
            return cur;
        });
        if (!claim.committed) return jsonResponse(200, { ok: false, reason: 'already-settled' });

        if (payout > 0) {
            await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`,
                cur => (typeof cur === 'number' ? cur : 0) + payout);
        }
        const bal = await rtdbGet(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`);
        return jsonResponse(200, { ok: true, rank, payout, newBalance: typeof bal === 'number' ? bal : 0 });
    } catch (e) {
        console.error('[botMatchSettle]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
