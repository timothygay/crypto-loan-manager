// api/cron/dci-sync.js — daily DCI Active feed (fully external, monitor untouched)
// ─────────────────────────────────────────────────────────────────────────────
// Reads the treasury-monitor's Postgres READ-ONLY (client_order_snapshots), takes
// the latest `active` snapshot, keeps DCI (HYDI) orders that have NOT yet matured,
// maps them to the exact DCI-Active sheet columns, and appends them to the DCI
// Google Sheet via the DCI Apps Script (append + dedup by Txn Id|Ref No).
//
// Only ever WRITES to the DCI sheet. It reads the monitor with a read-only role
// and cannot modify the monitor in any way. DCI Expired is left to the DCI Apps
// Script's own processDCIExpiries trigger (Active→Expired).
//
// Add ?dry=1 to preview (reads + maps, posts NOTHING).
const { neon } = require('@neondatabase/serverless');

// Exact DCI Active column order (matches upload_dci.py SHEET_COLUMNS / the sheet).
const COLS = ["Txn Id","Ref No","Asset Type","Trade Type","Product","Prod Description","Option CCY","Option Type","Strike Price","Client Name","Wallet Name","Wallet Currency","Form Status","Order Status","Simulated Status","Value Date","Maturity Date","Terminated On","Payout Type","Notional Amount Ccy","Notional Amount","Lapsed Amount CCY","Lapsed Amount","Exercised Amount CCY","Exercised Amount","Other Charges CCY","Other Charges","Redemption By","Redemption Date","Fixing","Redemption Ccy","Redemption Amount","Inception P&L Ccy","Inception P&L","Inception Premium Ccy","Inception Premium","Inception Bid Amt Ccy","Inception Bid Amt","Underlying Futures","Underlying Futures Rate","Inception Bid IV","Inception Mark IV","Treasury Rate APY","Customer Rate APY","Spot Index","Created By","Created Date","Uploaded At"];

const s  = v => (v === null || v === undefined) ? '' : String(v);
const dt = v => s(v).slice(0, 16);                       // "YYYY-MM-DD HH:MM"
// Sindi datetimes are UTC ("2026-08-07 08:00:00"). matured => datetime < now.
const maturityMs = v => { const d = Date.parse(s(v).replace(' ', 'T') + 'Z'); return isNaN(d) ? Infinity : d; };

function mapRow(o, uploadedAt) {
    const opt = (o.product && o.product.option) || {};
    const pname = o.product && o.product.product_name;
    const otype = /CALL/i.test(opt.option_type) ? 'Call'
              : /PUT/i.test(opt.option_type) ? 'Put'
              : /-C$/.test(s(pname)) ? 'Call'
              : /-P$/.test(s(pname)) ? 'Put' : '';
    const m = {
        "Txn Id": s(o.transaction_id), "Ref No": s(o.reference_number), "Asset Type": s(o.txnFormType),
        "Trade Type": "Open Buy", "Product": s(opt.instrument_name || pname),
        "Prod Description": "", "Option CCY": "", "Option Type": otype, "Strike Price": s(opt.strike_price),
        "Client Name": s(o.client_name), "Wallet Name": "", "Wallet Currency": "",
        "Form Status": s(o.status), "Order Status": s(o.order_status), "Simulated Status": "",
        "Value Date": dt(o.value_datetime), "Maturity Date": dt(o.maturity_datetime), "Terminated On": "",
        "Payout Type": "ON_MATURITY", "Notional Amount Ccy": s(o.invest_ccy), "Notional Amount": s(o.invest_amount),
        "Lapsed Amount CCY": s(o.term_expired_amount_ccy), "Lapsed Amount": s(o.term_expired_amount),
        "Exercised Amount CCY": s(o.term_exercised_amount_ccy), "Exercised Amount": s(o.term_exercised_amount),
        "Other Charges CCY": "", "Other Charges": "", "Redemption By": "", "Redemption Date": s(o.redemption_datetime),
        "Fixing": "", "Redemption Ccy": s(o.redeem_amount_ccy), "Redemption Amount": s(o.redeem_amount),
        "Inception P&L Ccy": "", "Inception P&L": "", "Inception Premium Ccy": "", "Inception Premium": "",
        "Inception Bid Amt Ccy": s(opt.quote_currency), "Inception Bid Amt": "",
        "Underlying Futures": "", "Underlying Futures Rate": "",
        "Inception Bid IV": s(opt.bid_iv),      // REQUIRED non-empty — the UI hides rows with a blank Bid IV
        "Inception Mark IV": "", "Treasury Rate APY": "", "Customer Rate APY": s(o.term_apy), "Spot Index": "",
        "Created By": "ONLINE", "Created Date": dt(o.create_time), "Uploaded At": uploadedAt,
    };
    return COLS.map(c => m[c]);
}

async function alertFailure(text) {
    // Optional: set DCI_ALERT_BOT_TOKEN + DCI_ALERT_CHAT_ID to get a Telegram ping on failure.
    const token = process.env.DCI_ALERT_BOT_TOKEN, chat = process.env.DCI_ALERT_CHAT_ID;
    if (!token || !chat) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat, text: text }),
        });
    } catch (_) { /* alerting must never throw */ }
}

module.exports = async (req, res) => {
    // Only Vercel Cron (or someone with the secret) may trigger it. Re-runs are
    // idempotent (append+dedup), so this is defence-in-depth, not critical.
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const dbUrl  = process.env.MONITOR_DB_URL;
    const gasUrl = process.env.DCI_GAS_URL;
    if (!dbUrl || !gasUrl) {
        return res.status(500).json({ ok: false, error: 'MONITOR_DB_URL or DCI_GAS_URL not set' });
    }

    const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');

    try {
        const sql = neon(dbUrl);
        const snap = await sql`
            SELECT payload, captured_at FROM public.client_order_snapshots
            WHERE source = 'active' ORDER BY captured_at DESC LIMIT 1`;
        if (!snap.length) throw new Error('no active client_order_snapshots found in monitor DB');

        const payload = Array.isArray(snap[0].payload) ? snap[0].payload : [];
        const nowMs = Date.now();
        const active = payload.filter(o =>
            String(o.txnFormType || '').toUpperCase() === 'HYDI' &&
            maturityMs(o.maturity_datetime) >= nowMs);        // Active = not yet matured (as upload_dci.py)

        const uploadedAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' SGT';
        const rows = active.map(o => mapRow(o, uploadedAt));

        if (dry) {
            return res.status(200).json({ ok: true, dry: true, snapshotAt: snap[0].captured_at,
                activeRows: rows.length, sample: rows.slice(0, 3) });
        }

        const gasRes = await fetch(`${gasUrl}?action=appendDciActive`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ headers: COLS, values: rows }),
        });
        const bodyText = await gasRes.text();
        let out;
        try { out = JSON.parse(bodyText); }
        catch { throw new Error('DCI Apps Script returned non-JSON: ' + bodyText.slice(0, 200)); }
        if (!out.success) throw new Error('appendDciActive failed: ' + (out.error || 'unknown'));

        return res.status(200).json({ ok: true, snapshotAt: snap[0].captured_at,
            activeRows: rows.length, added: out.added, skipped: out.skipped });
    } catch (err) {
        console.error('[dci-sync]', err.message);
        await alertFailure(`⚠️ DCI sync failed: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
