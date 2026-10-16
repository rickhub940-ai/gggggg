const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyKey, createLink } = require('../lib/platoboost');
const { issueTicket, verifyTicket, hashHwid } = require('../lib/ticket');
const {
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  deriveRuntimeCredentials,
  verifyRuntimeProof,
} = require('../lib/999MS-server-sdk');
const {
  revokeHwid, revokeUser, revokeIp, checkRevoked, stats,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;
const LOADA_PATH_TTL = 20 * 1000;
const STAGE_PATH_TTL = LOADA_PATH_TTL;
const ARTIFACT_FILES = Object.freeze({
  loadc: 'loadc.lua',
  loada: 'loada.lua',
  loader: 'loader.lua',
  payload: 'payload.lua',
  sdk: '999MS-sdk.lua',
});
const STAGE_SUCCESSORS = Object.freeze({ loada: 'loader', loader: 'payload' });
const STAGE_TWO_RAW_SHA256 = '1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d';
// Capability redemption is additionally tracked for the lifetime of a warm
// function. The signed capability is the cross-instance authority; the map
// closes accidental/replayed fetches that return to the same instance.
const redeemedStageCapabilities = new Map();

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

// Roblox-marked requests never receive the browser redirect. Invalid paths or
// methods still fail closed, but with a normal empty HTTP error instead.
function rejectOrTrap(req, res, status = 404) {
  if (hasRobloxHeader(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).send('');
  }
  return trapRedirect(res);
}

// ═══ Request classification ═══
// Roblox executor/game requests are allowed through the browser-trap gate when
// any header name or value contains "roblox", regardless of letter casing.
function hasRobloxHeader(req) {
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (`${name}:${Array.isArray(value) ? value.join(',') : value || ''}`.toLowerCase().includes('roblox')) {
      return true;
    }
  }
  return false;
}

function timingSafeStringEquals(supplied, expectedValue) {
  if (typeof supplied !== 'string' || typeof expectedValue !== 'string') return false;
  const expected = Buffer.from(expectedValue, 'utf8');
  const candidate = Buffer.from(supplied, 'utf8');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// LOADA_PATH_SECRET is optional when the already-required TICKET_SECRET is
// present. Capability signatures are stateless, allowing adjacent stages to
// land on different Vercel instances. Every signature binds both the intended
// stage and a short-lived, parent-derived capability id.
function loadaPathSecret() {
  const secret = process.env.LOADA_PATH_SECRET || process.env.TICKET_SECRET;
  return typeof secret === 'string' && secret.length >= 32 ? secret : null;
}

function capabilityTimestamp(d) {
  return Number.parseInt(d.slice(0, 12), 16);
}

function isFreshCapabilityId(d) {
  if (typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)) return false;
  const issuedAt = capabilityTimestamp(d);
  const now = Date.now();
  return Number.isSafeInteger(issuedAt) && issuedAt <= now + 5000 &&
    now - issuedAt <= STAGE_PATH_TTL;
}

function signStagePath(stage, d, secret) {
  return crypto.createHmac('sha256', secret).update(`999MS-stage-v2:${stage}:${d}`).digest('hex');
}

function createLoadaPathCapability() {
  const secret = loadaPathSecret();
  if (!secret) return null;
  // Root Stage-2 id: current milliseconds plus 26 random bytes. The id is
  // then deterministically extended by each permitted parent stage below.
  const d = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(26).toString('hex');
  return { stage: 'loada', d, n: signStagePath('loada', d, secret) };
}

function deriveSuccessorCapability(parentStage, parentD) {
  const stage = STAGE_SUCCESSORS[parentStage];
  const secret = loadaPathSecret();
  if (!stage || !secret || !isFreshCapabilityId(parentD)) return null;
  // Same expiry as the parent. HMAC-derived entropy binds this child to that
  // exact parent capability and prevents a client from minting a later stage.
  const d = parentD.slice(0, 12) + crypto.createHmac('sha256', secret)
    .update(`999MS-stage-child-v2:${parentStage}:${stage}:${parentD}`)
    .digest('hex').slice(0, 52);
  return { stage, d, n: signStagePath(stage, d, secret) };
}

function readStageCapability(req, url, stage) {
  const d = req.query?.d || url.searchParams.get('d');
  const n = req.query?.n || url.searchParams.get('n');
  const secret = loadaPathSecret();
  if (!isFreshCapabilityId(d) || typeof n !== 'string' || !/^[a-f0-9]{64}$/.test(n) || !secret) return null;
  if (!timingSafeStringEquals(n, signStagePath(stage, d, secret))) return null;
  return { stage, d, n };
}

function consumeStageCapability(capability) {
  const now = Date.now();
  for (const [key, expiresAt] of redeemedStageCapabilities) {
    if (expiresAt < now) redeemedStageCapabilities.delete(key);
  }
  const key = `${capability.stage}:${capability.d}`;
  if (redeemedStageCapabilities.has(key)) return false;
  redeemedStageCapabilities.set(key, capabilityTimestamp(capability.d) + STAGE_PATH_TTL);
  return true;
}

function isBrowserRequest(req) {
  const headers = req.headers || {};
  if (hasRobloxHeader(req)) return false;
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

  // ═══ ARTIFACT DELIVERY (GET) ═══
  // loadc creates the root capability. Every later chain artifact is served
  // only after its stage-specific capability validates; browser requests are
  // trapped before an artifact can be delivered.
  if (action === 'artifact') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    if (isBrowserRequest(req)) return trapRedirect(res);
    const name = req.query?.name || url.searchParams.get('name');
    return serveArtifact(req, res, name, url);
  }

  if (action === 'trap') return rejectOrTrap(req, res);



  // ═══ อื่นๆ: ต้อง POST ═══
  if (req.method !== 'POST') return rejectOrTrap(req, res, 405);
  if (isBrowserRequest(req)) return trapRedirect(res);

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return rejectOrTrap(req, res, 415);

  const validActions = ['verify', 'script', 'script-verify', 'heartbeat', 'start', 'admin-ban'];
  if (!action || !validActions.includes(action)) return rejectOrTrap(req, res);

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

function readArtifact(name) {
  const filename = ARTIFACT_FILES[name];
  if (!filename) return null;
  const body = fs.readFileSync(path.join(process.cwd(), 'artifacts', filename), 'utf8');
  if (name === 'loada' && crypto.createHash('sha256').update(body).digest('hex') !== STAGE_TWO_RAW_SHA256) {
    throw new Error('Stage-2 raw artifact integrity check failed');
  }
  return body;
}

function stageShim(next) {
  // This compact, un-obfuscated bridge exists only because the legacy
  // downstream artifacts are already obfuscated. It swaps their one known
  // static fetch for the freshly minted successor capability.
  const target = `https://loader999ms.vercel.app/${next.stage}.lua/${next.d}/${next.n}`;
  const expectedPath = `/${next.stage}.lua`;
  return `do local e=getgenv();local o=(syn and syn.request)or(http and http.request)or request or http_request;if type(o)=="function"then local u="${target}";local function r(q,...)if type(q)=="table"and type(q.Url)=="string"and q.Url:find("${expectedPath}",1,true)then q.Url=u end;return o(q,...)end;for _,t in pairs{e,syn,http,_G}do if type(t)=="table"then t.request=r;t.http_request=r end end end end\n`;
}

function renderChainedArtifact(stage, capability) {
  const source = readArtifact(stage);
  if (typeof source !== 'string') return null;
  const next = deriveSuccessorCapability(stage, capability.d);
  return next ? `${stageShim(next)}${source}` : null;
}

function serveArtifact(req, res, name, url) {
  if (name === 'loadc') {
    const body = renderLoadcArtifact();
    if (!body) return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  }
  if (name === 'sdk') {
    try {
      const body = readArtifact(name);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (error) {
      console.error('[artifact]', error.message);
      return res.status(404).send('Not Found');
    }
  }
  if (!Object.hasOwn(STAGE_SUCCESSORS, name) && name !== 'payload') return rejectOrTrap(req, res);
  const capability = readStageCapability(req, url, name);
  if (!capability || !consumeStageCapability(capability)) return rejectOrTrap(req, res);
  try {
    const body = name === 'payload' ? readArtifact('payload') : renderChainedArtifact(name, capability);
    if (typeof body !== 'string') return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  } catch (error) {
    console.error('[artifact]', error.message);
    return res.status(404).send('Not Found');
  }
}

// ═══ Dynamic Stage-1 renderer ═══
// /loadc.lua is generated per executor request. It receives a fresh chain ID
// and a short-lived d/n capability directly in its source, so no public
// bootstrap endpoint is needed.
const LOADC_VARIABLE_TOKENS = Object.freeze([
  '$a', '$b', '$c', '$d', '$e',
  '$f', '$g', '$h', '$i', '$j', '$k', '$l',
  '$m', '$n', '$o', '$p', '$q', '$r',
  '$s', '$t', '$u', '$0', '$1', '$2',
]);
const LOADC_SHORT_IDENTIFIERS = Object.freeze('abcdefghijklmnopqrstuvwxyz'.split(''));
const LOADC_PRELUDE_LINES = Object.freeze([
  'local $a=os.clock()',
  'local $b=os.time()',
  'local $c=os.date"*t"',
  'local $f="https://loader999ms.vercel.app"',
  'local $h="$v"',
  'local $i="$w"',
  'local $j="$x"',
  'local $k="@STAGE2_SHA256@"',
  'local $l=(getgenv and(getgenv()))or(_G)',
]);
let lastLoadcLayout = '';
const LOADC_SETUP_BLOCKS = Object.freeze([
  [
    'local $0=((os.tick)or(tick))()',
    'local $1=(table.freeze and(table.freeze({c=$a,t=$0})))or{c=$a,t=$0}',
    'local $d=os.difftime($b,$b-1)',
    'local $e=table.concat({tostring($1.c),tostring($b),tostring($c.year),tostring($c.yday),tostring($c.hour),tostring($c.min),tostring($c.sec),tostring($1.t),tostring($d)},"-")',
  ].join(';'),
  'local $g={$f,"/loada.lua","999MS-chain-v1","lite",true}',
  'local $2=(debug and(debug.traceback))or(function($2)return $2;end)',
  [
    'if not $j:match("^[a-f0-9]+$")or#$j~=64 then error("MS999:S1:E01:CHAIN_ID_INVALID",0)end',
    '$l.MS999Chain=nil',
    '$l.MS999Chain={Version="999MS-chain-v1",Id=$j,Stage="stage1",UpdatedAt=tick()}',
  ].join(';'),
]);

function shuffled(items) {
  const values = [...items];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function shuffledLoadcIdentifiers() {
  return shuffled(LOADC_SHORT_IDENTIFIERS).slice(0, LOADC_VARIABLE_TOKENS.length);
}

function renderLoadcArtifact() {
  const capability = createLoadaPathCapability();
  if (!capability) return null;
  const stagedSource = renderChainedArtifact('loada', capability);
  if (!stagedSource) return null;
  const substitutions = new Map([
    ['$v', capability.d],
    ['$w', capability.n],
    ['$x', crypto.randomBytes(32).toString('hex')],
  ]);
  const stagedSha256 = crypto.createHash('sha256').update(stagedSource).digest('hex');
  let identifiers;
  let prelude;
  let setup;
  let layout;
  do {
    identifiers = shuffledLoadcIdentifiers();
    prelude = shuffled(LOADC_PRELUDE_LINES);
    setup = shuffled(LOADC_SETUP_BLOCKS);
    layout = `${identifiers.join('')}:${prelude.join('|')}:${setup.join('|')}`;
  } while (layout === lastLoadcLayout);
  lastLoadcLayout = layout;
  LOADC_VARIABLE_TOKENS.forEach((token, index) => substitutions.set(token, identifiers[index]));
  let body = fs.readFileSync(path.join(process.cwd(), 'artifacts', 'loadc.lua'), 'utf8')
    .replace('$y', prelude.join(';'))
    .replace('$z', setup.join(';'))
    .replaceAll('@STAGE2_SHA256@', stagedSha256);
  for (const [token, value] of substitutions) body = body.replaceAll(token, value);
  return body;
}

// ═══ /api/verify ═══
async function handleVerify(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { key, hwid, userId, scriptName } = req.body || {};
  // First request challenge: reject a simple forged `{ valid: true }` response
  // before issuing a signed ticket. The provider still owns key/device binding.
  const clientChallenge = validateClientChallenge(req.body);

  if (typeof key !== 'string' || !key.trim())
    return res.status(400).json({ valid: false, error: 'key required' });
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ valid: false, error: 'invalid hwid format' });
  if (typeof scriptName !== 'string' || scriptName.length < 1 || scriptName.length > 64)
    return res.status(400).json({ valid: false, error: 'scriptName required' });
  if (!isValidScriptName(scriptName))
    return res.status(400).json({ valid: false, error: 'invalid scriptName format' });
  if (!clientChallenge.ok)
    return res.status(400).json({ valid: false, error: clientChallenge.reason });

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

  return res.status(200).json({
    valid: true,
    ticket,
    k: xorKey,
    check: createChallengeResponse(clientChallenge.values),
  });
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

  if (!isValidScriptName(name))
    return res.status(200).json(encodeProtectedPayload({ Valid: false, reason: 'Invalid script name' }, xorKey));

  let clientData = null;
  if (Data) {
    const decoded = decodeProtectedPayload({ Data }, xorKey);
    if (decoded.ok) clientData = decoded.data;
  }

  // This is a tamper signal only; server-issued tickets remain the
  // authorization boundary.
  const rngChallenge = validateClientChallenge(clientData);
  if (!rngChallenge.ok) {
    return res.status(200).json(encodeProtectedPayload({
      Valid: false, reason: 'RNG challenge rejected',
    }, xorKey));
  }

  // Keep the response fields compatible with the existing obfuscated stages,
  // while making the proof verifiable by any Vercel instance (no in-memory
  // affinity is required between /api/script and /api/script-verify).
  const { scriptToken, runtimeSecret } = deriveRuntimeCredentials({
    ticketPayload: payload,
    scriptName: name,
  });

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
    return res.status(200).json(encodeProtectedPayload({ Valid: false, reason: 'Script not found: ' + name }, xorKey));
  }

  // main.lua remains readable/server-templated for this runtime build.
  scriptBody = scriptBody
    .replace(/\$\{SERVERID\}/g, payload.jti)
    .replace(/\$\{SCRIPTID\}/g, name)
    .replace(/\$\{HWIDHASH\}/g, payload.hwidHash)
    .replace(/\$\{ISSUED\}/g, new Date().toISOString());

  const check = createChallengeResponse(rngChallenge.values);

  return res.status(200).json(encodeProtectedPayload({
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
// The on-screen client reference stays opaque. This server-side category is
// intentionally credential-free, so it can be safely correlated in Vercel logs
// without recording keys, tickets, HWIDs, tokens, or runtime secrets.
function diagnosticReference(category) {
  const text = `[999MS] ${category}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33 + text.charCodeAt(index) + index + 1) % 2147483647;
  }
  return `MS9-${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}

function rejectRuntimeVerification(res, status, category) {
  console.warn(`[script-verify] category=${category} reference=${diagnosticReference(category)}`);
  return res.status(status).json({ valid: false, diagnostic: category });
}

async function handleScriptVerify(req, res) {
  const { ticket, hwid, scriptToken, runtimeSecret, scriptName } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096) {
    return rejectRuntimeVerification(res, 400, 'D2_TICKET_MISSING');
  }

  const payload = verifyTicket(ticket);
  if (!payload) return rejectRuntimeVerification(res, 401, 'D2_TICKET_INVALID');
  if (payload.scope !== 'script') return rejectRuntimeVerification(res, 403, 'D2_TICKET_SCOPE');

  const banReason = checkRevoked({ userId: payload.userId });
  if (banReason) return rejectRuntimeVerification(res, 403, 'D2_REVOKED');

  if (typeof runtimeSecret !== 'string' || runtimeSecret.length !== 64) {
    return rejectRuntimeVerification(res, 403, 'D2_SECRET_FORMAT');
  }
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512) {
    return rejectRuntimeVerification(res, 403, 'D2_HWID_FORMAT');
  }

  const proofFailure = verifyRuntimeProof({
    ticketPayload: payload,
    runtimeSecret,
    scriptToken,
    hwidHash: hashHwid(hwid),
    scriptName,
    runtimeTtl: RUNTIME_TTL,
  });
  if (proofFailure) {
    const categories = {
      'ticket claims invalid': 'D2_TICKET_CLAIMS',
      'scriptName changed': 'D2_SCRIPT_MISMATCH',
      'hwid mismatch': 'D2_HWID_MISMATCH',
      'token malformed': 'D2_TOKEN_FORMAT',
      'runtime expired': 'D2_RUNTIME_EXPIRED',
      'token mismatch': 'D2_TOKEN_MISMATCH',
      'secret mismatch': 'D2_SECRET_MISMATCH',
    };
    return rejectRuntimeVerification(res, 403, categories[proofFailure] || 'D2_PROOF_REJECTED');
  }

  // This in-memory entry is only used by the optional heartbeat UX. It is no
  // longer an authorization dependency, so a new Vercel instance cannot turn
  // a valid proof into a false "session not found" failure.
  const session = sessions.get(payload.jti);
  if (session) {
    session.verified = true;
    session.verifiedAt = Date.now();
  }

  return res.status(200).json({ valid: true, serverId: payload.jti, diagnostic: 'D2_OK' });
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
    return res.status(200).json(encodeProtectedPayload({ Valid: true, commands: [] }, xorKey));

  session.lastBeat = Date.now();

  if (Data) {
    const decoded = decodeProtectedPayload({ Data }, xorKey);
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

  return res.status(200).json(encodeProtectedPayload({
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
