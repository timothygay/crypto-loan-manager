// api/bybit-trs.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless proxy — fetches NAV + asset breakdown for Bybit subaccount
// SMA01 using the Unified Account wallet endpoint.
//
// Written in CommonJS (require) to match Vercel's default Node.js environment.
// No package.json needed.
//
// SETUP (one-time, already done):
//   Vercel Dashboard → Settings → Environment Variables:
//     BYBIT_TRS_API_KEY    = your API key
//     BYBIT_TRS_API_SECRET = your API secret
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const BYBIT_BASE   = 'https://api.bybit.com';
const SUBACCT_NAME = 'SMA01';
const RECV_WINDOW  = '5000';

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function buildHeaders(apiKey, apiSecret, queryString) {
    const timestamp  = Date.now().toString();
    const sigPayload = timestamp + apiKey + RECV_WINDOW + (queryString || '');
    const signature  = sign(apiSecret, sigPayload);
    return {
        'X-BAPI-API-KEY':     apiKey,
        'X-BAPI-TIMESTAMP':   timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN':        signature,
        'Content-Type':       'application/json',
    };
}

async function bybitGet(path, params, apiKey, apiSecret) {
    const queryString = new URLSearchParams(params).toString();
    const url         = `${BYBIT_BASE}${path}${queryString ? '?' + queryString : ''}`;
    const headers     = buildHeaders(apiKey, apiSecret, queryString);
    const res         = await fetch(url, { headers });
    const json        = await res.json();
    if (json.retCode !== 0) {
        throw new Error(`Bybit API error ${json.retCode}: ${json.retMsg}`);
    }
    return json.result;
}

module.exports = async function handler(req, res) {
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
        // ── Step 1: Try to find the SMA01 subaccount UID ──────────────────────
        // This works if the API key was created on the MASTER account.
        // If the key was created on SMA01 itself, this will fail gracefully
        // and we fall through to query the wallet directly.
        let subUid = null;
        try {
            const subList = await bybitGet(
                '/v5/user/query-sub-members',
                { limit: '100' },
                apiKey,
                apiSecret
            );
            const members = subList?.subMembers || [];
            const match   = members.find(m =>
                (m.username   || '').toLowerCase() === SUBACCT_NAME.toLowerCase() ||
                (m.memberName || '').toLowerCase() === SUBACCT_NAME.toLowerCase()
            );
            if (match) subUid = match.uid;
        } catch (e) {
            // Key may not have sub-member list permission — fall through
            console.warn('Sub-member lookup failed (non-fatal):', e.message);
        }

        // ── Step 2: Fetch Unified Account wallet balance ───────────────────────
        const walletParams = { accountType: 'UNIFIED' };
        if (subUid) walletParams.memberId = subUid;

        const walletResult = await bybitGet(
            '/v5/account/wallet-balance',
            walletParams,
            apiKey,
            apiSecret
        );

        const account = walletResult?.list?.[0];
        if (!account) throw new Error('No wallet data returned from Bybit');

        const totalNav = parseFloat(account.totalEquity || 0);

        const assets = (account.coin || [])
            .filter(c => parseFloat(c.walletBalance || 0) !== 0 || parseFloat(c.usdValue || 0) > 0.01)
            .map(c => ({
                coin:                c.coin,
                walletBalance:       parseFloat(c.walletBalance        || 0),
                availableToWithdraw: parseFloat(c.availableToWithdraw  || 0),
                unrealisedPnl:       parseFloat(c.unrealisedPnl        || 0),
                usdValue:            parseFloat(c.usdValue             || 0),
            }));

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
};
