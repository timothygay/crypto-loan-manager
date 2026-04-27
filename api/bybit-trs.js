// api/bybit-trs.js — CommonJS, Vercel serverless proxy for Bybit SMA01
const crypto = require('crypto');

const BYBIT_BASE   = 'https://api.bybit.com';
const SUBACCT_NAME = 'SMA01';
const RECV_WINDOW  = '5000';

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Bybit V5 GET signature:
// paramString = raw query string (e.g. "accountType=UNIFIED")
// sigPayload  = timestamp + apiKey + recvWindow + paramString
// signature   = HMAC-SHA256(sigPayload, apiSecret)
function buildHeaders(apiKey, apiSecret, paramString) {
    const timestamp  = Date.now().toString();
    const sigPayload = timestamp + apiKey + RECV_WINDOW + paramString;
    const signature  = sign(apiSecret, sigPayload);
    return {
        'X-BAPI-API-KEY':     apiKey,
        'X-BAPI-TIMESTAMP':   timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN':        signature,
    };
}

// Build param string exactly as Bybit expects — no URLencoding of values
function toParamString(params) {
    return Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
}

async function bybitGet(path, params, apiKey, apiSecret) {
    const paramString = toParamString(params);
    const url         = `${BYBIT_BASE}${path}?${paramString}`;
    const headers     = buildHeaders(apiKey, apiSecret, paramString);
    const res         = await fetch(url, { headers });
    const text        = await res.text();
    let json;
    try { json = JSON.parse(text); } catch(e) {
        throw new Error(`Non-JSON from Bybit (${res.status}): ${text.slice(0,200)}`);
    }
    if (json.retCode !== 0) {
        throw new Error(`Bybit error ${json.retCode}: ${json.retMsg}`);
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
        // ── Step 1: Try sub-member lookup to find SMA01 UID ─────────────────
        let subUid = null;
        try {
            const subResult = await bybitGet(
                '/v5/user/query-sub-members',
                { limit: '100' },
                apiKey, apiSecret
            );
            const members = subResult?.subMembers || [];
            const match   = members.find(m =>
                (m.username   || '').toLowerCase() === SUBACCT_NAME.toLowerCase() ||
                (m.memberName || '').toLowerCase() === SUBACCT_NAME.toLowerCase()
            );
            if (match) subUid = match.uid;
        } catch(e) {
            // Non-fatal — key may belong to the subaccount itself
            console.warn('Sub-member lookup failed (non-fatal):', e.message);
        }

        // ── Step 2: Fetch wallet balance ─────────────────────────────────────
        const walletParams = { accountType: 'UNIFIED' };
        if (subUid) walletParams.memberId = subUid;

        const walletResult = await bybitGet(
            '/v5/account/wallet-balance',
            walletParams,
            apiKey, apiSecret
        );

        const account = walletResult?.list?.[0];
        if (!account) throw new Error('No account data in Bybit response');

        const totalNav = parseFloat(account.totalEquity || 0);
        const assets   = (account.coin || [])
            .filter(c => parseFloat(c.walletBalance || 0) !== 0 || parseFloat(c.usdValue || 0) > 0.01)
            .map(c => ({
                coin:                c.coin,
                walletBalance:       parseFloat(c.walletBalance       || 0),
                availableToWithdraw: parseFloat(c.availableToWithdraw || 0),
                unrealisedPnl:       parseFloat(c.unrealisedPnl       || 0),
                usdValue:            parseFloat(c.usdValue            || 0),
            }));

        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json({
            totalNav,
            assets,
            subaccount: SUBACCT_NAME,
            subUidFound: subUid,
            fetchedAt:  new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
