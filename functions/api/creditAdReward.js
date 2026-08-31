import { requireAuth, rtdbTransaction, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

const ONLINE_ROOT = 'lm_online';
const STARTING_COINS = 5000;
const AD_REWARD_AMOUNT = 100; // keep in sync with AD_REWARD_AMOUNT in the game HTML
const AD_REWARD_COOLDOWN_MS = 15 * 1000; // blocks a scripted tight loop; a real ad takes far longer

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
            const lastAd = u.lastAdRewardAt;
            if (lastAd && (Date.now() - lastAd) < AD_REWARD_COOLDOWN_MS) return undefined;
            const bal = typeof u.coins === 'number' ? u.coins : STARTING_COINS;
            return Object.assign({}, u, {
                coins: bal + AD_REWARD_AMOUNT,
                lastAdRewardAt: Date.now(),
                coinsZeroAt: null
            });
        });

        if (!result.committed) return jsonResponse(200, { ok: false, reason: 'too-soon' });
        return jsonResponse(200, { ok: true, newBalance: result.value.coins, amount: AD_REWARD_AMOUNT });
    } catch (e) {
        console.error('[creditAdReward]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
