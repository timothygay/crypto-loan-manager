// CPB DCI PRODUCT PROXY — Vercel Serverless Function
// Route: /api/dci-penguin
//
// Fetches Penguin Securities' own DCI product list server-side so that:
//   1. the x-api-key is never shipped to the browser, and
//   2. we sidestep any CORS restriction on prod-api.penguinsecurities.sg.
//
// Returns a slim lookup keyed by Deribit-style instrument_name (identical to the
// ladder's names, e.g. "BTC-14AUG26-63000-C"):
//   { success, apr: { <instrument>: { adj, raw } }, count, fetchedAt }
// where `adj` = calc_adj_apy (skew-adjusted, Penguin's own 30% skew) and
//       `raw` = calc_apy (un-skewed). Both are decimals (1.7995 = 179.95% p.a.).
//
// Set DCI_API_KEY in the environment (see .env.local + Vercel project env).

const DCI_LIST_URL = 'https://prod-api.penguinsecurities.sg/pub/apigw/product/dci/list';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const apiKey = process.env.DCI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ success: false, error: 'DCI_API_KEY not configured' });
    }

    try {
        const r = await fetch(DCI_LIST_URL, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!r.ok) {
            return res.status(502).json({ success: false, error: `DCI API ${r.status}` });
        }
        const d = await r.json();
        const rows = Array.isArray(d?.rows) ? d.rows : [];

        const apr = {};
        for (const p of rows) {
            if (!p || !p.instrument_name) continue;
            apr[p.instrument_name] = {
                adj: (typeof p.calc_adj_apy === 'number') ? p.calc_adj_apy : null,
                raw: (typeof p.calc_apy === 'number') ? p.calc_apy : null,
            };
        }

        // Cache at the edge for 60s (SWR 120s) — the ladder refreshes every 5 min.
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).json({ success: true, apr, count: rows.length, fetchedAt: new Date().toISOString() });
    } catch (err) {
        console.error('DCI penguin proxy error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
}
