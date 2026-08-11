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

const MONITOR_URL = process.env.MONITOR_API_URL || "https://penguin-treasury-monitor.vercel.app";

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

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
