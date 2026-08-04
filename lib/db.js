// lib/db.js — Neon Postgres access (serverless HTTP driver)
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function getUserByEmail(email) {
    const rows = await sql`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
    return rows[0] || null;
}

async function audit(userId, actorEmail, action, detail, ip) {
    try {
        const detailJson = detail ? JSON.stringify(detail) : null;
        await sql`
            INSERT INTO audit_log (user_id, actor_email, action, detail, ip)
            VALUES (${userId}, ${actorEmail}, ${action}, ${detailJson}::jsonb, ${ip})`;
    } catch (e) {
        // never let audit failure break the request
    }
}

module.exports = { sql, getUserByEmail, audit };
