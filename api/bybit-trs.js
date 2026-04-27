// api/bybit-trs.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless proxy — fetches NAV + asset breakdown for Bybit subaccount
// SMA01 using the Unified Account wallet endpoint.
//
// All HMAC-SHA256 signing happens here on the server.
// The API secret NEVER reaches the browser.
//
// SETUP (one-time):
//   1. Vercel Dashboard → your project → Settings → Environment Variables
//   2. Add:
//        BYBIT_TRS_API_KEY    = <your API key>       (e.g. FDg8dTWowsDtq6IxU9)
//        BYBIT_TRS_API_SECRET = <your API secret>    (paste from the modal you saw)
//   3. Redeploy (Vercel picks up env vars on next deploy)
//
// The file lives at:   /api/bybit-trs.js   (relative to your repo root)
// The browser calls:   GET /api/bybit-trs
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

const BYBIT_BASE   = 'https://api.bybit.com';
const SUBACCT_NAME = 'SMA01';
const RECV_WINDOW  = '5000';

// ── HMAC-SHA256 signing ───────────────────────────────────────────────────────
function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Build the canonical query string + signature Bybit requires
function buildHeaders(apiKey, apiSecret, queryString = '') {
    const timestamp = Date.now().toString();
    // Bybit V5 signature = HMAC_SHA256( timestamp + apiKey + recvWindow + queryString )
    const sigPayload = timestamp + apiKey + RECV_WINDOW + queryString;
    const signature  = sign(apiSecret, sigPayload);
    return {
        'X-BAPI-API-KEY':    apiKey,
        'X-BAPI-TIMESTAMP':  timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN':       signature,
        'Content-Type':      'application/json',
    };
}

// ── Bybit API call wrapper ────────────────────────────────────────────────────
async function bybitGet(path, params, apiKey, apiSecret) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${BYBIT_BASE}${path}${queryString ? '?' + queryString : ''}`;
    const headers = buildHeaders(apiKey, apiSecret, queryString);

    const res  = await fetch(url, { headers });
    const json = await res.json();

    if (json.retCode !== 0) {
        throw new Error(`Bybit API error ${json.retCode}: ${json.retMsg}`);
    }
    return json.result;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    // Only allow GET
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set in Vercel environment variables.',
        });
    }

    try {
        // ── Step 1: Get the subaccount UID by listing all subaccounts ──────────
        // Bybit endpoint: GET /v5/user/query-sub-members
        // Returns list of subaccounts under the master account.
        // We match by username (the "SMA01" name you set in Bybit).
        let subUid = null;

        try {
            const subList = await bybitGet(
                '/v5/user/query-sub-members',
                { limit: '100' },
                apiKey,
                apiSecret
            );
            // subList.subMembers is an array of { uid, username, ... }
            const members = subList?.subMembers || [];
            const match   = members.find(m =>
                m.username?.toLowerCase() === SUBACCT_NAME.toLowerCase() ||
                m.memberName?.toLowerCase() === SUBACCT_NAME.toLowerCase()
            );
            if (match) subUid = match.uid;
        } catch(e) {
            // Some API keys don't have sub-member read permission.
            // Fall through — we'll try fetching the wallet directly (works if
            // the API key was created ON the subaccount itself, not the master).
            console.warn('Could not list sub-members:', e.message);
        }

        // ── Step 2: Fetch Unified Account wallet balance ───────────────────────
        // If we found the subUid, query it explicitly; otherwise query the
        // account the key belongs to (which may already be SMA01 if the key
        // was created on the subaccount).
        const walletParams = { accountType: 'UNIFIED' };
        if (subUid) walletParams.memberId = subUid;

        const walletResult = await bybitGet(
            '/v5/account/wallet-balance',
            walletParams,
            apiKey,
            apiSecret
        );

        // walletResult.list[0] is the account object
        const account = walletResult?.list?.[0];
        if (!account) throw new Error('No wallet data returned from Bybit');

        // totalEquity = NAV in USD (Bybit's own USD valuation)
        const totalNav = parseFloat(account.totalEquity || 0);

        // coin array — filter to coins with non-zero wallet balance
        const rawCoins = account.coin || [];
        const assets = rawCoins
            .filter(c => parseFloat(c.walletBalance || 0) !== 0 || parseFloat(c.usdValue || 0) > 0.01)
            .map(c => ({
                coin:                c.coin,
                walletBalance:       parseFloat(c.walletBalance  || 0),
                availableToWithdraw: parseFloat(c.availableToWithdraw || 0),
                unrealisedPnl:       parseFloat(c.unrealisedPnl  || 0),
                usdValue:            parseFloat(c.usdValue        || 0),
            }));

        // Cache for 30 seconds (Vercel edge cache header)
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json({
            totalNav,
            assets,
            subaccount: SUBACCT_NAME,
            fetchedAt:  new Date().toISOString(),
        });

    } catch (err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
