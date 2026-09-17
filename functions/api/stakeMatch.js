// functions/api/stakeMatch.js
// Online match ka stake SERVER side kata hai — client se nahi — taaki
// coins cheat na ho sakein. CUSTOM stake support: game apne choose kiye
// hue amount ke saath call karta hai (100 – 1,00,000). RTDB rules me
// lm_online/users/$uid/coins par client writes block hain, isliye sirf
// ye function balance change kar sakta hai.
// Game call karta hai: POST /api/stakeMatch  { matchId, amount }
//
// FIXED: `getDb` import (jo exist nahi karta — isse Pages build fail ho
// raha tha) hataya; ab exported helpers use hote hain. `requireAuth`
// ab `request` pe chalta hai aur onRequestOptions add ki gayi hai.
import { requireAuth, rtdbGet, rtdbPut, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const DEFAULT_STAKE = 1000;
const MIN_STAKE = 100;
const MAX_STAKE = 100000;

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

    // custom stake — na aaye ya invalid ho to default 1000
    let amount = parseInt(body.amount, 10);
    if (!isFinite(amount)) amount = DEFAULT_STAKE;
    amount = Math.max(MIN_STAKE, Math.min(MAX_STAKE, amount));

    try {
        // idempotent: pehle se stake ho chuka ho to dobara mat kato
        const prev = await rtdbGet(env, 'lm_online/matchStakes/' + matchId + '/' + uid);
        if (prev) {
            const bal = await rtdbGet(env, 'lm_online/users/' + uid + '/coins');
            return jsonResponse(200, { ok: true, already: true, newBalance: typeof bal === 'number' ? bal : 0 });
        }

        // atomic deduct — coins kam hone par transaction abort ho jati hai
        const tx = await rtdbTransaction(env, 'lm_online/users/' + uid + '/coins', cur => {
            const c = typeof cur === 'number' ? cur : 0;
            if (c < amount) return undefined; // abort
            return c - amount;
        });
        if (!tx.committed) return jsonResponse(200, { ok: false, reason: 'insufficient' });

        await rtdbPut(env, 'lm_online/matchStakes/' + matchId + '/' + uid, { amount: amount, at: Date.now() });
        return jsonResponse(200, { ok: true, stake: amount, newBalance: tx.value });
    } catch (e) {
        console.error('[stakeMatch]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) });
    }
}
