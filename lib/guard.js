// lib/guard.js — resolve the current user from the session cookie (server-side).
const auth = require('./auth');
const { getUserByEmail } = require('./db');

// Returns the live user row for a valid session, else null.
// Re-checks is_active so deactivated users lose access immediately.
async function sessionUser(req) {
    const token = auth.readCookie(req, auth.COOKIE);
    if (!token) return null;
    try {
        const payload = await auth.verifySession(token);
        const user = await getUserByEmail(payload.email);
        if (!user || !user.is_active) return null;
        return user;
    } catch (e) {
        return null;
    }
}

module.exports = { sessionUser };
