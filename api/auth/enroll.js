// POST /api/auth/enroll  — first-time setup, gated by the per-user setup_token.
//   step 'begin'    { email, setupToken }                     -> { secret, qrDataUrl }
//   step 'complete' { email, setupToken, password, totp, secret } -> { ok }
const { getUserByEmail, sql, audit } = require('../../lib/db');
const auth = require('../../lib/auth');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const setupToken = body.setupToken || '';
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

    let user = null;
    try { user = await getUserByEmail(email); } catch (e) { return res.status(500).json({ error: 'Server error.' }); }

    // Only accounts awaiting setup, with a matching one-time token, may enroll.
    if (!user || !user.is_active || !user.must_reset || !user.setup_token) {
        return res.status(403).json({ error: 'Setup is not available for this account.' });
    }
    if (!setupToken || setupToken !== user.setup_token) {
        await audit(user.id, email, 'enroll_bad_token', null, ip);
        return res.status(403).json({ error: 'Invalid setup token.' });
    }

    if (body.step === 'begin') {
        const secret = auth.generateTotpSecret();
        const uri = auth.totpKeyUri(user.email, secret);
        const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
        return res.status(200).json({ ok: true, secret, qrDataUrl });
    }

    if (body.step === 'complete') {
        const password = body.password || '';
        const secret = body.secret || '';
        const totp = body.totp || '';
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        if (!secret || !auth.verifyTotp(totp, secret)) {
            return res.status(400).json({ error: 'Authenticator code is incorrect — re-scan and try again.' });
        }
        const pwHash = await auth.hashPassword(password);
        const encSecret = auth.encryptSecret(secret);
        await sql`
            UPDATE users
            SET password_hash = ${pwHash}, totp_secret = ${encSecret},
                must_reset = false, setup_token = null
            WHERE id = ${user.id}`;
        await audit(user.id, user.email, 'enroll_complete', null, ip);
        return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown setup step.' });
};
