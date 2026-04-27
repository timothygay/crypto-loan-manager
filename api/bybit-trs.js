// api/bybit-trs.js
const { RestClientV5 } = require('bybit-api');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set.',
        });
    }

    try {
        const client = new RestClientV5({ key: apiKey, secret: apiSecret });

        // Query the wallet the key belongs to directly — no memberId.
        // This works whether the key was created on the master or on SMA01 itself.
        const walletRes = await client.getWalletBalance({ accountType: 'UNIFIED' });

        if (walletRes.retCode !== 0) {
            return res.status(500).json({
                error: `Bybit error ${walletRes.retCode}: ${walletRes.retMsg}`,
            });
        }

        const account = walletRes.result?.list?.[0];
        if (!account) {
            return res.status(500).json({ error: 'No account data returned from Bybit' });
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
            subaccount: 'SMA01',
            fetchedAt:  new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
