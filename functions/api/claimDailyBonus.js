import { requireAuth, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const STARTING_COINS = 5000;
const DAILY_BONUS_AMOUNT = 100; // keep in sync with DAILY_BONUS_AMOUNT in the game HTML
const DAY_MS = 24 * 60 * 60 * 1000;

export async function onRequestOptions() {
    return optionsResponse();
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let auth;
    try { auth = await requireAuth(request); }
    catch (e) { return jsonResponse(e.statusCode || 401, { ok: false, reason: 'unauthenticated' }); }

    try {
        const result = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}`, u => {
            if (!u) return undefined;
            const lastClaim = u.lastDailyBonusAt;
            if (lastClaim && (Date.now() - lastClaim) < DAY_MS) return undefined;
            const bal = typeof u.coins === 'number' ? u.coins : STARTING_COINS;
            return Object.assign({}, u, {
                coins: bal + DAILY_BONUS_AMOUNT,
                lastDailyBonusAt: Date.now(),
                coinsZeroAt: null
            });
        });

        if (!result.committed) {
            const u = result.value;
            if (u && u.lastDailyBonusAt) {
                const elapsed = Date.now() - u.lastDailyBonusAt;
                if (elapsed < DAY_MS) return jsonResponse(200, { ok: false, reason: 'too-soon', remainingMs: DAY_MS - elapsed });
            }
            return jsonResponse(200, { ok: false, reason: 'not-ready' });
        }
        return jsonResponse(200, { ok: true, newBalance: result.value.coins });
    } catch (e) {
        console.error('[claimDailyBonus]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
