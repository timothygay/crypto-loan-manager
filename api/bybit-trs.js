// api/bybit-trs.js — CommonJS, Vercel serverless proxy for Bybit SMA01
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
    return {
        'X-BAPI-API-KEY':     apiKey,
        'X-BAPI-TIMESTAMP':   timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN':        sign(apiSecret, sigPayload),
        'Content-Type':       'application/json',
    };
}

// Returns { ok, status, json, rawText } — never throws
async function bybitFetch(path, params, apiKey, apiSecret) {
    const queryString = new URLSearchParams(params).toString();
    const url         = `${BYBIT_BASE}${path}${queryString ? '?' + queryString : ''}`;
    const headers     = buildHeaders(apiKey, apiSecret, queryString);
    let rawText = '';
    try {
        const res = await fetch(url, { headers });
        rawText   = await res.text();
        const json = JSON.parse(rawText);
        return { ok: true, status: res.status, json, rawText };
    } catch (e) {
        return { ok: false, status: 0, json: null, rawText, parseError: e.message };
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            error: 'Missing env vars: BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set.',
        });
    }

    // ── Step 1: Try sub-member lookup (works if key is on master account) ──
    let subUid = null;
    const subFetch = await bybitFetch(
        '/v5/user/query-sub-members',
        { limit: '100' },
        apiKey, apiSecret
    );
    if (subFetch.ok && subFetch.json?.retCode === 0) {
        const members = subFetch.json.result?.subMembers || [];
        const match = members.find(m =>
            (m.username   || '').toLowerCase() === SUBACCT_NAME.toLowerCase() ||
            (m.memberName || '').toLowerCase() === SUBACCT_NAME.toLowerCase()
        );
        if (match) subUid = match.uid;
    }
    // Log what happened so we can see it in Vercel function logs
    console.log('sub-member lookup:', {
        retCode: subFetch.json?.retCode,
        retMsg:  subFetch.json?.retMsg,
        subUid,
        rawPreview: subFetch.rawText?.slice(0, 200),
    });

    // ── Step 2: Fetch wallet balance ────────────────────────────────────────
    const walletParams = { accountType: 'UNIFIED' };
    if (subUid) walletParams.memberId = subUid;

    const walletFetch = await bybitFetch(
        '/v5/account/wallet-balance',
        walletParams,
        apiKey, apiSecret
    );

    console.log('wallet fetch:', {
        retCode: walletFetch.json?.retCode,
        retMsg:  walletFetch.json?.retMsg,
        parseError: walletFetch.parseError,
        rawPreview: walletFetch.rawText?.slice(0, 300),
    });

    // If we couldn't even parse JSON, return the raw text so we can see it
    if (!walletFetch.ok) {
        return res.status(500).json({
            error:      `Bybit returned non-JSON response: ${walletFetch.parseError}`,
            rawResponse: walletFetch.rawText?.slice(0, 500) || '(empty)',
            subUidFound: subUid,
            step:       'wallet-balance',
        });
    }

    const walletJson = walletFetch.json;

    // Bybit API-level error
    if (walletJson.retCode !== 0) {
        return res.status(500).json({
            error:      `Bybit API error ${walletJson.retCode}: ${walletJson.retMsg}`,
            subUidFound: subUid,
            step:       'wallet-balance',
        });
    }

    const account = walletJson.result?.list?.[0];
    if (!account) {
        return res.status(500).json({
            error:      'Bybit returned success but no account data in result.list[0]',
            rawResult:  JSON.stringify(walletJson.result).slice(0, 300),
            subUidFound: subUid,
        });
    }

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
};
