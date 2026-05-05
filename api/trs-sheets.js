// api/trs-sheets.js — Vercel proxy for TRS Google Apps Script
// Needed because script.google.com is not in the Vercel network allowlist.
// All TRS Sheets read/write calls from the browser go through here.

const TRS_SCRIPT_URL = process.env.TRS_SCRIPT_URL; // set in Vercel env vars

module.exports = async function handler(req, res) {
    // CORS — allow requests from the app itself
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    if (!TRS_SCRIPT_URL) {
        return res.status(500).json({ error: 'TRS_SCRIPT_URL not set in Vercel environment variables.' });
    }

    // Forward all query params directly to the Apps Script
    const params = new URLSearchParams(req.query).toString();
    const url    = `${TRS_SCRIPT_URL}${params ? '?' + params : ''}`;

    try {
        const upstream = await fetch(url, {
            redirect: 'follow',
            headers: { 'Content-Type': 'application/json' },
        });
        const text = await upstream.text();

        // Try to parse as JSON, fall back to text
        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch {
            return res.status(200).send(text);
        }
    } catch (err) {
        console.error('trs-sheets proxy error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
