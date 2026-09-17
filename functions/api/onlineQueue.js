// functions/api/onlineQueue.js
// Online random matchmaking: same playerCount + same bet wale players ko
// atomically pair karke lm_online/rooms/{roomId} bana deta hai.
// Game call karta hai: POST /api/onlineQueue { action:'join'|'leave', playerCount, bet, deviceId, name }
import { requireAuth, rtdbGet, rtdbPatch, rtdbPut, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const MIN_BET = 100;
const MAX_BET = 100000;
const QUEUE_STALE_MS = 90000;

export async function onRequestOptions() { return optionsResponse(); }

export async function onRequestPost(context) {
    const { request, env } = context;
    let auth;
    try { auth = await requireAuth(request); }
    catch (e) { return jsonResponse(e.statusCode || 401, { ok: false, reason: 'unauthenticated' }); }

    let data = {};
    try { data = await request.json(); } catch (e) {}
    const action = data.action === 'leave' ? 'leave' : 'join';
    const playerCount = Math.max(2, Math.min(4, parseInt(data.playerCount, 10) || 2));
    let bet = parseInt(data.bet, 10);
    if (!isFinite(bet)) bet = 1000;
    bet = Math.max(MIN_BET, Math.min(MAX_BET, bet));
    const deviceId = String(data.deviceId || '').slice(0, 60);
    const name = String(data.name || 'Player').slice(0, 60);

    if (action === 'leave') {
        await rtdbPatch(env, `${ONLINE_ROOT}/queue/${auth.uid}`, null).catch(() => {});
        return jsonResponse(200, { ok: true, status: 'left' });
    }

    const myCoins = await rtdbGet(env, `${ONLINE_ROOT}/users/${auth.uid}/coins`);
    if (typeof myCoins === 'number' && myCoins < bet) {
        return jsonResponse(200, { ok: false, reason: 'insufficient-funds' });
    }

    // global lock — do concurrent requests same players ko double-pair na karein
    const lock = await rtdbTransaction(env, `${ONLINE_ROOT}/queue/_lock`, cur => (cur === true ? undefined : true));
    if (!lock.committed) return jsonResponse(200, { ok: false, reason: 'busy' });
    try {
        const queue = (await rtdbGet(env, `${ONLINE_ROOT}/queue`)) || {};
        const now = Date.now();
        const updates = {};
        const peers = [];
        for (const [uid, e] of Object.entries(queue)) {
            if (!e || uid === '_lock' || !e.uid || uid === auth.uid) continue;
            if (now - (e.at || 0) > QUEUE_STALE_MS) { updates[uid] = null; continue; }
            if (e.playerCount !== playerCount || e.bet !== bet) continue;
            const pc = await rtdbGet(env, `${ONLINE_ROOT}/users/${uid}/coins`);
            if (typeof pc === 'number' && pc < bet) { updates[uid] = null; continue; }
            const op = await rtdbGet(env, `onlinePlayers/${e.deviceId}/inMatch`);
            if (op) { updates[uid] = null; continue; }
            peers.push(e);
            if (peers.length >= playerCount - 1) break;
        }
        if (peers.length >= playerCount - 1) {
            const me = { uid: auth.uid, deviceId, name, playerCount, bet, at: now };
            const team = [me, ...peers];
            const roomId = 'room_' + now.toString(36) + Math.random().toString(36).slice(2, 6);
            const SEATS = ['Red', 'Green', 'Yellow', 'Blue'];
            const players = {};
            team.forEach((p, i) => { players[p.uid] = { uid: p.uid, deviceId: p.deviceId, name: p.name, color: SEATS[i] }; });
            await rtdbPatch(env, `${ONLINE_ROOT}/rooms/${roomId}`, {
                roomId, bet, playerCount, createdAt: now, status: 'paying', players
            });
            updates[auth.uid] = null;
            peers.forEach(p => { updates[p.uid] = null; });
            await rtdbPatch(env, `${ONLINE_ROOT}/queue`, updates);
            return jsonResponse(200, { ok: true, status: 'matched', roomId, room: { roomId, bet, playerCount, players } });
        }
        await rtdbPatch(env, `${ONLINE_ROOT}/queue/${auth.uid}`, { uid: auth.uid, deviceId, name, playerCount, bet, at: now });
        return jsonResponse(200, { ok: true, status: 'waiting' });
    } finally {
        await rtdbPut(env, `${ONLINE_ROOT}/queue/_lock`, false).catch(() => {});
    }
}
