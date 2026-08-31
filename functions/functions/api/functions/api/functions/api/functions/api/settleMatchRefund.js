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
        const isMember = Object.values(players).some(p => p && p.uid === auth.uid);
        if (!isMember) return jsonResponse(403, { ok: false, reason: 'not-a-member' });

        const bet = Math.max(0, Math.floor(Number(room.bet) || 0));

        const claimResult = await rtdbTransaction(env, `${ONLINE_ROOT}/rooms/${roomId}/refundedUids/${auth.uid}`, cur => {
            if (cur) return undefined; // already refunded
            return true;
        });
        if (!claimResult.committed) return jsonResponse(200, { ok: false, reason: 'already-refunded' });
        if (bet === 0) return jsonResponse(200, { ok: true, newBalance: null, payout: 0 });

        const creditResult = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`,
            cur => (typeof cur === 'number' ? cur : STARTING_COINS) + bet);
        await rtdbPatch(env, `${ONLINE_ROOT}/users/${auth.uid}`, { coinsZeroAt: null });

        return jsonResponse(200, { ok: true, newBalance: creditResult.value, payout: bet });
    } catch (e) {
        console.error('[settleMatchRefund]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
