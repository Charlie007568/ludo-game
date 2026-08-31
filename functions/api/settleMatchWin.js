import { requireAuth, rtdbGet, rtdbPatch, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const STARTING_COINS = 5000;

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
    const roomId = String(data.roomId || '');
    if (!roomId) return jsonResponse(400, { ok: false, reason: 'roomId-required' });

    try {
        const room = await rtdbGet(env, `${ONLINE_ROOT}/rooms/${roomId}`);
        if (!room) return jsonResponse(404, { ok: false, reason: 'room-not-found' });

        const players = room.players || {};
        const memberUids = Object.values(players).map(p => p && p.uid).filter(Boolean);
        if (!memberUids.includes(auth.uid)) return jsonResponse(403, { ok: false, reason: 'not-a-member' });

        const bet = Math.max(0, Math.floor(Number(room.bet) || 0));
        const playerCount = Math.max(memberUids.length, 1);
        const payout = bet * playerCount;

        // Claim settlement atomically — a room can only ever be settled
        // once, no matter how many times/devices call this.
        const settleResult = await rtdbTransaction(env, `${ONLINE_ROOT}/rooms/${roomId}/settled`, cur => {
            if (cur) return undefined; // already settled
            return { winnerUid: auth.uid, at: Date.now(), payout };
        });

        if (!settleResult.committed) return jsonResponse(200, { ok: false, reason: 'already-settled' });
        if (payout === 0) return jsonResponse(200, { ok: true, newBalance: null, payout: 0 });

        const creditResult = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`,
            cur => (typeof cur === 'number' ? cur : STARTING_COINS) + payout);
        await rtdbPatch(env, `${ONLINE_ROOT}/users/${auth.uid}`, { coinsZeroAt: null });

        return jsonResponse(200, { ok: true, newBalance: creditResult.value, payout });
    } catch (e) {
        console.error('[settleMatchWin]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
