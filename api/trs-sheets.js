// api/trs-sheets.js — Vercel proxy for TRS Google Apps Script

const TRS_SCRIPT_URL = process.env.TRS_SCRIPT_URL;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Step 1: confirm function is running
    if (!TRS_SCRIPT_URL) {
        return res.status(500).json({
            error: 'TRS_SCRIPT_URL env var not set in Vercel. Go to Vercel → Project Settings → Environment Variables and add TRS_SCRIPT_URL.',
            action: req.query.action || 'none',
        });
    }

    const params = new URLSearchParams(req.query).toString();
    const url    = `${TRS_SCRIPT_URL}${params ? '?' + params : ''}`;

    try {
        const upstream = await fetch(url, {
            redirect: 'follow',
            headers: { 'Accept': 'application/json, */*' },
        });

        const text = await upstream.text();

        if (text.trimStart().startsWith('<')) {
            return res.status(502).json({
                error: 'Apps Script returned HTML — redeploy the Apps Script as a Web App (Execute as Me, Anyone).',
                scriptUrl: TRS_SCRIPT_URL,
                httpStatus: upstream.status,
                preview: text.slice(0, 100),
            });
        }

        try {
            return res.status(200).json(JSON.parse(text));
        } catch {
            return res.status(502).json({ error: 'Non-JSON response', raw: text.slice(0, 200) });
        }

    } catch (err) {
        return res.status(500).json({ error: 'Fetch failed: ' + err.message });
    }
};
