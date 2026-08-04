// GET /api/auth/session  -> { authenticated, email?, role? }
const auth = require('../../lib/auth');
const { getUserByEmail } = require('../../lib/db');

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = auth.readCookie(req, auth.COOKIE);
    if (!token) return res.status(200).json({ authenticated: false });
    try {
        const payload = await auth.verifySession(token);
        // Re-check the user is still active (immediate revocation when an admin removes them)
        const user = await getUserByEmail(payload.email);
        if (!user || !user.is_active) return res.status(200).json({ authenticated: false });
        return res.status(200).json({ authenticated: true, email: user.email, role: user.role });
    } catch (e) {
        return res.status(200).json({ authenticated: false });
    }
};
