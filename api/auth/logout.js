// POST /api/auth/logout  -> clears the session cookie
const auth = require('../../lib/auth');

module.exports = async (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookie());
    return res.status(200).json({ ok: true });
};
