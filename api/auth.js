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
  revokeHwid, revokeHwidHash, revokeUser, revokeIp, checkRevoked, stats, listRevocations,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;
const LOADA_PATH_TTL = 20 * 1000;
const ARTIFACT_FILES = Object.freeze({
  loadc: 'loadc.lua',
  loada: 'loada.lua',
  loader: 'loader.lua',
  payload: 'payload.lua',
  sdk: '999MS-sdk.lua',
});
const STAGE_TWO_RAW_SHA256 = '1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d';
const WEAREDEVS_OBFUSCATE_URL = 'https://wearedevs.net/api/obfuscate';
const WEAREDEVS_TIMEOUT_MS = 8 * 1000;
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

// The base URL written into generated Lua is always the host the executor
// actually reached, so a preview deployment or a renamed project can never
// point stage 1 at a deployment that no longer exists.
function requestOrigin(req) {
  const host = String(
    req.headers['x-forwarded-host'] || req.headers.host || 'loader999mss.vercel.app',
  ).split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

// ═══ Control panel plumbing ═══
// The panel authenticates with ADMIN_TOKEN, which never reaches the browser in
// any other form. Calls to the Render gateway use SOCKET_ADMIN_TOKEN when it is
// configured, otherwise the token derived from REALTIME_TICKET_SECRET that the
// gateway also accepts — so no second secret has to be copied between hosts.
const REALTIME_HTTP_FALLBACK = 'https://loader999mss-realtime.onrender.com';

function realtimeHttpBase() {
  try {
    const url = new URL(process.env.REALTIME_WS_URL || '');
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
  } catch {
    return REALTIME_HTTP_FALLBACK;
  }
}

function socketAdminToken() {
  const explicit = process.env.SOCKET_ADMIN_TOKEN;
  if (typeof explicit === 'string' && explicit.length >= 32) return explicit;
  const secret = process.env.REALTIME_TICKET_SECRET;
  if (typeof secret === 'string' && secret.length >= 32) {
    return crypto.createHmac('sha256', secret).update('999MS socket admin v1').digest('hex');
  }
  return null;
}

function adminTokenFromRequest(req) {
  const direct = req.headers['x-admin-token'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) return bearer.slice(7);
  return '';
}

function isAdminRequest(req) {
  const expected = process.env.ADMIN_TOKEN;
  return typeof expected === 'string' && expected.length >= 16
    && timingSafeStringEquals(adminTokenFromRequest(req), expected);
}

async function gatewayRequest(pathname, options = {}) {
  const token = socketAdminToken();
  if (!token) return { ok: false, status: 503, data: { ok: false, reason: 'gateway_not_configured' } };
  const controller = new AbortController();
  // Render's free instance can take ~15 s to wake from idle.
  const timeout = setTimeout(() => controller.abort(), 24000);
  try {
    const response = await fetch(`${realtimeHttpBase()}${pathname}`, {
      ...options,
      headers: { ...(options.headers || {}), authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    const aborted = error.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      data: { ok: false, reason: aborted ? 'gateway_timeout' : 'gateway_unreachable' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

const CONTROL_ACTIONS = new Set(['control-sessions', 'control-command', 'control-bans']);

function timingSafeStringEquals(supplied, expectedValue) {
  if (typeof supplied !== 'string' || typeof expectedValue !== 'string') return false;
  const expected = Buffer.from(expectedValue, 'utf8');
  const candidate = Buffer.from(supplied, 'utf8');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// LOADA_PATH_SECRET is optional when the already-required TICKET_SECRET is
// present. The sole Stage-1 capability is stateless, so its Stage-2 fetch can
// land on a different Vercel instance without a database.
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
    now - issuedAt <= LOADA_PATH_TTL;
}

function signStagePath(stage, d, secret) {
  return crypto.createHmac('sha256', secret).update(`999MS-stage-v2:${stage}:${d}`).digest('hex');
}

function createLoadaPathCapability() {
  const secret = loadaPathSecret();
  if (!secret) return null;
  // Root Stage-2 id: current milliseconds plus 26 random bytes. It is minted
  // into each generated loadc response and is the only chain path capability.
  const d = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(26).toString('hex');
  return { stage: 'loada', d, n: signStagePath('loada', d, secret) };
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
  redeemedStageCapabilities.set(key, capabilityTimestamp(capability.d) + LOADA_PATH_TTL);
  return true;
}

// Browser trapping is cosmetic anti-scraping, never authorization. Mobile
// executors (Delta, Fluxus, …) send a Chrome-like User-Agent and language/`sec-*`
// headers, which used to make the loader's own `/loader.lua` fetch receive a
// 302 and die with "Loader fetch failed" (reference MS9-0530EB6F). Artifact and
// API traffic is therefore served regardless of UA by default; set
// TRAP_BROWSER_ARTIFACTS=1 to restore the old behaviour.
function trapBrowserArtifacts() {
  return process.env.TRAP_BROWSER_ARTIFACTS === '1';
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

  // Legacy chain id endpoint. The Oct-14 generation of loadc.lua asked here for
  // a 64-hex chain id before fetching Stage 2; a cached copy of that bootstrapper
  // still runs on some executors. It returns no secrets and no session state.
  if (action === 'bootstrap') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      id: crypto.randomBytes(32).toString('hex'),
      chain: '999MS-chain-v1',
      ts: Date.now(),
    });
  }

  // ═══ Control panel (browser-facing, ADMIN_TOKEN gated) ═══
  if (CONTROL_ACTIONS.has(action)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
    if (!isAdminRequest(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

    if (action === 'control-sessions') {
      const gateway = await gatewayRequest('/admin/sessions');
      const health = await gatewayRequest('/admin/stats');
      return res.status(gateway.ok ? 200 : gateway.status).json({
        ok: gateway.ok,
        gateway: {
          reachable: gateway.status !== 502 && gateway.status !== 504,
          version: gateway.data?.version || health.data?.version || null,
          uptime: health.data?.uptime ?? null,
          reason: gateway.data?.reason || null,
        },
        count: gateway.data?.count || 0,
        sessions: Array.isArray(gateway.data?.sessions) ? gateway.data.sessions : [],
        now: Date.now(),
      });
    }

    if (action === 'control-command') {
      const body = req.body || {};
      const jti = typeof body.jti === 'string' ? body.jti : '';
      const commandName = typeof body.command === 'string' ? body.command : '';
      if (!/^[a-f0-9]{24}$/.test(jti)) return res.status(400).json({ ok: false, reason: 'invalid jti' });
      if (!['notice', 'reauth', 'disconnect'].includes(commandName)) {
        return res.status(400).json({ ok: false, reason: 'invalid command' });
      }
      const gateway = await gatewayRequest('/admin/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jti,
          command: commandName,
          message: typeof body.message === 'string' ? body.message.slice(0, 256) : '',
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 128) : '',
        }),
      });
      return res.status(gateway.ok ? 200 : gateway.status).json(gateway.data);
    }

    // control-bans
    return res.status(200).json({
      ok: true,
      stats: stats(),
      lists: listRevocations(),
      scope: 'instance',
      note: 'In-memory revocations apply to this function instance; env REVOKED_* entries apply everywhere.',
    });
  }

  // Payload remains the static final handoff from the legacy stage chain.
  if (action === 'payload') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    try {
      const body = readArtifact('payload');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (error) {
      console.error('[payload]', error.message);
      return res.status(404).send('Not Found');
    }
  }

  // loadc is generated per request and is the only stage that mints a path
  // capability. The remaining legacy artifacts keep their static handoffs.
  if (action === 'artifact') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    const name = req.query?.name || url.searchParams.get('name');
    return await serveArtifact(req, res, name, url, requestOrigin(req));
  }

  // Public, credential-free health probe so the landing page can show a real
  // status instead of a static badge. Deliberately returns no configuration.
  if (action === 'health') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      service: '999MS',
      version: '2.1.0',
      chain: '999MS-chain-v1',
      realtime: Boolean(process.env.REALTIME_WS_URL),
      ts: Date.now(),
    });
  }

  if (action === 'trap') return rejectOrTrap(req, res);



  // ═══ อื่นๆ: ต้อง POST ═══
  if (req.method !== 'POST') return rejectOrTrap(req, res, 405);
  if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);

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

async function serveArtifact(req, res, name, url, origin) {
  if (name === 'loadc') {
    const body = await renderLoadcArtifact(origin);
    if (!body) return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  }
  if (name === 'loada') {
    const capability = readStageCapability(req, url, 'loada');
    if (!capability || !consumeStageCapability(capability)) return rejectOrTrap(req, res);
  } else if (name !== 'loader' && name !== 'sdk') {
    return rejectOrTrap(req, res);
  }
  try {
    const body = readArtifact(name);
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
  'local $f="@BASE_URL@"',
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

function stripWeAreDevsBanner(source) {
  return source.replace(/^\s*--\[\[\s*v[\d.]+\s+https?:\/\/wearedevs\.net\/obfuscator\s*\]\]\s*/i, '');
}

function asLuaLongString(source) {
  let equals = '';
  while (source.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[${source}]${equals}]`;
}

function wrapWeAreDevsOutput(source) {
  // Prometheus's WeAreDevs output writes temporary values into getfenv(). In
  // Roblox executors that table can be read-only, so execute it in a fresh
  // writable overlay while inheriting all original executor globals.
  return `local e=getfenv();local t=setmetatable({},{__index=e});t.getfenv=function()return t end;t._ENV=t;local f=assert(loadstring(${asLuaLongString(source)}));setfenv(f,t);return f(...)`;
}

async function obfuscateWithWeAreDevs(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEAREDEVS_TIMEOUT_MS);
  try {
    const response = await fetch(WEAREDEVS_OBFUSCATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: source }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok || payload?.success !== true || typeof payload.obfuscated !== 'string' || !payload.obfuscated) {
      throw new Error(`WeAreDevs rejected Stage 1 (${response.status})`);
    }
    return wrapWeAreDevsOutput(stripWeAreDevsBanner(payload.obfuscated));
  } catch (error) {
    console.error('[loadc-obfuscate]', error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function renderLoadcArtifact(origin = 'https://loader999mss.vercel.app') {
  const capability = createLoadaPathCapability();
  if (!capability) return null;
  const stagedSource = readArtifact('loada');
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
  let source = fs.readFileSync(path.join(process.cwd(), 'artifacts', 'loadc.lua'), 'utf8')
    .replace('$y', prelude.join(';'))
    .replace('$z', setup.join(';'))
    .replaceAll('@STAGE2_SHA256@', stagedSha256)
    .replaceAll('@BASE_URL@', origin);
  for (const [token, value] of substitutions) source = source.replaceAll(token, value);
  return obfuscateWithWeAreDevs(source);
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
  const { ticket, Data, scriptName, hwid } = req.body || {};

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

  // Ticket replay guard. A ticket is bound to one HWID at /api/verify, so the
  // body fetch must be redeemable only from that same device. Set
  // ENFORCE_SCRIPT_HWID=1 once the deployed client sends `hwid` here.
  if (process.env.ENFORCE_SCRIPT_HWID === '1') {
    if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512) {
      return res.status(400).json({ Valid: false, reason: 'hwid required' });
    }
    if (!timingSafeStringEquals(hashHwid(hwid), payload.hwidHash)) {
      return res.status(403).json({ Valid: false, reason: 'hwid mismatch' });
    }
  }

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
    .replace(/\$\{ISSUED\}/g, new Date().toISOString())
    .replace(/\$\{BASEURL\}/g, requestOrigin(req));

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
  if (!isAdminRequest(req))
    return res.status(401).json({ error: 'unauthorized' });

  const { type, value } = req.body || {};
  if (typeof value !== 'string' || value.length < 1 || value.length > 512)
    return res.status(400).json({ error: 'invalid value' });

  switch (type) {
    case 'hwid': revokeHwid(value); break;
    case 'hwidHash':
      if (!/^[a-f0-9]{64}$/i.test(value)) return res.status(400).json({ error: 'invalid hash' });
      revokeHwidHash(value);
      break;
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
