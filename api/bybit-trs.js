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

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;

    // ── STEP 1: Check env vars are present ──────────────────────────────────
    // Show first/last 4 chars of key so you can confirm it's the right one
    // without exposing the full value
    const keyPreview    = apiKey    ? `${apiKey.slice(0,4)}...${apiKey.slice(-4)}`    : 'NOT SET';
    const secretPreview = apiSecret ? `${apiSecret.slice(0,4)}...${apiSecret.slice(-4)}` : 'NOT SET';

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            stage: 'env-check',
            error: 'Missing environment variables',
            BYBIT_TRS_API_KEY:    keyPreview,
            BYBIT_TRS_API_SECRET: secretPreview,
        });
    }

    // ── STEP 2: Check what region/IP this function is running from ──────────
    let serverIp = 'unknown';
    try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipJson = await ipRes.json();
        serverIp = ipJson.ip;
    } catch(e) {
        serverIp = 'fetch-failed: ' + e.message;
    }

    // ── STEP 3: Hit Bybit public endpoint (no auth) to confirm reachability ─
    let publicTest = {};
    try {
        const pubRes  = await fetch('https://api.bybit.com/v5/market/time');
        const pubText = await pubRes.text();
        publicTest = {
            status:      pubRes.status,
            rawResponse: pubText.slice(0, 200),
        };
    } catch(e) {
        publicTest = { error: e.message };
    }

    // ── STEP 4: Hit authenticated endpoint ──────────────────────────────────
    let authTest = {};
    try {
        const queryString = 'accountType=UNIFIED';
        const headers     = buildHeaders(apiKey, apiSecret, queryString);
        const authRes     = await fetch(
            `${BYBIT_BASE}/v5/account/wallet-balance?${queryString}`,
            { headers }
        );
        const authText = await authRes.text();
        authTest = {
            status:      authRes.status,
            rawResponse: authText.slice(0, 500),
        };
    } catch(e) {
        authTest = { error: e.message };
    }

    return res.status(200).json({
        stage:                'full-diagnostic',
        envVars: {
            BYBIT_TRS_API_KEY:    keyPreview,
            BYBIT_TRS_API_SECRET: secretPreview,
        },
        serverIp,
        publicBybitTest:  publicTest,
        authBybitTest:    authTest,
    });
};
