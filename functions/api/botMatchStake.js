// functions/api/botMatchStake.js
// Random Match (vs random-named bots) ki entry fee SERVER side cut hoti
// hai — client se nahi (warna coins cheat ho jayenge). Fee kat ke
// lm_online/botMatches/{uid} me active record banata hai; jeetne par
// botMatchSettle.js payout karta hai.
// Game call karta hai: POST /api/botMatchStake { bet, playerCount }
import { requireAuth, rtdbGet, rtdbPut, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const MIN_BET = 100;
const MAX_BET = 100000;
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 ghante purana active record = stale, overwrite kar do

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
    let bet = parseInt(data.bet, 10);
    if (!isFinite(bet)) bet = 1000;
    bet = Math.max(MIN_BET, Math.min(MAX_BET, bet));
    const playerCount = Math.max(2, Math.min(4, parseInt(data.playerCount, 10) || 2));

    try {
        // pehle se recent active match hai to double-charge nahi
        const existing = await rtdbGet(env, `${ONLINE_ROOT}/botMatches/${auth.uid}`);
        if (existing && existing.active && (Date.now() - (existing.at || 0)) < ACTIVE_WINDOW_MS) {
            return jsonResponse(200, { ok: false, reason: 'match-already-active' });
        }
        const tx = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`, cur => {
            const c = typeof cur === 'number' ? cur : 0;
            if (c < bet) return undefined; // abort — insufficient funds
            return c - bet;
        });
        if (!tx.committed) return jsonResponse(200, { ok: false, reason: 'insufficient-funds' });

        await rtdbPut(env, `${ONLINE_ROOT}/botMatches/${auth.uid}`, { bet, playerCount, active: true, at: Date.now() });
        return jsonResponse(200, { ok: true, newBalance: tx.value, bet, playerCount });
    } catch (e) {
        console.error('[botMatchStake]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
