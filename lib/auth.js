// lib/auth.js — password, TOTP, session-token, and cookie helpers
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');

const COOKIE = 'cpb_session';
const SESSION_HOURS = 12;

// jose is ESM-only; load it lazily inside CommonJS
async function jose() { return await import('jose'); }

// ── passwords ──────────────────────────────────────────────────────────────
async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

// ── TOTP (Google Authenticator) ─────────────────────────────────────────────
function generateTotpSecret() { return authenticator.generateSecret(); } // base32
function totpKeyUri(email, secret) { return authenticator.keyuri(email, 'CPB Dashboard', secret); }
function verifyTotp(token, secret) {
    try { return authenticator.verify({ token: String(token).replace(/\s/g, ''), secret }); }
    catch (e) { return false; }
}

// ── TOTP secret encryption at rest (AES-256-GCM, key = TOTP_ENC_KEY hex) ─────
function encKey() { return Buffer.from(process.env.TOTP_ENC_KEY || '', 'hex'); }
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptSecret(b64) {
    const raw = Buffer.from(b64, 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ── session JWT ──────────────────────────────────────────────────────────────
async function signSession({ sub, email, role }) {
    const { SignJWT } = await jose();
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    return await new SignJWT({ email, role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_HOURS}h`)
        .sign(secret);
}
async function verifySession(token) {
    const { jwtVerify } = await jose();
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return payload; // { sub, email, role, iat, exp }
}

// ── cookies ──────────────────────────────────────────────────────────────────
function sessionCookie(token) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;
}
function clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function readCookie(req, name) {
    const h = req.headers.cookie || '';
    const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}

module.exports = {
    COOKIE, hashPassword, verifyPassword,
    generateTotpSecret, totpKeyUri, verifyTotp, encryptSecret, decryptSecret,
    signSession, verifySession, sessionCookie, clearCookie, readCookie,
};
