// api/bybit-trs.js — CommonJS, Vercel serverless proxy for Bybit SMA01
const crypto = require('crypto');

const BYBIT_BASE   = 'https://api.bybit.com';
const RECV_WINDOW  = '10000';

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function getServerTime() {
    const res  = await fetch(`${BYBIT_BASE}/v5/market/time`);
    const json = await res.json();
    return parseInt(json.result.timeSecond) * 1000;
}

async function bybitGet(path, params, apiKey, apiSecret, clockOffset) {
    const paramStr = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
    const timestamp = String(Date.now() + clockOffset);
    const sigInput  = timestamp + apiKey + RECV_WINDOW + paramStr;
    const signature = sign(apiSecret, sigInput);
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
    if (json.retCode !== 0) throw new Error(`Bybit error ${json.retCode}: ${json.retMsg}`);
    return json.result;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set in Vercel environment variables.',
        });
    }

    try {
        // Sync clock with Bybit server to avoid timestamp rejection
        const serverTime  = await getServerTime();
        const clockOffset = serverTime - Date.now();

        const result  = await bybitGet(
            '/v5/account/wallet-balance',
            { accountType: 'UNIFIED' },
            apiKey, apiSecret, clockOffset
        );

        const account = result?.list?.[0];
        if (!account) throw new Error('No account data returned from Bybit');

        const totalNav = parseFloat(account.totalEquity || 0);
        const assets   = (account.coin || [])
            .filter(c => parseFloat(c.walletBalance || 0) !== 0 || parseFloat(c.usdValue || 0) > 0.01)
            .map(c => ({
                coin:                c.coin,
                walletBalance:       parseFloat(c.walletBalance       || 0),
                availableToWithdraw: parseFloat(c.availableToWithdraw || 0),
                unrealisedPnl:       parseFloat(c.unrealisedPnl       || 0),
                usdValue:            parseFloat(c.usdValue            || 0),
            }))
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
