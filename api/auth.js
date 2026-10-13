const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyKey, createLink } = require('../lib/platoboost');
const { issueTicket, verifyTicket, hashHwid } = require('../lib/ticket');
const { xorCipher, b64encode, b64decode } = require('../lib/crypto');
const {
  revokeHwid, revokeUser, revokeIp, checkRevoked, stats,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;

// ═══ Rate limit ═══
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

// ═══ Trap redirect ═══
const TRAP_URL = 'https://yura.lol/09ms';

function trapRedirect(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', TRAP_URL);
  return res.status(302).send('');
}

// ═══ Browser check ═══
function isBrowserRequest(req) {
  const headers = req.headers || {};
  const ua = (headers['user-agent'] || '').toLowerCase();

  if (/mozilla|chrome|safari|firefox|edge|opera|msie|trident/i.test(ua)) return true;
  if (/discordbot|telegrambot|twitterbot|facebookexternalhit|slackbot/i.test(ua)) return true;

  if (headers['origin'] || headers['referer']) return true;
  if (headers['accept-language']) return true;
  for (const k of Object.keys(headers)) {
    if (k.startsWith('sec-')) return true;
  }

  return false;
}

// ═══ Main handler ═══
module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = req.query?.action || url.searchParams.get('action');

  // ═══ PAYLOAD (GET) ═══
  if (action === 'payload') {
    if (isBrowserRequest(req)) return trapRedirect(res);
    try {
      const p = path.join(process.cwd(), 'public', 'payload.lua');
      const body = fs.readFileSync(p, 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).send(body);
    } catch (e) {
      console.error('[payload]', e.message);
      return res.status(404).send('Not Found');
    }
  }

  // ═══ อื่นๆ: ต้อง POST ═══
  if (req.method !== 'POST') return trapRedirect(res);
  if (isBrowserRequest(req)) return trapRedirect(res);

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return trapRedirect(res);

  const validActions = ['verify', 'script', 'script-verify', 'heartbeat', 'start', 'admin-ban'];
  if (!action || !validActions.includes(action)) return trapRedirect(res);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.socket?.remoteAddress || '';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  try {
    switch (action) {
      case 'verify':         return await handleVerify(req, res, ip);
      case 'script':         return await handleScript(req, res, ip);
      case 'script-verify':  return await handleScriptVerify(req, res);
      case 'heartbeat':      return await handleHeartbeat(req, res, ip);
      case 'start':          return await handleStart(req, res, ip);
      case 'admin-ban':      return await handleAdminBan(req, res);
      default:
        return trapRedirect(res);
    }
  } catch (err) {
    console.error('[auth]', action, err.message);
    return res.status(502).json({ error: 'Service unavailable' });
  }
};

// ═══ Codec ═══
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

// ═══ /api/verify ═══
async function handleVerify(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { key, hwid, userId, scriptName } = req.body || {};

  if (typeof key !== 'string' || !key.trim())
    return res.status(400).json({ valid: false, error: 'key required' });
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ valid: false, error: 'invalid hwid format' });
  if (typeof scriptName !== 'string' || scriptName.length < 1 || scriptName.length > 64)
    return res.status(400).json({ valid: false, error: 'scriptName required' });
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scriptName))
    return res.status(400).json({ valid: false, error: 'invalid scriptName format' });

  const reason = checkRevoked({ hwid, userId, ip });
  if (reason)
    return res.status(403).json({ valid: false, message: 'Banned: ' + reason });

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

// ═══ /api/script ═══
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

  if (!name) return res.status(400).json({ Valid: false, reason: 'no scriptName' });
  if (name !== payload.scriptName)
    return res.status(403).json({ Valid: false, reason: 'scriptName mismatch' });

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    return res.status(200).json(encodePayload({ Valid: false, reason: 'Invalid script name' }, xorKey));

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
    return res.status(200).json(encodePayload({ Valid: false, reason: 'Script not found: ' + name }, xorKey));
  }

  scriptBody = scriptBody
    .replace(/\$\{SERVERID\}/g, payload.jti)
    .replace(/\$\{SCRIPTID\}/g, name)
    .replace(/\$\{HWIDHASH\}/g, payload.hwidHash)
    .replace(/\$\{ISSUED\}/g, new Date().toISOString());

  // The client restores a check component with floor(2 * value + 0.5).
  // Encode each integer so that this exact inverse operation returns the
  // original RNG value. The previous code applied the inverse on both sides,
  // turning every value into roughly 4x itself and rejecting valid keys.
  let check = '0|0|0|0|0';
  const rngValues = clientData && ['Rng1', 'Rng2', 'Rng3', 'Rng4', 'Rng5']
    .map((name) => clientData[name]);
  if (rngValues && rngValues.every(Number.isSafeInteger)) {
    check = rngValues.map((value) => (value - 0.5) / 2).join('|');
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

// ═══ /api/script-verify ═══
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

  if (typeof scriptName === 'string' && scriptName !== session.scriptName)
    return res.status(403).json({ valid: false, reason: 'scriptName changed' });

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

// ═══ /api/heartbeat ═══
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

// ═══ /api/start ═══
async function handleStart(req, res, ip) {
  const { hwid } = req.body || {};

  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ error: 'invalid hwid' });

  if (!checkRateLimit(ip))
    return res.status(429).json({ error: 'Rate limited' });

  const reason = checkRevoked({ hwid, ip });
  if (reason)
    return res.status(403).json({ error: 'Banned: ' + reason });

  try {
    const result = await createLink(hwid);
    return res.status(result.rateLimited ? 429 : 200).json(result);
  } catch (err) {
    console.error('[start]', err.message);
    return res.status(502).json({ error: 'Could not create link' });
  }
}

// ═══ /api/admin/ban ═══
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
