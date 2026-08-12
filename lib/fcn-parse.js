// lib/fcn-parse.js — parse a Market Flow "Highlight Transaction" row into
// structured fields + Yahoo tickers, for the term-sheet generator.
//
// Sheet row columns (from the goldhorse scrape):
//   [ Type, Underlyings, Strike, Coupon p.a., Tenor, Structure ]
// e.g. ["FCN", "MU, SNDK", "45%", "12.00%", "6m", "KO 120% Daily Memory, NONE-KI"]
//
// Pure, dependency-free; runs identically in Node (tests) and the browser (UI).

function pctToNum(s) {
    const m = String(s == null ? '' : s).match(/-?[\d.]+/);
    return m ? parseFloat(m[0]) : null;
}

// Map an underlying label to a Yahoo Finance symbol.
//  "7709 HK" -> "7709.HK" · "005930 KS" -> "005930.KS" · "AAOI"/"NET" -> pass-through (US)
function toYahooTicker(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return '';
    const SUF = { HK: 'HK', KS: 'KS', T: 'T', TW: 'TW', L: 'L', SI: 'SI', AX: 'AX', SS: 'SS', SZ: 'SZ', TO: 'TO' };
    const ex = s.match(/^(\S+)\s+([A-Za-z]{1,2})$/); // "<code> <EXCH>"
    if (ex && SUF[ex[2].toUpperCase()]) return ex[1] + '.' + SUF[ex[2].toUpperCase()];
    return s.toUpperCase();
}

function parseUnderlyings(str) {
    return String(str == null ? '' : str)
        .split(',').map((s) => s.trim()).filter(Boolean)
        .map((u) => ({ raw: u, ticker: toYahooTicker(u) }));
}

function parseTenorMonths(str) {
    const m = String(str == null ? '' : str).match(/(\d+)\s*m/i);
    return m ? parseInt(m[1], 10) : null;
}

// Parse the free-text Structure column.
//  "KO 120% Daily Memory, NONE-KI"     -> {koLevel:120, koFreq:'Daily', memory:true,  kiType:'NONE'}
//  "KO 88% Daily, NONE-KI"             -> {koLevel:88,  koFreq:'Daily', memory:false, kiType:'NONE'}
//  "KO 100% Period End, NONE-KI"       -> {koLevel:100, koFreq:'Period End', ...}
//  "KO 100% Daily, EKI, 50% KI Barrier"-> {koLevel:100, koFreq:'Daily', kiType:'EKI', kiBarrier:50}
function parseStructure(str) {
    const t = String(str == null ? '' : str);
    const out = { raw: t, koLevel: null, koFreq: null, memory: false, kiType: null, kiBarrier: null };
    const ko = t.match(/KO\s*([\d.]+)\s*%\s*(Daily Memory|Period[\s-]?End|Daily)?/i);
    if (ko) {
        out.koLevel = parseFloat(ko[1]);
        const f = (ko[2] || '').trim();
        out.memory = /memory/i.test(f);
        out.koFreq = /period/i.test(f) ? 'Period End' : /daily/i.test(f) ? 'Daily' : (f || null);
    }
    if (/NONE[\s-]?KI/i.test(t)) {
        out.kiType = 'NONE';
    } else {
        const ki = t.match(/\b(EKI|AKI|KI)\b/i);
        if (ki) out.kiType = ki[1].toUpperCase();
        const kb = t.match(/([\d.]+)\s*%\s*KI\s*Barrier/i);
        if (kb) out.kiBarrier = parseFloat(kb[1]);
    }
    return out;
}

// Combine a full row into one structured object (+ derived breakeven).
function parseHighlightRow(row) {
    const [type, unds, strike, coupon, tenor, structure] = row;
    const strikePct = pctToNum(strike);
    const couponPaPct = pctToNum(coupon);
    const tenorMonths = parseTenorMonths(tenor);
    const totalCouponPct = (couponPaPct != null && tenorMonths != null) ? couponPaPct * tenorMonths / 12 : null;
    const breakevenPct = (strikePct != null && totalCouponPct != null) ? +(strikePct * (1 - totalCouponPct / 100)).toFixed(2) : null;
    return {
        type: type || null,
        underlyings: parseUnderlyings(unds),
        strikePct, couponPaPct, tenorMonths, totalCouponPct, breakevenPct,
        structure: parseStructure(structure),
    };
}

module.exports = { pctToNum, toYahooTicker, parseUnderlyings, parseTenorMonths, parseStructure, parseHighlightRow };
