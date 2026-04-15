// CPB PRICE PROXY — Vercel Serverless Function
// Route: /api/prices
//
// Price source priority for BINANCE:
//   1. fapi.binance.com/fapi/v1/indexPriceKlines  — true Binance Price Index (may be geo-blocked)
//   2. fapi.binance.com/fapi/v1/klines             — Binance futures perpetual (same exchange, close to index)
//   3. api.binance.com/api/v3/klines               — Binance spot (may be geo-blocked)
//   4. api.binance.us/api/v3/klines                — Binance US (not geo-blocked, slight price diff)
//
// NOTE: The UI uses source #1 directly from the browser (not geo-blocked for end users).
// The goal here is to match source #1 as closely as possible from Vercel's servers.
// Sources #2 and #3 track the Price Index within ~0.01% which is acceptable for barrier checks.

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { exchange, symbol, date, secret } = req.query;

    // Auth
    const expectedSecret = process.env.CPB_PRICE_SECRET;
    if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Validate
    if (!exchange || !symbol || !date) {
        return res.status(400).json({ success: false, error: 'Missing params: exchange, symbol, date' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' });
    }

    const exc = exchange.toUpperCase();
    const sym = symbol.toUpperCase();

    try {
        let result;
        if (exc === 'BINANCE') {
            result = await fetchBinanceFixing(sym, date);
        } else if (exc === 'BYBIT') {
            result = await fetchBybitFixing(sym, date);
        } else {
            return res.status(400).json({ success: false, error: 'Invalid exchange. Use BINANCE or BYBIT' });
        }

        if (result.price === null) {
            return res.status(404).json({
                success: false,
                error: `No price found for ${exc} ${sym} on ${date}`,
                triedSources: result.tried
            });
        }
        return res.status(200).json({
            success: true,
            exchange: exc, symbol: sym, date,
            price: result.price.toFixed(2),
            source: result.source,
        });

    } catch (err) {
        console.error('Price proxy error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ─── BINANCE FIXING ───────────────────────────────────────────────────────────
// Tries multiple Binance endpoints in order of price accuracy.
// All use the OPEN price of the 08:00 UTC hourly candle.
async function fetchBinanceFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const tried  = [];

    // Source 1: Binance Price Index kline — exact match to UI and termsheet
    // pair= format, not symbol=
    const indexUrl = `https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=${symbol}&contractType=PERPETUAL&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(indexUrl, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) {
                const best = findClosest(d, target);
                if (best) return { price: parseFloat(best[1]), source: 'binance-price-index' };
            }
        }
        tried.push(`index: ${r.status}`);
    } catch(e) { tried.push(`index: ${e.message}`); }

    // Source 2: Binance futures perpetual kline — same exchange as index, very close price
    const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(futuresUrl, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) {
                const best = findClosest(d, target);
                if (best) return { price: parseFloat(best[1]), source: 'binance-futures' };
            }
        }
        tried.push(`futures: ${r.status}`);
    } catch(e) { tried.push(`futures: ${e.message}`); }

    // Source 3: Binance spot kline — tracks index within ~0.01%
    const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(spotUrl, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) {
                const best = findClosest(d, target);
                if (best) return { price: parseFloat(best[1]), source: 'binance-spot' };
            }
        }
        tried.push(`spot: ${r.status}`);
    } catch(e) { tried.push(`spot: ${e.message}`); }

    // Source 4: Binance US — different exchange, slight price deviation
    const usUrl = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(usUrl, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 0) {
                const best = findClosest(d, target);
                if (best) return { price: parseFloat(best[1]), source: 'binance-us' };
            }
        }
        tried.push(`binance-us: ${r.status}`);
    } catch(e) { tried.push(`binance-us: ${e.message}`); }

    return { price: null, source: null, tried };
}

// ─── BYBIT FIXING ─────────────────────────────────────────────────────────────
async function fetchBybitFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=60&start=${start}&end=${end}&limit=5`;
    try {
        const r = await fetch(url);
        const d = await r.json();
        const list = d?.result?.list;
        if (list?.length) {
            const best = findClosest(list, target);
            if (best) return { price: parseFloat(best[1]), source: 'bybit-kline' };
        }
    } catch(e) {}
    return { price: null, source: null, tried: ['bybit failed'] };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function findClosest(candles, target) {
    let best = null, bestDiff = Infinity;
    for (const c of candles) {
        const diff = Math.abs(parseInt(c[0]) - target);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    return bestDiff <= 1800000 ? best : null;
}
