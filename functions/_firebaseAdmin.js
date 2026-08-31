/**
 * ─── Firebase "admin" access from Cloudflare Pages Functions ──────────────
 * (leading underscore = not itself a routed endpoint; the files in ./api/
 *  import from this one)
 *
 * WHY THIS EXISTS:
 * Same reasoning as the Netlify version of this file — Firebase Cloud
 * Functions need the Blaze (billing) plan just to deploy, even for free-
 * tier usage. Cloudflare Pages Functions don't, and — like Netlify — they
 * can talk to Firebase's Realtime Database REST API using a Service
 * Account's OAuth2 token, which Firebase treats as admin access
 * (bypasses Security Rules), same as the firebase-admin SDK does.
 *
 * DIFFERENCE FROM THE NETLIFY VERSION: Cloudflare Pages Functions run on
 * the Workers runtime, not Node.js — there's no Node `crypto` module.
 * Everything cryptographic here uses the standard Web Crypto API
 * (`crypto.subtle`) instead, which is the Workers-native equivalent.
 *
 * SETUP (one-time):
 *   1. Firebase Console → ⚙️ Project Settings → Service Accounts →
 *      "Generate new private key" → downloads a JSON file. Free on the
 *      Spark plan — no Blaze needed for this step.
 *   2. In that JSON, copy `client_email` and `private_key`.
 *   3. Cloudflare dashboard → your Pages project → Settings →
 *      Environment variables → add (as "Secret", not "Plaintext"):
 *        FIREBASE_SA_EMAIL        = the client_email value
 *        FIREBASE_SA_PRIVATE_KEY  = the private_key value (paste exactly
 *                                    as-is, including BEGIN/END lines)
 *      Never put these values directly in a code file that goes into a
 *      (possibly public) GitHub repo — env vars are the only safe place.
 */

export const PROJECT_ID = 'root-cause-9c9fc';
export const DB_URL = 'https://root-cause-9c9fc-default-rtdb.firebaseio.com';

// ─── base64url helpers (Workers has atob/btoa but not base64url directly) ─
function b64urlEncodeBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlEncodeStr(str) {
    return b64urlEncodeBytes(new TextEncoder().encode(str));
}
function b64urlDecodeToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}
function b64urlDecodeToJson(b64url) {
    return JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(b64url)));
}
function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

// ─── Verify a Firebase ID token from the game client ──────────────────────
// Uses Google's JWK endpoint (a plain JSON Web Key Set) rather than the
// X.509 cert endpoint, since Web Crypto's importKey('jwk', ...) can use a
// JWK directly — no certificate parsing needed.
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwksCache = null;
let _jwksCacheAt = 0;

async function _getGoogleJwks() {
    if (_jwksCache && (Date.now() - _jwksCacheAt) < 5 * 60 * 1000) return _jwksCache;
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw new Error('jwks-fetch-failed');
    const data = await res.json();
    _jwksCache = data.keys || [];
    _jwksCacheAt = Date.now();
    return _jwksCache;
}

export async function verifyIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string') throw new Error('missing-token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('malformed-token');
    const header = b64urlDecodeToJson(parts[0]);
    const payload = b64urlDecodeToJson(parts[1]);

    if (payload.aud !== PROJECT_ID) throw new Error('wrong-audience');
    if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('wrong-issuer');
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('expired');
    if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('bad-iat');
    if (!payload.sub) throw new Error('missing-sub');

    const keys = await _getGoogleJwks();
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) throw new Error('unknown-kid');

    const publicKey = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const signedData = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const signature = b64urlDecodeToBytes(parts[2]);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signedData);
    if (!ok) throw new Error('bad-signature');

    return { uid: payload.sub, email: payload.email || null };
}

export async function requireAuth(request) {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const err = new Error('unauthenticated'); err.statusCode = 401; throw err;
    }
    try {
        return await verifyIdToken(authHeader.slice('Bearer '.length));
    } catch (e) {
        const err = new Error('invalid-token'); err.statusCode = 401; throw err;
    }
}

// ─── Mint an admin access token from the Service Account ─────────────────
let _tokenCache = null;
let _tokenExpiry = 0;

async function _getAdminAccessToken(env) {
    if (_tokenCache && Date.now() < _tokenExpiry - 60000) return _tokenCache;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
        iss: env.FIREBASE_SA_EMAIL,
        scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    };
    const unsigned = `${b64urlEncodeStr(JSON.stringify(header))}.${b64urlEncodeStr(JSON.stringify(claims))}`;

    const privateKeyPem = (env.FIREBASE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const privateKey = await crypto.subtle.importKey(
        'pkcs8', pemToArrayBuffer(privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    const signatureBuf = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned)
    );
    const jwt = `${unsigned}.${b64urlEncodeBytes(new Uint8Array(signatureBuf))}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error('token-mint-failed: ' + JSON.stringify(data));

    _tokenCache = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return _tokenCache;
}

// ─── Realtime Database REST helpers (admin — bypasses Security Rules) ────
export async function rtdbGet(env, path) {
    const token = await _getAdminAccessToken(env);
    const res = await fetch(`${DB_URL}/${path}.json`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('rtdb-get-failed:' + res.status);
    return res.json();
}

async function _rtdbGetWithEtag(env, path) {
    const token = await _getAdminAccessToken(env);
    const res = await fetch(`${DB_URL}/${path}.json`, {
        headers: { Authorization: 'Bearer ' + token, 'X-Firebase-ETag': 'true' }
    });
    if (!res.ok) throw new Error('rtdb-get-failed:' + res.status);
    const etag = res.headers.get('ETag');
    const value = await res.json();
    return { value, etag };
}

async function _rtdbPutIfMatch(env, path, value, etag) {
    const token = await _getAdminAccessToken(env);
    const res = await fetch(`${DB_URL}/${path}.json`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'if-match': etag },
        body: JSON.stringify(value)
    });
    if (res.status === 412) return false; // someone else wrote first
    if (!res.ok) throw new Error('rtdb-put-failed:' + res.status);
    return true;
}

export async function rtdbPut(env, path, value) {
    const token = await _getAdminAccessToken(env);
    const res = await fetch(`${DB_URL}/${path}.json`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error('rtdb-put-failed:' + res.status);
    return true;
}

export async function rtdbPatch(env, path, value) {
    const token = await _getAdminAccessToken(env);
    const res = await fetch(`${DB_URL}/${path}.json`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error('rtdb-patch-failed:' + res.status);
    return true;
}

// Read-modify-write with retry-on-conflict — REST equivalent of
// ref.transaction(updater). `updater(currentValue)` returns the new value
// to write, or `undefined` to abort (insufficient funds, already claimed).
export async function rtdbTransaction(env, path, updater, maxRetries = 6) {
    for (let i = 0; i < maxRetries; i++) {
        const { value, etag } = await _rtdbGetWithEtag(env, path);
        const result = updater(value);
        if (result === undefined) return { committed: false, value };
        const ok = await _rtdbPutIfMatch(env, path, result, etag);
        if (ok) return { committed: true, value: result };
        // else: lost the race — loop and retry against the fresh value
    }
    throw new Error('transaction-retry-exhausted');
}

// ─── HTTP response helpers (Cloudflare Pages Functions use the Fetch API) ─
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export function jsonResponse(statusCode, obj) {
    return new Response(JSON.stringify(obj), {
        status: statusCode,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
    });
}

export function optionsResponse() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

