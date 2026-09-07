// api/bybit-trs.js — Vercel serverless proxy for Bybit SMA01 subaccount
// Uses master API key + /v5/asset/asset-overview?memberId=555127100
// Same signing logic as bybit_subaccount_nav.py (confirmed working)
const crypto = require('crypto');

const BYBIT_BASE  = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const SMA01_UID   = '555127100';
// Sub-accounts to report. One master API key reads each by memberId — no extra keys.
const SUBACCOUNTS = [
    { name: 'SMA01',     uid: '555127100' },
    { name: 'SMA01_BTC', uid: '586292192' },
    { name: 'SMA01_ETH', uid: '586292350' },
];

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

// Turn an /v5/asset/asset-overview result into { totalNav, assets:[{coin,walletBalance}] }.
// Per-coin detail is nested at list[].categories[].coinDetail[] ({coin, equity}); equity is
// the coin quantity (incl. any position PnL carried in that coin).
function parseOverview(result) {
    const totalNav = parseFloat(result.totalEquity || 0);
    const coinMap = {};
    for (const acct of (result.list || [])) {
        const details = [
            ...((acct.categories || []).flatMap(c => c.coinDetail || [])),
            ...(acct.coinDetail || []),   // fallback if a future account type is flat
        ];
        for (const cd of details) {
            const q = parseFloat(cd.equity || cd.walletBalance || 0);
            if (!(Math.abs(q) > 1e-9)) continue;
            coinMap[cd.coin] = (coinMap[cd.coin] || 0) + q;
        }
    }
    const assets = Object.entries(coinMap)
        .map(([coin, walletBalance]) => ({ coin, walletBalance }))
        .filter(a => Math.abs(a.walletBalance) > 1e-9)
        .sort((a, b) => Math.abs(b.walletBalance) - Math.abs(a.walletBalance));
    return { totalNav, assets };
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

        // Fetch every configured sub-account independently (one master key reads all by memberId).
        // asset-overview's totalEquity is each account's true NAV (includes position MTM); the
        // per-coin breakdown is valued in the UI with live Bybit prices, NAV−Σspot = "Open Positions (MTM)".
        const settled = await Promise.allSettled(
            SUBACCOUNTS.map(s => bybitGet('/v5/asset/asset-overview', `memberId=${s.uid}`, apiKey, apiSecret, clockOffset))
        );
        const accounts = SUBACCOUNTS.map((s, i) => {
            const r = settled[i];
            if (r.status !== 'fulfilled') return { name: s.name, uid: s.uid, error: (r.reason && r.reason.message) || 'fetch failed' };
            const { totalNav, assets } = parseOverview(r.value);
            return { name: s.name, uid: s.uid, totalNav, assets };
        });
        // Keep the legacy single-account fields (primary = SMA01) so the existing NAV header,
        // history and alerts keep working unchanged.
        const primary = accounts.find(a => a.uid === SMA01_UID) || accounts[0] || {};

        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json({
            totalNav:   primary.totalNav || 0,
            assets:     primary.assets || [],
            accounts,
            subaccount: 'SMA01',
            fetchedAt:  new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
