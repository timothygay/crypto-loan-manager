// ═══════════════════════════════════════════════════════════════════════════════
// CPB PRICE PROXY — Vercel Serverless Function
// Route: /api/prices
//
// Proxies Binance and Bybit price requests from Google Apps Script,
// bypassing Binance's geo-restriction on Google's server IPs.
//
// Query params:
//   exchange  = BINANCE | BYBIT
//   symbol    = BTCUSDT | ETHUSDT | XRPUSDT | ADAUSDT
//   date      = YYYY-MM-DD  (fetches 08:00 UTC fixing price for that date)
//   secret    = CPB_PRICE_SECRET env var  (shared secret for auth)
//
// Response:
//   { success: true,  price: "74538.82", source: "index|spot|kline" }
//   { success: false, error: "..." }
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    // ── CORS — allow Apps Script calls ────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { exchange, symbol, date, secret } = req.query;

    // ── Auth ─────────────────────────────────────────────────────────────────
    const expectedSecret = process.env.CPB_PRICE_SECRET;
    if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!exchange || !symbol || !date) {
        return res.status(400).json({
            success: false,
            error: 'Missing params: exchange, symbol, date'
        });
    }
    if (!['BINANCE','BYBIT'].includes(exchange.toUpperCase())) {
        return res.status(400).json({ success: false, error: 'Invalid exchange' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' });
    }

    try {
        const result = exchange.toUpperCase() === 'BINANCE'
            ? await fetchBinanceFixing(symbol.toUpperCase(), date)
            : await fetchBybitFixing(symbol.toUpperCase(), date);

        if (result.price === null) {
            return res.status(404).json({
                success: false,
                error: `No price found for ${exchange} ${symbol} on ${date}`
            });
        }

        return res.status(200).json({
            success: true,
            exchange: exchange.toUpperCase(),
            symbol: symbol.toUpperCase(),
            date,
            price: result.price.toFixed(2),
            source: result.source,
        });
    } catch (err) {
        console.error('Price proxy error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ─── BINANCE — Price Index kline at 08:00 UTC ─────────────────────────────────
async function fetchBinanceFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const indexUrl = `https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=${symbol}&contractType=PERPETUAL&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    const spotUrl  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;

    let candles = null, source = 'index';
    try {
        const r = await fetch(indexUrl);
        const d = await r.json();
        if (Array.isArray(d) && d.length > 0) candles = d;
    } catch(e) {}

    if (!candles) {
        try {
            const r = await fetch(spotUrl);
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) { candles = d; source = 'spot'; }
        } catch(e) {}
    }

    if (!candles) return { price: null, source: null };

    let best = null, bestDiff = Infinity;
    for (const c of candles) {
        const diff = Math.abs(parseInt(c[0]) - target);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    if (!best || bestDiff > 1800000) return { price: null, source: null };
    return { price: parseFloat(best[1]), source };
}

// ─── BYBIT — kline at 08:00 UTC ──────────────────────────────────────────────
async function fetchBybitFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=60&start=${start}&end=${end}&limit=5`;
    try {
        const r = await fetch(url);
        const d = await r.json();
        const list = d?.result?.list;
        if (!list?.length) return { price: null, source: null };
        let best = null, bestDiff = Infinity;
        for (const c of list) {
            const diff = Math.abs(parseInt(c[0]) - target);
            if (diff < bestDiff) { bestDiff = diff; best = c; }
        }
        if (!best || bestDiff > 1800000) return { price: null, source: null };
        return { price: parseFloat(best[1]), source: 'kline' };
    } catch(e) { return { price: null, source: null }; }
}
