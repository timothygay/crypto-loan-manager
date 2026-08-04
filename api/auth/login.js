// POST /api/auth/login  { email, password, totp }
const { getUserByEmail, sql, audit } = require('../../lib/db');
const auth = require('../../lib/auth');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const totp = body.totp || '';
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

    if (!email || !password || !totp) {
        return res.status(400).json({ error: 'Email, password and authenticator code are required.' });
    }

    let user = null;
    try { user = await getUserByEmail(email); }
    catch (e) { return res.status(500).json({ error: 'Server error. Try again.' }); }

    const deny = async (reason) => {
        await audit(user ? user.id : null, email, 'login_fail', { reason }, ip);
        return res.status(401).json({ error: 'Invalid credentials.' });
    };

    if (!user || !user.is_active) return deny('no_user_or_inactive');
    if (user.must_reset || !user.password_hash || !user.totp_secret) {
        return res.status(403).json({ error: 'Account setup is not complete. Use your first-time setup link.', needsSetup: true });
    }

    if (!(await auth.verifyPassword(password, user.password_hash))) return deny('bad_password');

    let secret;
    try { secret = auth.decryptSecret(user.totp_secret); }
    catch (e) { return deny('totp_decrypt'); }
    if (!auth.verifyTotp(totp, secret)) return deny('bad_totp');

    const token = await auth.signSession({ sub: user.id, email: user.email, role: user.role });
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    try { await sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`; } catch (e) {}
    await audit(user.id, user.email, 'login', null, ip);
    return res.status(200).json({ ok: true, email: user.email, role: user.role });
};
