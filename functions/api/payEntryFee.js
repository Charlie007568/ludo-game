import { requireAuth, rtdbGet, rtdbPut, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const STARTING_COINS = 1000; // every new player starts with this many

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
        if (bet === 0) return jsonResponse(200, { ok: true, alreadyPaid: false, amount: 0 });

        // BUG FIX: this used to check `paidUids/{uid}` with a plain rtdbGet
        // and only THEN run a separate transaction to deduct the coins —
        // two callers racing each other (a double-tap, or a client retry
        // after a slow/timed-out response) could both pass the "not paid
        // yet" check before either one had written `paidUids`, and both
        // would deduct the entry fee, charging the player twice for one
        // room. settleMatchRefund.js already avoids this by claiming its
        // "already handled" flag ATOMICALLY, first, via a transaction —
        // applying that same pattern here closes the race: only one
        // concurrent request can ever flip paidUids/{uid} from unset to
        // true, so only one can ever proceed to charge the fee.
        const claimResult = await rtdbTransaction(env, `${ONLINE_ROOT}/rooms/${roomId}/paidUids/${auth.uid}`, cur => {
            if (cur === true) return undefined; // already paid — abort, no double charge
            return true;
        });
        if (!claimResult.committed) return jsonResponse(200, { ok: true, alreadyPaid: true, amount: bet });

        const result = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`, cur => {
            const bal = typeof cur === 'number' ? cur : STARTING_COINS;
            if (bal < bet) return undefined; // abort — insufficient funds
            return bal - bet;
        });

        if (!result.committed) {
            // Couldn't actually charge them — release the paid claim so a
            // later retry (e.g. after topping up coins) can still pay.
            await rtdbPut(env, `${ONLINE_ROOT}/rooms/${roomId}/paidUids/${auth.uid}`, false).catch(() => {});
            return jsonResponse(200, { ok: false, reason: 'insufficient-funds' });
        }

        return jsonResponse(200, { ok: true, newBalance: result.value, amount: bet });
    } catch (e) {
        console.error('[payEntryFee]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}

