// functions/api/stakeMatch.js
// Online match ka stake SERVER side kata hai — client se nahi — taaki
// coins cheat na ho sakein. Ab CUSTOM stake support: game apne choose
// kiye hue amount ke saath call karta hai (100 – 1,00,000). RTDB rules me
// lm_online/users/$uid/coins par client writes block hain, isliye sirf
// ye function (Admin SDK) balance change kar sakta hai.
// Game call karta hai: POST /api/stakeMatch  { matchId, amount }
import { getDb, requireAuth } from '../_firebaseAdmin.js';

const DEFAULT_STAKE = 1000;
const MIN_STAKE = 100;
const MAX_STAKE = 100000;

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

    // ADDED: custom stake — na aaye ya invalid ho to default 1000
    let amount = parseInt(body.amount, 10);
    if (!isFinite(amount)) amount = DEFAULT_STAKE;
    amount = Math.max(MIN_STAKE, Math.min(MAX_STAKE, amount));

    const db = getDb();
    const stakeRef = db.ref('lm_online/matchStakes/' + matchId + '/' + uid);

    // idempotent: pehle se stake ho chuka ho to dobara mat kato
    const prev = await stakeRef.get();
    if (prev.exists()) {
      const bal = await db.ref('lm_online/users/' + uid + '/coins').get();
      return json({ ok: true, already: true, newBalance: bal.val() || 0 });
    }

    // atomic deduct — coins kam hone par transaction abort ho jati hai
    const tx = await db.ref('lm_online/users/' + uid + '/coins').transaction((cur) => {
      const c = typeof cur === 'number' ? cur : 0;
      if (c < amount) return; // abort
      return c - amount;
    });
    if (!tx.committed) return json({ ok: false, reason: 'insufficient' });

    await stakeRef.set({ amount: amount, at: Date.now() });
    return json({ ok: true, stake: amount, newBalance: tx.snapshot.val() });
  } catch (e) {
    return json({ ok: false, reason: 'server-error', error: String((e && e.message) || e) }, 500);
  }
}
