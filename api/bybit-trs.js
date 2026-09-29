// api/bybit-trs.js — Vercel serverless proxy for Bybit SMA01 subaccount
// Uses master API key + /v5/asset/asset-overview?memberId=555127100
// Same signing logic as bybit_subaccount_nav.py (confirmed working)
const crypto = require('crypto');

const BYBIT_BASE  = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const SMA01_UID   = '555127100';
// Sub-accounts to report. One master API key reads each by memberId — no extra keys.
const SUBACCOUNTS = [
    { name: 'SMA01',             uid: '555127100' },
    { name: 'SMA01_BTC',         uid: '586292192' },
    { name: 'SMA01_ETH',         uid: '586292350' },
    { name: 'SMA01_ADA',         uid: '588395771' },
    // SMA_Speqtra_L2* are "Under Review" on Bybit (0 USD); they return empty/error until
    // Bybit finishes linking them, then populate automatically. Each account is fetched
    // independently (Promise.allSettled) so a not-yet-linked one never breaks the others.
    { name: 'SMA_Speqtra_L2',     uid: '590542903' },
    { name: 'SMA_Speqtra_L2_BTC', uid: '590542967' },
    { name: 'SMA_Speqtra_L2_ETH', uid: '590543157' },
    { name: 'SMA_Speqtra_L2_ADA', uid: '590543281' },
];

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function getServerTime() {
    const res  = await fetch(`${BYBIT_BASE}/v5/market/time`);
    const json = await res.json();
    return parseInt(json.result.timeNano) / 1_000_000; // ms
}

async function bybitGet(path, paramStr, apiKey, apiSecret, clockOffset) {
    const timestamp = String(Math.round(Date.now() + clockOffset));
    const sigInput  = timestamp + apiKey + RECV_WINDOW + paramStr;
    const signature = crypto.createHmac('sha256', apiSecret).update(sigInput).digest('hex');
    const url       = `${BYBIT_BASE}${path}${paramStr ? '?' + paramStr : ''}`;

    const res  = await fetch(url, {
        headers: {
            'X-BAPI-API-KEY':     apiKey,
            'X-BAPI-TIMESTAMP':   timestamp,
            'X-BAPI-RECV-WINDOW': RECV_WINDOW,
            'X-BAPI-SIGN':        signature,
        }
    });
    const text = await res.text();
    if (!text) throw new Error(`Empty response from Bybit (HTTP ${res.status})`);
    const json = JSON.parse(text);
    if (json.retCode !== 0) throw new Error(`Bybit ${json.retCode}: ${json.retMsg}`);
    return json.result;
}

// Turn an /v5/asset/asset-overview result into { totalNav, assets:[{coin,walletBalance}] }.
// Per-coin detail is nested at list[].categories[].coinDetail[] ({coin, equity}); equity is
// the coin quantity (incl. any position PnL carried in that coin).
function parseOverview(result) {
    const totalNav = parseFloat(result.totalEquity || 0);
    const coinMap = {};
    for (const acct of (result.list || [])) {
        const details = [
            ...((acct.categories || []).flatMap(c => c.coinDetail || [])),
            ...(acct.coinDetail || []),   // fallback if a future account type is flat
        ];
        for (const cd of details) {
            const q = parseFloat(cd.equity || cd.walletBalance || 0);
            if (!(Math.abs(q) > 1e-9)) continue;
            coinMap[cd.coin] = (coinMap[cd.coin] || 0) + q;
        }
    }
    const assets = Object.entries(coinMap)
        .map(([coin, walletBalance]) => ({ coin, walletBalance }))
        .filter(a => Math.abs(a.walletBalance) > 1e-9)
        .sort((a, b) => Math.abs(b.walletBalance) - Math.abs(a.walletBalance));
    return { totalNav, assets };
}

// ── READ-ONLY PROBE: subaccount fund movements ────────────────────────────────
// Diagnostic for the TRS "fund movements" feature. Confirms the master key can read
// Bybit's transfer/deposit history and shows the shape of the data before we build a
// persistent capture. Read-only — no transfers are ever initiated here.
//   • Universal transfers (master↔sub, sub↔sub) — the real in/out ledger. 7-day window.
//   • Sub-member on-chain deposits — external top-ups straight into a sub. 30-day window.
// Each call is wrapped so a missing key-permission surfaces as an error string (likely a
// permission that must be enabled on the key) instead of failing the whole probe.
async function probeMovements(apiKey, apiSecret, clockOffset, weeks) {
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const lookbackWeeks = Math.min(Math.max(parseInt(weeks, 10) || 12, 1), 26); // 1..26 weeks
    const out = { lookbackWeeks, apiKeyInfo: null, subMembers: [], strategyUids: SUBACCOUNTS.map(s => ({ name: s.name, uid: s.uid })),
                  universalTransfers: [], subDeposits: {}, errors: {} };

    // Name resolution: our reserved strategy subs first, then any username Bybit returns,
    // then flag the master; anything else stays as its raw UID.
    const uidToName = Object.fromEntries(SUBACCOUNTS.map(s => [String(s.uid), s.name]));
    const subUids = new Set(SUBACCOUNTS.map(s => String(s.uid)));
    let masterUid = null;

    // 0a) Who is this key? (uid, master/sub, permissions) — confirms access level.
    try {
        const info = await bybitGet('/v5/user/query-api', '', apiKey, apiSecret, clockOffset);
        masterUid = String(info.userID || '');
        out.apiKeyInfo = { userID: info.userID, isMaster: info.isMaster, parentUid: info.parentUid,
                           readOnly: info.readOnly, permissions: info.permissions };
    } catch (e) { out.errors.apiKeyInfo = e.message; }

    // 0b) All sub accounts under the master → resolve the mystery UIDs to real usernames.
    try {
        const subs = await bybitGet('/v5/user/query-sub-members', '', apiKey, apiSecret, clockOffset);
        const members = subs.subMembers || [];
        out.subMembers = members.map(m => ({ uid: m.uid, username: m.username, memberType: m.memberType, status: m.status, remark: m.remark }));
        members.forEach(m => { if (!uidToName[String(m.uid)]) uidToName[String(m.uid)] = m.username || ('sub(' + m.uid + ')'); });
    } catch (e) { out.errors.subMembers = e.message; }

    const label = (uid) => {
        const u = String(uid || '');
        if (uidToName[u]) return uidToName[u];
        if (u && u === masterUid) return 'MASTER(' + u + ')';
        return u ? 'other(' + u + ')' : '—';
    };

    // 1) Universal transfers — page back week by week (Bybit caps each query at a 7-day window).
    const seen = new Set();
    let hitWindowCap = false;
    for (let w = 0; w < lookbackWeeks; w++) {
        const end = now - w * 7 * DAY;
        const start = end - 7 * DAY;
        try {
            const ps = `limit=50&startTime=${start}&endTime=${end}`;
            const r = await bybitGet('/v5/asset/transfer/query-universal-transfer-list', ps, apiKey, apiSecret, clockOffset);
            const list = r.list || r.rows || [];
            if (list.length >= 50) hitWindowCap = true; // more than one page in this week — flag it
            for (const t of list) {
                if (t.transferId && seen.has(t.transferId)) continue;
                if (t.transferId) seen.add(t.transferId);
                out.universalTransfers.push({
                    transferId: t.transferId, coin: t.coin, amount: t.amount, status: t.status,
                    when: t.timestamp ? new Date(parseInt(t.timestamp, 10)).toISOString() : null,
                    fromMemberId: t.fromMemberId, toMemberId: t.toMemberId,
                    from: label(t.fromMemberId), to: label(t.toMemberId),
                    fromAccountType: t.fromAccountType, toAccountType: t.toAccountType,
                    strategyRelated: subUids.has(String(t.fromMemberId)) || subUids.has(String(t.toMemberId)),
                });
            }
        } catch (e) { out.errors['transfers:week-' + w] = e.message; break; }
        await new Promise(r => setTimeout(r, 120));
    }
    out.universalTransfers.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    out.universalTransferCount = out.universalTransfers.length;
    out.strategyTransfers = out.universalTransfers.filter(t => t.strategyRelated);
    out.strategyTransferCount = out.strategyTransfers.length;
    out.someWeeksHadMoreThan50 = hitWindowCap; // if true, a busy week may have older rows we didn't page

    // 2) Sub-member on-chain deposits, per reserved sub (explicit 30-day window; one retry on 131001).
    const depStart = now - 30 * DAY;
    for (const s of SUBACCOUNTS) {
        const ps = `subMemberId=${s.uid}&startTime=${depStart}&endTime=${now}&limit=50`;
        let attempt = 0, done = false;
        while (attempt < 2 && !done) {
            attempt++;
            try {
                const r = await bybitGet('/v5/asset/deposit/query-sub-member-record', ps, apiKey, apiSecret, clockOffset);
                const rows = r.rows || r.list || [];
                out.subDeposits[s.name] = rows.map(d => ({
                    coin: d.coin, chain: d.chain, amount: d.amount, status: d.status,
                    txID: d.txID, when: d.successAt ? new Date(parseInt(d.successAt, 10)).toISOString() : null,
                    depositType: d.depositType,
                }));
                done = true;
            } catch (e) {
                if (attempt >= 2) out.errors['subDeposits:' + s.name] = e.message;
                else await new Promise(r => setTimeout(r, 400));
            }
        }
        await new Promise(r => setTimeout(r, 120));
    }

    return out;
}

const { sessionUser } = require('../lib/guard');
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    // Allow either the browser UI (valid login session) OR a server-side caller with the
    // shared secret (the TRS Apps Script NAV capture calls this from Google's servers).
    const okSession = await sessionUser(req);
    const okSecret = req.query.cpb_secret && req.query.cpb_secret === process.env.GAS_SHARED_SECRET;
    if (!okSession && !okSecret) return res.status(401).json({ error: 'Sign in required.' });

    const apiKey    = process.env.BYBIT_TRS_API_KEY;
    const apiSecret = process.env.BYBIT_TRS_API_SECRET;
    if (!apiKey || !apiSecret) {
        return res.status(500).json({ error: 'BYBIT_TRS_API_KEY or BYBIT_TRS_API_SECRET not set in Vercel env vars.' });
    }

    try {
        // Sync clock with Bybit server (same as Python script)
        const serverMs    = await getServerTime();
        const clockOffset = serverMs - Date.now();

        // Read-only diagnostic: ?probe=movements → transfer/deposit history for the strategy subs.
        if (req.query.probe === 'movements') {
            const probe = await probeMovements(apiKey, apiSecret, clockOffset, req.query.weeks);
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ probe: 'movements', fetchedAt: new Date().toISOString(), ...probe });
        }

        // Fetch every configured sub-account independently (one master key reads all by memberId).
        // asset-overview's totalEquity is each account's true NAV (includes position MTM); the
        // per-coin breakdown is valued in the UI with live Bybit prices, NAV−Σspot = "Open Positions (MTM)".
        const settled = await Promise.allSettled(
            SUBACCOUNTS.map(s => bybitGet('/v5/asset/asset-overview', `memberId=${s.uid}`, apiKey, apiSecret, clockOffset))
        );
        const accounts = SUBACCOUNTS.map((s, i) => {
            const r = settled[i];
            if (r.status !== 'fulfilled') return { name: s.name, uid: s.uid, error: (r.reason && r.reason.message) || 'fetch failed' };
            const { totalNav, assets } = parseOverview(r.value);
            return { name: s.name, uid: s.uid, totalNav, assets };
        });
        // Keep the legacy single-account fields (primary = SMA01) so the existing NAV header,
        // history and alerts keep working unchanged.
        const primary = accounts.find(a => a.uid === SMA01_UID) || accounts[0] || {};

        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json({
            totalNav:   primary.totalNav || 0,
            assets:     primary.assets || [],
            accounts,
            subaccount: 'SMA01',
            fetchedAt:  new Date().toISOString(),
        });

    } catch(err) {
        console.error('bybit-trs error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
