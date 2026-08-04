// /api/sheet/[product] — authenticated, role-checked proxy to a product's GAS web app.
//   - requires a valid session (any role) for reads
//   - requires readwrite/admin for writes (readonly is blocked at the proxy)
//   - forwards to the product's GAS /exec URL (from env) with the shared secret
// The browser never sees the GAS URL or the secret.
const { sessionUser } = require('../../lib/guard');
const { audit } = require('../../lib/db');

const URL_ENV = {
    loans: 'LOANS_GAS_URL',
    ssps:  'SSPS_GAS_URL',
    fcn:   'FCN_GAS_URL',
    acc:   'ACC_GAS_URL',
    trs:   'TRS_GAS_URL',
    dci:   'DCI_GAS_URL',
};

// Known READ actions per the .gs backends. Anything not listed is treated as a
// WRITE (default-deny), so an unknown action can never let a read-only user write.
const READ_ACTIONS = new Set([
    'read', 'list', 'ping', 'get', 'getprice', 'getprices',
    'getdaterange', 'gettodayprices', 'readsheet',
    // SSPS
    'readcontracts', 'readprices',
    // FCN
    'readfcnorders', 'readpriceladder',
    // Accumulator
    'readaccorders', 'readaccpriceladder',
]);

module.exports = async (req, res) => {
    const me = await sessionUser(req);
    if (!me) return res.status(401).json({ error: 'Not signed in.' });

    const product = String(req.query.product || '').toLowerCase();
    const gasUrl = URL_ENV[product] && process.env[URL_ENV[product]];
    if (!gasUrl) return res.status(400).json({ error: 'Unknown or unconfigured product.' });

    const action = String(req.query.action || (req.body && req.body.action) || '').trim().toLowerCase();
    const isWrite = !READ_ACTIONS.has(action);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

    if (isWrite && me.role === 'readonly') {
        await audit(me.id, me.email, 'write_blocked', { product, action }, ip);
        return res.status(403).json({ error: 'Read-only access — you cannot add or edit trades.' });
    }

    // Forward to GAS with the shared secret (GAS ignores it until the lockdown is enforced).
    const secret = process.env.GAS_SHARED_SECRET || '';
    const qs = new URLSearchParams(req.query);
    qs.delete('product');
    if (secret) qs.set('cpb_secret', secret);
    const target = gasUrl + '?' + qs.toString();

    const opts = { method: req.method, redirect: 'follow' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(req.body || {});
    }

    // Apps Script /exec endpoints intermittently return a transient HTML error page
    // instead of JSON. Retry READS a few times (writes are NEVER retried — that could
    // duplicate a trade). If it's still not JSON after retries, return a clean JSON
    // error so the browser never chokes on "Unexpected token '<'".
    const maxTries = isWrite ? 1 : 3;
    let text = '', upstreamStatus = 502, ctype = 'application/json';
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            const gasRes = await fetch(target, opts);
            upstreamStatus = gasRes.status;
            ctype = gasRes.headers.get('content-type') || 'application/json';
            text = await gasRes.text();
        } catch (e) {
            text = ''; upstreamStatus = 502;
        }
        const looksHtml = text.trim().charAt(0) === '<';
        if (upstreamStatus >= 200 && upstreamStatus < 300 && text && !looksHtml) break;
        if (attempt < maxTries) await new Promise(r => setTimeout(r, 300 * attempt));
    }

    if (!text || text.trim().charAt(0) === '<') {
        return res.status(502).json({ success: false, error: 'Data service (Apps Script) returned a non-JSON response after retries — please try again in a moment.' });
    }
    res.status(upstreamStatus);
    res.setHeader('Content-Type', ctype);
    if (isWrite) await audit(me.id, me.email, 'trade_write', { product, action }, ip);
    return res.send(text);
};
