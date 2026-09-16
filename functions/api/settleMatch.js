// functions/api/settleMatch.js
// Online match ka result settle karta hai: jo bhi staked tha, winner ko
// pay karta hai (dono ne stake kiya to pot = 2000). Idempotent hai —
// pehle settled mark hota hai, phir payment. Sirf match ke players call
// kar sakte hain. Game call karta hai: POST /api/settleMatch { matchId }
import { getDb, requireAuth } from '../_firebaseAdmin.js';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  try {
    const authInfo = await requireAuth(context);
    const uid = authInfo && (authInfo.uid || (authInfo.user && authInfo.user.uid));
    if (!uid) return json({ ok: false, reason: 'not-signed-in' }, 401);

    let body = {};
    try { body = await context.request.json(); } catch (e) {}
    const matchId = String(body.matchId || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 60);
    if (!matchId) return json({ ok: false, reason: 'bad-request' }, 400);

    const db = getDb();
    const mSnap = await db.ref('matches/' + matchId).get();
    const m = mSnap.val() || {};

    // sirf match ke players settle kar sakte hain
    if (uid !== m.hostUid && uid !== m.guestUid) return json({ ok: false, reason: 'not-a-player' }, 403);

    const settledRef = db.ref('lm_online/matchSettled/' + matchId);
    if ((await settledRef.get()).exists()) return json({ ok: true, reason: 'already-settled' });

    const result = m.result || {};
    if (!result.winnerColor) return json({ ok: false, reason: 'no-result' });

    // game me host = Red, guest = Yellow
    const winnerUid = result.winnerColor === 'Red' ? m.hostUid : m.guestUid;

    const stakesSnap = await db.ref('lm_online/matchStakes/' + matchId).get();
    const stakes = stakesSnap.val() || {};
    const stakerUids = Object.keys(stakes);
    if (!stakerUids.length) return json({ ok: false, reason: 'not-staked' });
    const pot = stakerUids.reduce((s, u) => s + ((stakes[u] && stakes[u].amount) || 0), 0);

    // RACE-SAFE: pehle settled mark karo, phir pay karo
    await settledRef.set({ at: Date.now(), winnerUid: winnerUid || null, pot: pot });
    if (winnerUid && pot > 0) {
      await db.ref('lm_online/users/' + winnerUid + '/coins').transaction((cur) => {
        return (typeof cur === 'number' ? cur : 0) + pot;
      });
    }
    await db.ref('lm_online/matchStakes/' + matchId).remove().catch(() => {});

    const bal = await db.ref('lm_online/users/' + uid + '/coins').get();
    return json({ ok: true, winnerUid: winnerUid || null, pot: pot, newBalance: bal.val() || 0 });
  } catch (e) {
    return json({ ok: false, reason: 'server-error', error: String((e && e.message) || e) }, 500);
  }
}
