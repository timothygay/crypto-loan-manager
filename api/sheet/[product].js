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

    try {
        const opts = { method: req.method, redirect: 'follow' };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(req.body || {});
        }
        const gasRes = await fetch(target, opts);
        const text = await gasRes.text();
        res.status(gasRes.status);
        res.setHeader('Content-Type', gasRes.headers.get('content-type') || 'application/json');
        if (isWrite) await audit(me.id, me.email, 'trade_write', { product, action }, ip);
        return res.send(text);
    } catch (e) {
        return res.status(502).json({ error: 'Upstream error: ' + e.message });
    }
};
