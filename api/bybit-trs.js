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

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;
    if (!apiKey || !apiSecret) {
        return res.status(500).json({ error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set in Vercel env vars.' });
    }

    try {
        // Sync clock with Bybit server (same as Python script)
        const serverMs    = await getServerTime();
        const clockOffset = serverMs - Date.now();

        // Query SMA01 subaccount using master key + memberId
        const paramStr = `memberId=${SMA01_UID}`;
        const result   = await bybitGet('/v5/asset/asset-overview', paramStr, apiKey, apiSecret, clockOffset);

        // Parse response — result.list is array of account types (UNIFIED, FUND, etc.)
        const totalNav = parseFloat(result.totalEquity || 0);
        const accounts = result.list || [];

        // Collect all coin holdings across all account types
        const coinMap = {};
        for (const acct of accounts) {
            const coinDetails = acct.coinDetail || [];
            for (const cd of coinDetails) {
                const equity = parseFloat(cd.equity || 0);
                if (Math.abs(equity) < 0.000001) continue;
                const coin = cd.coin;
                if (!coinMap[coin]) coinMap[coin] = { coin, walletBalance: 0, usdValue: 0, unrealisedPnl: 0, availableToWithdraw: 0 };
                coinMap[coin].walletBalance       += equity;
                coinMap[coin].usdValue            += parseFloat(cd.equityValue || cd.usdValue || 0);
                coinMap[coin].unrealisedPnl       += parseFloat(cd.unrealisedPnl || 0);
                coinMap[coin].availableToWithdraw += parseFloat(cd.availableBalance || 0);
            }
        }

        const assets = Object.values(coinMap)
            .filter(c => Math.abs(c.walletBalance) > 0.000001 || c.usdValue > 0.01)
            .sort((a, b) => b.usdValue - a.usdValue);

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
