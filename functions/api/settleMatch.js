// functions/api/settleMatch.js
// 1v1 online match (matches/{matchId} node) ka result settle karta hai:
// jo bhi staked tha, winner ko pay karta hai. Idempotent hai — pehle
// settled mark hota hai, phir payment. Sirf match ke players call kar
// sakte hain. Game call karta hai: POST /api/settleMatch { matchId }
//
// FIXED: pehle ye file `getDb` import karti thi jo _firebaseAdmin.js me
// EXPORT HI NAHI HAI — is wajah se poore Pages Functions ka build FAIL
// ho raha tha (GitHub pe har commit ke saath red X). Saath hi
// `requireAuth(context)` bhi galat tha (request chahiye), aur
// onRequestOptions missing thi. Ab sab helpers-based version:
import { requireAuth, rtdbGet, rtdbTransaction, rtdbDelete, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

export async function onRequestOptions() {
    return optionsResponse();
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let auth;
    try { auth = await requireAuth(request); }
    catch (e) { return jsonResponse(e.statusCode || 401, { ok: false, reason: 'unauthenticated' }); }
    const uid = auth.uid;

    let body = {};
    try { body = await request.json(); } catch (e) {}
    const matchId = String(body.matchId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 60);
    if (!matchId) return jsonResponse(400, { ok: false, reason: 'bad-request' });

    try {
        const m = (await rtdbGet(env, 'matches/' + matchId)) || {};

        // sirf match ke players settle kar sakte hain
        if (uid !== m.hostUid && uid !== m.guestUid) return jsonResponse(403, { ok: false, reason: 'not-a-player' });

        const already = await rtdbGet(env, 'lm_online/matchSettled/' + matchId);
        if (already) return jsonResponse(200, { ok: true, reason: 'already-settled' });

        const result = m.result || {};
        if (!result.winnerColor) return jsonResponse(200, { ok: false, reason: 'no-result' });

        // game me host = Red, guest = Yellow
        const winnerUid = result.winnerColor === 'Red' ? m.hostUid : m.guestUid;

        const stakes = (await rtdbGet(env, 'lm_online/matchStakes/' + matchId)) || {};
        const stakerUids = Object.keys(stakes);
        if (!stakerUids.length) return jsonResponse(200, { ok: false, reason: 'not-staked' });
        const pot = stakerUids.reduce((s, u) => s + ((stakes[u] && stakes[u].amount) || 0), 0);

        // RACE-SAFE: settled mark atomically claim karo, phir pay karo
        const claim = await rtdbTransaction(env, 'lm_online/matchSettled/' + matchId, cur => {
            if (cur) return undefined; // already settled
            return { at: Date.now(), winnerUid: winnerUid || null, pot: pot };
        });
        if (!claim.committed) return jsonResponse(200, { ok: true, reason: 'already-settled' });

        if (winnerUid && pot > 0) {
            await rtdbTransaction(env, 'lm_online/users/' + winnerUid + '/coins',
                cur => (typeof cur === 'number' ? cur : 0) + pot);
        }
        await rtdbDelete(env, 'lm_online/matchStakes/' + matchId).catch(() => {});

        const bal = await rtdbGet(env, 'lm_online/users/' + uid + '/coins');
        return jsonResponse(200, { ok: true, winnerUid: winnerUid || null, pot: pot, newBalance: typeof bal === 'number' ? bal : 0 });
    } catch (e) {
        console.error('[settleMatch]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) });
    }
}
