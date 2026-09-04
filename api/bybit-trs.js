// api/bybit-trs.js — Vercel serverless proxy for Bybit SMA01 subaccount
// Uses master API key + /v5/asset/asset-overview?memberId=555127100
// Same signing logic as bybit_subaccount_nav.py (confirmed working)
const crypto = require('crypto');

const BYBIT_BASE  = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const SMA01_UID   = '555127100';

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function getServerTime() {
    const res  = await fetch(`${BYBIT_BASE}/v5/market/time`);
    const json = await res.json();
    return parseInt(json.result.timeNano) / 1_000_000; // ms
}

async function bybitGet(path, paramStr, apiKey, apiSecret, clockOffset) {
    const timestamp = String(Math.round(Date.now() + clockOffset));
    const sigInput  = timestamp + apiKey + RECV_WINDOW + paramStr;
    const signature = crypto.createHmac('sha256', apiSecret).update(sigInput).digest('hex');
    const url       = `${BYBIT_BASE}${path}${paramStr ? '?' + paramStr : ''}`;

    const res  = await fetch(url, {
        headers: {
            'X-BAPI-API-KEY':     apiKey,
            'X-BAPI-TIMESTAMP':   timestamp,
            'X-BAPI-RECV-WINDOW': RECV_WINDOW,
            'X-BAPI-SIGN':        signature,
        }
    });
    const text = await res.text();
    if (!text) throw new Error(`Empty response from Bybit (HTTP ${res.status})`);
    const json = JSON.parse(text);
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    return json.result;
}

const { sessionUser } = require('../lib/guard');
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    // Allow either the browser UI (valid login session) OR a server-side caller with the
    // shared secret (the TRS Apps Script NAV capture calls this from Google's servers).
    const okSession = await sessionUser(req);
    const okSecret = req.query.cpb_secret && req.query.cpb_secret === process.env.GAS_SHARED_SECRET;
    if (!okSession && !okSecret) return res.status(401).json({ error: 'Sign in required.' });

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;
    if (!apiKey || !apiSecret) {
        return res.status(500).json({ error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set in Vercel env vars.' });
    }

    try {
        // Sync clock with Bybit server (same as Python script)
        const serverMs    = await getServerTime();
        const clockOffset = serverMs - Date.now();

        // Optional raw dump (auth-gated) to inspect Bybit's real response shapes when debugging.
        if (req.query.raw === '1') {
            const out = {};
            for (const [k, path, ps] of [
                ['assetOverview', '/v5/asset/asset-overview', `memberId=${SMA01_UID}`],
                ['coinsBalance',  '/v5/asset/transfer/query-account-coins-balance', `accountType=UNIFIED&memberId=${SMA01_UID}`],
                ['walletBalance', '/v5/account/wallet-balance', `accountType=UNIFIED`],
            ]) {
                try { out[k] = await bybitGet(path, ps, apiKey, apiSecret, clockOffset); }
                catch (e) { out[k + 'Error'] = e.message; }
            }
            return res.status(200).json(out);
        }

        // NAV — asset-overview's totalEquity is the true sub-account NAV (includes position MTM).
        const result   = await bybitGet('/v5/asset/asset-overview', `memberId=${SMA01_UID}`, apiKey, apiSecret, clockOffset);
        const totalNav = parseFloat(result.totalEquity || 0);

        // Per-coin breakdown — asset-overview doesn't return per-coin detail for this sub-account,
        // so pull the sub-account's coin wallet balances directly. The UI values each coin with
        // live Bybit prices (BTC/ETH; stablecoins = $1); the residual of NAV vs summed spot value
        // is shown as "Open Positions (MTM)".
        let assets = [];
        try {
            const cb = await bybitGet('/v5/asset/transfer/query-account-coins-balance', `accountType=UNIFIED&memberId=${SMA01_UID}`, apiKey, apiSecret, clockOffset);
            assets = (cb.balance || [])
                .map(b => ({ coin: b.coin, walletBalance: parseFloat(b.walletBalance || 0) }))
                .filter(a => Math.abs(a.walletBalance) > 0.000001)
                .sort((a, b) => Math.abs(b.walletBalance) - Math.abs(a.walletBalance));
        } catch (e) {
            console.error('coins-balance fetch failed:', e.message);
        }

        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json({
            totalNav,
            assets,
            subaccount: 'SMA01',
            fetchedAt:  new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
