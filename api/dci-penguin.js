// CPB DCI APR PROXY — Vercel Serverless Function
// Route: /api/dci-penguin
//
// Penguin's DCI API (prod-api.penguinsecurities.sg) IP-allowlists callers, and
// THIS app's Vercel egress IP is NOT on the list (403 Forbidden). The treasury
// monitor's egress IP *is* allowlisted, so we relay through its read-only endpoint
// /api/cron/dci-list (guarded by the shared CRON_SECRET). Nothing is stored on
// either side — every call fetches live, so the ladder's Refresh button always
// gets current rates.
//
// Returns { success, apr: { <instrument_name>: { adj, raw } }, count, fetchedAt }
// where adj = calc_adj_apy (skew-adjusted), raw = calc_apy. Both decimals
// (1.7995 = 179.95% p.a.). apr map keyed by Deribit-style instrument_name.
//
// Env: MONITOR_API_URL (treasury base URL), MONITOR_RELAY_SECRET (= treasury CRON_SECRET).
//
// SECOND MODE — ?kind=equity&tickers=MU,SNDK&months=6 : returns underlying price
// history (Yahoo Finance adjusted daily closes) for the Market Flow term-sheet
// generator. Folded in here (rather than its own api/ file) to stay within the
// Hobby plan's 12-serverless-function cap. Public market data, so unguarded like
// the DCI mode; edge-cached 1h. Series: [{ticker,name,currency,points:[[ts,adjClose]]}].

const MONITOR_URL = process.env.MONITOR_API_URL || "https://penguin-treasury-monitor.vercel.app";

const yahooRange = (m) => (m <= 3 ? "3mo" : m <= 6 ? "6mo" : m <= 12 ? "1y" : "2y");
async function fetchEquity(ticker, months) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${yahooRange(months)}&interval=1d`;
    try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) return { ticker, error: `HTTP ${r.status}` };
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (!res) return { ticker, error: (j && j.chart && j.chart.error && j.chart.error.description) || "no data" };
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
        return { ticker, name: meta.longName || meta.shortName || ticker, currency: meta.currency || null, exchange: meta.exchangeName || null, points };
    } catch (e) {
        return { ticker, error: e.message };
    }
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

    // ── Equity-history mode (Market Flow term sheets) ──
    if (req.query.kind === "equity") {
        const tickers = String(req.query.tickers || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
        const months = Math.min(24, Math.max(1, parseInt(req.query.months || "6", 10) || 6));
        if (!tickers.length) return res.status(400).json({ success: false, error: "Missing tickers" });
        try {
            const series = await Promise.all(tickers.map((t) => fetchEquity(t, months)));
            res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
            return res.status(200).json({ success: true, months, series, fetchedAt: new Date().toISOString() });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    // ── Default: DCI APR relay ──
    const secret = process.env.MONITOR_RELAY_SECRET;
    if (!secret) {
        return res.status(500).json({ success: false, error: "MONITOR_RELAY_SECRET not configured" });
    }

    try {
        const r = await fetch(`${MONITOR_URL}/api/cron/dci-list`, {
            headers: { Authorization: `Bearer ${secret}` },
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) {
            return res.status(502).json({ success: false, error: `relay ${r.status}: ${d.error || "unknown"}` });
        }
        // Always fresh — the ladder's Refresh button should reflect live rates.
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ success: true, apr: d.apr || {}, count: d.count ?? 0, fetchedAt: d.fetchedAt });
    } catch (err) {
        console.error("DCI penguin relay error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
}
