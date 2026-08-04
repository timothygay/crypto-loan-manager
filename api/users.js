// /api/users — admin-only user management. All actions require an admin session.
const { sql, getUserByEmail, audit } = require('../lib/db');
const { sessionUser } = require('../lib/guard');
const crypto = require('crypto');

const ROLES = ['readonly', 'readwrite', 'admin'];

module.exports = async (req, res) => {
    const me = await sessionUser(req);
    if (!me) return res.status(401).json({ error: 'Not signed in.' });
    if (me.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

    if (req.method === 'GET') {
        const users = await sql`
            SELECT id, email, role, is_active, must_reset,
                   (totp_secret IS NOT NULL) AS has_2fa, last_login_at, created_at
            FROM users ORDER BY created_at`;
        return res.status(200).json({ users, me: { id: me.id, email: me.email, role: me.role } });
    }

    if (req.method === 'POST') {
        const b = req.body || {};
        const action = b.action;

        if (action === 'create') {
            const email = String(b.email || '').trim().toLowerCase();
            const role = ROLES.includes(b.role) ? b.role : 'readonly';
            if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
                return res.status(400).json({ error: 'A valid email is required.' });
            }
            if (await getUserByEmail(email)) return res.status(409).json({ error: 'A user with that email already exists.' });
            const token = crypto.randomBytes(24).toString('hex');
            await sql`
                INSERT INTO users (email, role, is_active, must_reset, setup_token, created_by)
                VALUES (${email}, ${role}, true, true, ${token}, ${me.id})`;
            await audit(me.id, me.email, 'user_add', { email, role }, ip);
            return res.status(200).json({ ok: true, email, role, setupToken: token });
        }

        if (action === 'setRole') {
            if (!b.id || !ROLES.includes(b.role)) return res.status(400).json({ error: 'id and a valid role are required.' });
            if (b.id === me.id) return res.status(400).json({ error: 'You cannot change your own role.' });
            await sql`UPDATE users SET role = ${b.role} WHERE id = ${b.id}`;
            await audit(me.id, me.email, 'role_change', { id: b.id, role: b.role }, ip);
            return res.status(200).json({ ok: true });
        }

        if (action === 'setActive') {
            if (!b.id || typeof b.active !== 'boolean') return res.status(400).json({ error: 'id and active flag are required.' });
            if (b.id === me.id) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
            await sql`UPDATE users SET is_active = ${b.active} WHERE id = ${b.id}`;
            await audit(me.id, me.email, b.active ? 'user_activate' : 'user_deactivate', { id: b.id }, ip);
            return res.status(200).json({ ok: true });
        }

        if (action === 'resetSetup') {
            // Re-issue a one-time setup token (e.g. user lost their authenticator); forces fresh enrollment.
            if (!b.id) return res.status(400).json({ error: 'id is required.' });
            const token = crypto.randomBytes(24).toString('hex');
            await sql`
                UPDATE users
                SET setup_token = ${token}, must_reset = true, password_hash = null, totp_secret = null
                WHERE id = ${b.id}`;
            await audit(me.id, me.email, 'user_reset', { id: b.id }, ip);
            return res.status(200).json({ ok: true, setupToken: token });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
