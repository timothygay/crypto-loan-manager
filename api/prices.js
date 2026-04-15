// CPB PRICE PROXY — Vercel Serverless Function
// Route: /api/prices

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

        return res.status(200).json({
            success: result.price !== null,
            exchange: exc, symbol: sym, date,
            price: result.price !== null ? result.price.toFixed(2) : null,
            source: result.source,
            debug: result.debug || null,
        });

    } catch (err) {
        console.error('Price proxy error:', err);
        return res.status(500).json({ success: false, error: err.message, stack: err.stack });
    }
}

async function fetchBinanceFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const debug  = [];

    // Try 1: Binance futures Price Index kline
    const indexUrl = `https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=${symbol}&contractType=PERPETUAL&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(indexUrl);
        const text = await r.text();
        debug.push(`index status=${r.status} body=${text.substring(0,100)}`);
        const d = JSON.parse(text);
        if (Array.isArray(d) && d.length > 0) {
            const best = findClosest(d, target);
            if (best) return { price: parseFloat(best[1]), source: 'binance-index', debug };
        }
    } catch(e) { debug.push(`index error: ${e.message}`); }

    // Try 2: Binance spot kline
    const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(spotUrl);
        const text = await r.text();
        debug.push(`spot status=${r.status} body=${text.substring(0,100)}`);
        const d = JSON.parse(text);
        if (Array.isArray(d) && d.length > 0) {
            const best = findClosest(d, target);
            if (best) return { price: parseFloat(best[1]), source: 'binance-spot', debug };
        }
    } catch(e) { debug.push(`spot error: ${e.message}`); }

    // Try 3: Binance US (no geo-restriction)
    const usUrl = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${end}&limit=5`;
    try {
        const r = await fetch(usUrl);
        const text = await r.text();
        debug.push(`binance.us status=${r.status} body=${text.substring(0,100)}`);
        const d = JSON.parse(text);
        if (Array.isArray(d) && d.length > 0) {
            const best = findClosest(d, target);
            if (best) return { price: parseFloat(best[1]), source: 'binance-us', debug };
        }
    } catch(e) { debug.push(`binance.us error: ${e.message}`); }

    return { price: null, source: null, debug };
}

async function fetchBybitFixing(symbol, dateStr) {
    const target = new Date(`${dateStr}T08:00:00Z`).getTime();
    const start  = target - 2 * 3600000;
    const end    = target + 2 * 3600000;
    const debug  = [];
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=60&start=${start}&end=${end}&limit=5`;
    try {
        const r = await fetch(url);
        const text = await r.text();
        debug.push(`bybit status=${r.status} body=${text.substring(0,100)}`);
        const d = JSON.parse(text);
        const list = d?.result?.list;
        if (list?.length) {
            const best = findClosest(list, target);
            if (best) return { price: parseFloat(best[1]), source: 'bybit-kline', debug };
        }
    } catch(e) { debug.push(`bybit error: ${e.message}`); }
    return { price: null, source: null, debug };
}

function findClosest(candles, target) {
    let best = null, bestDiff = Infinity;
    for (const c of candles) {
        const diff = Math.abs(parseInt(c[0]) - target);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    return bestDiff <= 1800000 ? best : null;
}
