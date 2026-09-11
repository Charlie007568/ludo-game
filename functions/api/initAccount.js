import { requireAuth, rtdbGet, rtdbPatch, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

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
    const publicId = typeof data.publicId === 'string' ? data.publicId.slice(0, 64) : null;
    const uid = auth.uid;

    try {
        const existingCoins = await rtdbGet(env, `${ONLINE_ROOT}/users/${uid}/coins`);
        if (typeof existingCoins === 'number') {
            return jsonResponse(200, { ok: true, alreadyInitialized: true, newBalance: existingCoins });
        }

        // BUG FIX: this used to look up an older uid linked to the same
        // publicId (idIndex/{publicId}) and, if found, COPY that old
        // account's coin balance as the "starting" balance for the brand
        // new uid. On any device/browser that had been used before (or
        // whose old test account had built up coins via ad rewards / daily
        // bonuses / manual crediting), this silently handed the new uid
        // that old balance instead of STARTING_COINS — which is exactly
        // the "shows 1000, then a couple seconds later flips to 5000"
        // symptom. A genuinely first-time account must always get exactly
        // STARTING_COINS, so that inheritance is removed.
        const startingCoins = STARTING_COINS;
        const coinsZeroAt = null;
        const lastDailyBonusAt = null;

        await rtdbPatch(env, `${ONLINE_ROOT}/users/${uid}`, { coins: startingCoins, coinsZeroAt, lastDailyBonusAt });
        return jsonResponse(200, { ok: true, newBalance: startingCoins });
    } catch (e) {
        console.error('[initAccount]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
