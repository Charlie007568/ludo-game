import { requireAuth, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const STARTING_COINS = 1000; // every new player starts with this many
// The "Spin & Win" wheel — once per cooldown window, the player wins ONE of
// these amounts. Kept as a small fixed set (not any random number in the
// range) so the segment the wheel visually lands on can always exactly
// match what was actually awarded — see SPIN_SEGMENTS in the game HTML,
// which must list these same values in the same order (that's what draws
// the wheel and makes it stop on the right slice).
const SPIN_AMOUNTS = [50, 100, 150, 200, 250, 300, 400, 500];
const SPIN_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour (was 24 hours)

export async function onRequestOptions() {
    return optionsResponse();
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let auth;
    try { auth = await requireAuth(request); }
    catch (e) { return jsonResponse(e.statusCode || 401, { ok: false, reason: 'unauthenticated' }); }

    try {
        // The winning amount is rolled ONCE, server-side, inside the same
        // transaction that pays it out — never trust a client-supplied
        // amount for something that pays real coins.
        let awardedAmount = 0;
        const result = await rtdbTransaction(env, `${ONLINE_ROOT}/users/${auth.uid}`, u => {
            if (!u) return undefined;
            const lastClaim = u.lastDailyBonusAt;
            if (lastClaim && (Date.now() - lastClaim) < SPIN_COOLDOWN_MS) return undefined;
            awardedAmount = SPIN_AMOUNTS[Math.floor(Math.random() * SPIN_AMOUNTS.length)];
            const bal = typeof u.coins === 'number' ? u.coins : STARTING_COINS;
            return Object.assign({}, u, {
                coins: bal + awardedAmount,
                lastDailyBonusAt: Date.now(),
                coinsZeroAt: null
            });
        });

        if (!result.committed) {
            const u = result.value;
            if (u && u.lastDailyBonusAt) {
                const elapsed = Date.now() - u.lastDailyBonusAt;
                if (elapsed < SPIN_COOLDOWN_MS) return jsonResponse(200, { ok: false, reason: 'too-soon', remainingMs: SPIN_COOLDOWN_MS - elapsed });
            }
            return jsonResponse(200, { ok: false, reason: 'not-ready' });
        }
        return jsonResponse(200, { ok: true, newBalance: result.value.coins, amount: awardedAmount });
    } catch (e) {
        console.error('[claimDailyBonus/spin]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
