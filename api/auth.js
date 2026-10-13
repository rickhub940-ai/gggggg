// ═══════════════════════════════════════════════════════════
// Luasec Auth API — Platoboost + Ticket + Runtime Secret
// ═══════════════════════════════════════════════════════════
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyKey, createLink } = require('../lib/platoboost');
const { issueTicket, verifyTicket, hashHwid } = require('../lib/ticket');
const { xorCipher, b64encode, b64decode, inverse } = require('../lib/crypto');
const {
  revokeHwid, revokeUser, revokeIp, checkRevoked, stats,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;

// ─── Rate limit ─────────────────────────────────────────────
const rateLimit = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 15;

function checkRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW;
  }
  entry.count++;
  rateLimit.set(ip, entry);
  return entry.count <= RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit.entries()) {
    if (now > entry.reset) rateLimit.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

// ─── Main ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://x');
  const action = req.query?.action || url.searchParams.get('action');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.socket?.remoteAddress || '';

  try {
    switch (action) {
      case 'verify':         return await handleVerify(req, res, ip);
      case 'script':         return await handleScript(req, res, ip);
      case 'script-verify':  return await handleScriptVerify(req, res);
      case 'heartbeat':      return await handleHeartbeat(req, res, ip);
      case 'start':          return await handleStart(req, res);
      case 'admin-ban':      return await handleAdminBan(req, res);
      case 'list':           return await handleList(req, res);
      default:
        return res.status(404).json({ error: 'Unknown action' });
    }
  } catch (err) {
    console.error('[auth]', action, err.message);
    return res.status(502).json({ error: 'Service unavailable' });
  }
};

// ─── Codec ──────────────────────────────────────────────────
function decodePayload(body, xorKey) {
  try {
    const { Data } = body || {};
    if (!Array.isArray(Data)) return { ok: false };
    const raw = Buffer.from(Data).toString('utf8');
    if (raw.length < xorKey.length + 4) return { ok: false };
    if (raw.slice(0, xorKey.length) !== xorKey) return { ok: false };
    const b64 = raw.slice(xorKey.length);
    const decrypted = xorCipher(b64decode(b64), xorKey).toString('utf8');
    return { ok: true, data: JSON.parse(decrypted) };
  } catch { return { ok: false }; }
}

function encodePayload(data, xorKey) {
  const encrypted = xorCipher(Buffer.from(JSON.stringify(data), 'utf8'), xorKey);
  const full = xorKey + b64encode(encrypted);
  const bytes = [];
  for (let i = 0; i < full.length; i++) bytes.push(full.charCodeAt(i));
  return { Data: bytes };
}

// ═══════════════════════════════════════════════════════════
// POST /api/verify — ตรวจ key กับ Platoboost → ออก ticket
// ═══════════════════════════════════════════════════════════
async function handleVerify(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { key, hwid, userId, scriptName } = req.body || {};

  if (typeof key !== 'string' || key.length < 8 || key.length > 256)
    return res.status(400).json({ valid: false, error: 'invalid key format' });

  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ valid: false, error: 'invalid hwid format' });

  if (typeof scriptName !== 'string' || scriptName.length < 1 || scriptName.length > 64)
    return res.status(400).json({ valid: false, error: 'scriptName required' });

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scriptName))
    return res.status(400).json({ valid: false, error: 'invalid scriptName format' });

  if (!checkRateLimit(ip))
    return res.status(429).json({ valid: false, message: 'Rate limited' });

  const reason = checkRevoked({ hwid, userId, ip });
  if (reason)
    return res.status(403).json({ valid: false, message: 'Banned: ' + reason });

  // ═══ ตรวจ key กับ Platoboost ═══
  const result = await verifyKey(key, hwid);
  if (!result.valid) {
    return res.status(result.rateLimited ? 429 : 200).json({
      valid: false,
      message: result.message || 'Invalid key',
    });
  }

  const ticket = issueTicket({
    hwidHash: hashHwid(hwid),
    scope: 'script',
    userId: userId || null,
    scriptName,
  });

  return res.status(200).json({ valid: true, ticket, k: xorKey });
}

// ═══════════════════════════════════════════════════════════
// POST /api/script
// ═══════════════════════════════════════════════════════════
async function handleScript(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { ticket, Data, scriptName } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ Valid: false, reason: 'ticket required' });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ Valid: false, reason: 'invalid ticket' });
  if (payload.scope !== 'script')
    return res.status(403).json({ Valid: false, reason: 'scope' });

  const reason = checkRevoked({ userId: payload.userId, ip });
  if (reason)
    return res.status(403).json({ Valid: false, reason: 'Banned: ' + reason });

  const name = (typeof scriptName === 'string' && scriptName.length > 0)
    ? scriptName
    : payload.scriptName;

  if (!name)
    return res.status(400).json({ Valid: false, reason: 'no scriptName' });

  if (name !== payload.scriptName) {
    return res.status(403).json({
      Valid: false,
      reason: 'scriptName mismatch with ticket',
    });
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return res.status(200).json(encodePayload(
      { Valid: false, reason: 'Invalid script name' }, xorKey
    ));
  }

  let clientData = null;
  if (Data) {
    const decoded = decodePayload({ Data }, xorKey);
    if (decoded.ok) clientData = decoded.data;
  }

  const scriptToken = crypto.randomBytes(24).toString('hex');
  const runtimeSecret = crypto.randomBytes(32).toString('hex');

  sessions.set(payload.jti, {
    createdAt: Date.now(),
    scriptIssuedAt: Date.now(),
    lastBeat: Date.now(),
    failCount: 0,
    hwidHash: payload.hwidHash,
    userId: payload.userId || null,
    scriptToken,
    runtimeSecret,
    scriptName: name,
    verified: false,
  });

  let scriptBody;
  try {
    const p = path.join(process.cwd(), 'scripts', name + '.lua');
    scriptBody = fs.readFileSync(p, 'utf8');
  } catch {
    return res.status(200).json(encodePayload(
      { Valid: false, reason: 'Script not found: ' + name }, xorKey
    ));
  }

  scriptBody = scriptBody
    .replace(/\$\{SERVERID\}/g, payload.jti)
    .replace(/\$\{SCRIPTID\}/g, name)
    .replace(/\$\{HWIDHASH\}/g, payload.hwidHash)
    .replace(/\$\{ISSUED\}/g, new Date().toISOString());

  let check = '0|0|0|0|0';
  if (clientData && typeof clientData.Rng1 === 'number') {
    check = [
      Math.floor(inverse(clientData.Rng1)),
      Math.floor(inverse(clientData.Rng2)),
      Math.floor(inverse(clientData.Rng3)),
      Math.floor(inverse(clientData.Rng4)),
      Math.floor(inverse(clientData.Rng5)),
    ].join('|');
  }

  return res.status(200).json(encodePayload({
    Valid: true,
    check,
    Body: scriptBody,
    ServerId: payload.jti,
    ScriptId: name,
    ScriptToken: scriptToken,
    RuntimeSecret: runtimeSecret,
  }, xorKey));
}

// ═══════════════════════════════════════════════════════════
// POST /api/script-verify — main.lua เรียก
// ═══════════════════════════════════════════════════════════
async function handleScriptVerify(req, res) {
  const { ticket, hwid, scriptToken, runtimeSecret, scriptName } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ valid: false, reason: 'no ticket' });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ valid: false, reason: 'invalid ticket' });

  const session = sessions.get(payload.jti);
  if (!session) return res.status(403).json({ valid: false, reason: 'session not found' });

  const reason = checkRevoked({ userId: payload.userId });
  if (reason)
    return res.status(403).json({ valid: false, reason: 'Banned: ' + reason });

  if (typeof scriptName === 'string' && scriptName !== session.scriptName) {
    return res.status(403).json({ valid: false, reason: 'scriptName changed' });
  }

  if (typeof runtimeSecret !== 'string' || runtimeSecret.length !== 64)
    return res.status(403).json({ valid: false, reason: 'no runtime secret' });

  const expectedBuf = Buffer.from(session.runtimeSecret, 'hex');
  const givenBuf = Buffer.from(runtimeSecret, 'hex');
  if (expectedBuf.length !== givenBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, givenBuf))
    return res.status(403).json({ valid: false, reason: 'secret mismatch' });

  if (typeof scriptToken !== 'string' || scriptToken.length > 128 ||
      scriptToken !== session.scriptToken)
    return res.status(403).json({ valid: false, reason: 'token mismatch' });

  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512 ||
      session.hwidHash !== hashHwid(hwid))
    return res.status(403).json({ valid: false, reason: 'hwid mismatch' });

  if (Date.now() - session.createdAt > SESSION_TTL)
    return res.status(403).json({ valid: false, reason: 'session expired' });

  if (Date.now() - session.scriptIssuedAt > RUNTIME_TTL)
    return res.status(403).json({ valid: false, reason: 'runtime expired' });

  if (session.verified)
    return res.status(403).json({ valid: false, reason: 'already verified' });

  session.verified = true;
  session.verifiedAt = Date.now();

  return res.status(200).json({ valid: true, serverId: payload.jti });
}

// ═══════════════════════════════════════════════════════════
// POST /api/heartbeat
// ═══════════════════════════════════════════════════════════
async function handleHeartbeat(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { ticket, Data } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ kick: null });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ kick: 'Session expired' });

  const reason = checkRevoked({ userId: payload.userId, ip });
  if (reason) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Banned: ' + reason });
  }

  const session = sessions.get(payload.jti);
  if (!session)
    return res.status(200).json(encodePayload({ Valid: true, commands: [] }, xorKey));

  session.lastBeat = Date.now();

  if (Data) {
    const decoded = decodePayload({ Data }, xorKey);
    if (!decoded.ok) {
      session.failCount += 1;
    } else {
      session.failCount = 0;

      const sentName = decoded.data?.scriptName;
      if (typeof sentName !== 'string' || sentName !== session.scriptName) {
        sessions.delete(payload.jti);
        return res.status(200).json({ kick: 'Script name changed' });
      }
    }
  }

  if (session.failCount > 12) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Tamper detected' });
  }

  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Session expired' });
  }

  return res.status(200).json(encodePayload({
    Valid: true, commands: [], t: Date.now(),
  }, xorKey));
}

// ═══════════════════════════════════════════════════════════
// POST /api/start — สร้างลิงก์ซื้อ key
// ═══════════════════════════════════════════════════════════
async function handleStart(req, res) {
  const { hwid } = req.body || {};
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ error: 'invalid hwid' });

  try {
    const result = await createLink(hwid);
    return res.status(result.rateLimited ? 429 : 200).json(result);
  } catch (err) {
    console.error('[start]', err.message);
    return res.status(502).json({ error: 'Could not create link' });
  }
}

// ═══════════════════════════════════════════════════════════
// POST /api/list
// ═══════════════════════════════════════════════════════════
async function handleList(req, res) {
  try {
    const dir = path.join(process.cwd(), 'scripts');
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.lua'))
      .map(f => f.replace('.lua', ''));
    return res.status(200).json({ scripts: files });
  } catch {
    return res.status(200).json({ scripts: [] });
  }
}

// ═══════════════════════════════════════════════════════════
// POST /api/admin/ban
// ═══════════════════════════════════════════════════════════
async function handleAdminBan(req, res) {
  const token = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || token !== expected)
    return res.status(401).json({ error: 'unauthorized' });

  const { type, value } = req.body || {};
  if (typeof value !== 'string' || value.length < 1 || value.length > 512)
    return res.status(400).json({ error: 'invalid value' });

  switch (type) {
    case 'hwid': revokeHwid(value); break;
    case 'user': revokeUser(value); break;
    case 'ip':   revokeIp(value);   break;
    default: return res.status(400).json({ error: 'invalid type' });
  }

  return res.status(200).json({
    ok: true, type,
    value: value.slice(0, 20) + (value.length > 20 ? '...' : ''),
    stats: stats(),
  });
    }
