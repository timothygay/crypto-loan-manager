// api/bybit-trs.js
// Uses the official bybit-api npm package which handles HMAC signing correctly.
// Requires package.json at repo root with "bybit-api" as a dependency.

const { RestClientV5 } = require('bybit-api');

const SUBACCT_NAME = 'SMA01';

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
        const client = new RestClientV5({ key: apiKey, secret: apiSecret });

        // Step 1: Try to find SMA01 subaccount UID
        let subUid = null;
        try {
            const subRes = await client.getSubAccountList({ limit: 100 });
            if (subRes.retCode === 0) {
                const match = (subRes.result?.subMembers || []).find(m =>
                    (m.username   || '').toLowerCase() === SUBACCT_NAME.toLowerCase() ||
                    (m.memberName || '').toLowerCase() === SUBACCT_NAME.toLowerCase()
                );
                if (match) subUid = match.uid;
            }
        } catch(e) {
            console.warn('Sub-member lookup failed (non-fatal):', e.message);
        }

        // Step 2: Fetch wallet balance
        const params = { accountType: 'UNIFIED' };
        if (subUid) params.memberId = subUid;

        const walletRes = await client.getWalletBalance(params);

        if (walletRes.retCode !== 0) {
            return res.status(500).json({
                error: `Bybit error ${walletRes.retCode}: ${walletRes.retMsg}`,
            });
        }

        const account  = walletRes.result?.list?.[0];
        if (!account) {
            return res.status(500).json({ error: 'No account data in Bybit response' });
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
            subaccount:  SUBACCT_NAME,
            subUidFound: subUid,
            fetchedAt:   new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
