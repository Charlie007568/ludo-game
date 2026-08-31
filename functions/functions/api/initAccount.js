import { requireAuth, rtdbGet, rtdbPatch, jsonResponse, optionsResponse } from '../_firebaseAdmin.js';

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
    const publicId = typeof data.publicId === 'string' ? data.publicId.slice(0, 64) : null;
    const uid = auth.uid;

    try {
        const existingCoins = await rtdbGet(env, `${ONLINE_ROOT}/users/${uid}/coins`);
        if (typeof existingCoins === 'number') {
            return jsonResponse(200, { ok: true, alreadyInitialized: true, newBalance: existingCoins });
        }

        let startingCoins = STARTING_COINS;
        let coinsZeroAt = null;
        let lastDailyBonusAt = null;

        if (publicId) {
            const oldUid = await rtdbGet(env, `${ONLINE_ROOT}/idIndex/${publicId}`);
            if (oldUid && oldUid !== uid) {
                const old = await rtdbGet(env, `${ONLINE_ROOT}/users/${oldUid}`);
                if (old && typeof old.coins === 'number') {
                    startingCoins = old.coins;
                    coinsZeroAt = old.coinsZeroAt || null;
                    lastDailyBonusAt = old.lastDailyBonusAt || null;
                }
            }
        }

        await rtdbPatch(env, `${ONLINE_ROOT}/users/${uid}`, { coins: startingCoins, coinsZeroAt, lastDailyBonusAt });
        return jsonResponse(200, { ok: true, newBalance: startingCoins });
    } catch (e) {
        console.error('[initAccount]', e);
        return jsonResponse(500, { ok: false, reason: 'server-error' });
    }
}
