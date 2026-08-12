// /api/equity-history — READ-ONLY proxy for underlying price history.
// Route: /api/equity-history?tickers=MU,SNDK&months=6
//
// Feeds the Market Flow term-sheet generator with actual daily price history.
// Fetches Yahoo Finance server-side because (a) Yahoo doesn't send browser-CORS
// headers, and (b) it keeps a future licensed-vendor key off the client. Returns
// ADJUSTED daily closes (split/dividend-adjusted) so rebasing to 100% is clean.
//
// Guarded by a valid session OR the shared secret (same dual-guard pattern as
// api/bybit-trs.js) so the browser UI and server-side tests can both use it.
// Nothing is stored; edge-cached 1h so re-opening the same trade is free.
const { sessionUser } = require('../lib/guard');

const yahooRange = (m) => (m <= 3 ? '3mo' : m <= 6 ? '6mo' : m <= 12 ? '1y' : '2y');

async function fetchOne(ticker, months) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${yahooRange(months)}&interval=1d`;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return { ticker, error: `HTTP ${r.status}` };
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (!res) return { ticker, error: (j && j.chart && j.chart.error && j.chart.error.description) || 'no data' };
        const ts = res.timestamp || [];
        const q = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
        const adj = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || q;
        const points = [];
        for (let i = 0; i < ts.length; i++) {
            const v = adj[i] != null ? adj[i] : q[i];
            if (v == null) continue;
            points.push([ts[i], +Number(v).toFixed(4)]);
        }
        const meta = res.meta || {};
        return {
            ticker,
            name: meta.longName || meta.shortName || ticker,
            currency: meta.currency || null,
            exchange: meta.exchangeName || null,
            points, // [[unixSeconds, adjClose], ...] — client trims to the exact tenor & rebases
        };
    } catch (e) {
        return { ticker, error: e.message };
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const me = await sessionUser(req);
    const okSecret = process.env.GAS_SHARED_SECRET && req.query.secret === process.env.GAS_SHARED_SECRET;
    if (!me && !okSecret) return res.status(401).json({ error: 'Not signed in.' });

    const tickers = String(req.query.tickers || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const months = Math.min(24, Math.max(1, parseInt(req.query.months || '6', 10) || 6));
    if (!tickers.length) return res.status(400).json({ error: 'Missing tickers param' });

    try {
        const series = await Promise.all(tickers.map((t) => fetchOne(t, months)));
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({ success: true, months, series, fetchedAt: new Date().toISOString() });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

// exposed for local unit tests (Vercel only invokes the default export)
module.exports.fetchOne = fetchOne;
