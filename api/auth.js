const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyKey, createLink } = require('../lib/platoboost');
const { resolveHwid, deviceBindingId, canonical } = require('../lib/hwid');
const { issueTicket, verifyTicket, hashHwid, hashBindingId } = require('../lib/ticket');
const link = require('../lib/link');
const chainLinks = require('../lib/chainlink');
const { obfuscateStageOne, obfuscationBudgetMs } = require('../lib/obfuscate');
const {
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  deriveRuntimeCredentials,
  verifyRuntimeProof,
  issueHop,
  consumeHop,
  createEquationChallenge,
  checkEquationAnswer,
} = require('../lib/999MS-server-sdk');
const {
  revokeHwid, revokeHwidHash, revokeUser, revokeIp, revokeKey, revokeKeyHash,
  isKeyRevoked, checkRevoked, stats, listRevocations,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;
const ARTIFACT_FILES = Object.freeze({
  loadc: 'loadc.lua',
  loada: 'loada.lua',
  loader: 'loader.lua',
  payload: 'payload.lua',
  sdk: '999MS-sdk.lua',
});
const STAGE_TWO_RAW_SHA256 = 'a2ff75f5d383cc4ac1e48976fcddcff257639b96438a888b424cecc7892b8c91';

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

// Prefer the host the executor actually reached so a preview deployment or a
// renamed project can never point the chain at a host that does not exist.
// PUBLIC_BASE_URL stays as the fallback for local runs.
function requestOrigin(req) {
  const host = String(
    (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '',
  ).split(',')[0].trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) return publicBaseUrl();
  const forwarded = req.headers['x-forwarded-proto'];
  // Behind Vercel the forwarded header is authoritative. Locally (no proxy)
  // fall back to the socket so tests and dev servers are served over http.
  const plainSocket = !(req.socket && req.socket.encrypted);
  const proto = String(forwarded || (plainSocket ? 'http' : 'https')).split(',')[0].trim();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

function publicBaseUrl() {
  const value = process.env.PUBLIC_BASE_URL;
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// LOADA_PATH_SECRET is optional when the already-required TICKET_SECRET is
// present. The sole Stage-1 capability is stateless, so its Stage-2 fetch can
// land on a different Vercel instance without a database.
function timingSafeStringEquals(supplied, expectedValue) {
  if (typeof supplied !== 'string' || typeof expectedValue !== 'string') return false;
  const expected = Buffer.from(expectedValue, 'utf8');
  const candidate = Buffer.from(supplied, 'utf8');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hasAdminAccess(req) {
  const expected = process.env.ADMIN_TOKEN;
  return typeof expected === 'string' && expected.length >= 32
    && timingSafeStringEquals(req.headers['x-admin-token'], expected);
}

// Readable stages carry @BASE_URL@ so neither the host nor a preview domain is
// ever hard-coded. The save-detector marker is a plain literal inside the stage
// itself (see source/savecheck.lua), so the same bytes are served every time.
function applyChainTokens(body, baseUrl) {
  if (typeof body !== 'string') return body;
  if (baseUrl && body.includes('@BASE_URL@')) return body.replaceAll('@BASE_URL@', baseUrl);
  return body;
}

// Browser trapping is cosmetic anti-scraping, never authorization. Mobile
// executors (Delta, Fluxus, …) look like Chrome, so trapping artifacts on UA
// used to break the loader's own /loader.lua fetch. Opt in with
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
const CONTROL_ACTIONS = new Set(['control-bans', 'control-traffic', 'control-events']);
const OPAQUE_ACTIONS = Object.freeze({
  q7: 'verify',
  m2: 'script',
  x9: 'script-verify',
  v4: 'heartbeat',
  k8: 'start',
});
const BAD_HWID_CODE = 'BAD HWID : ]';
const BAD_DEVICE_REASONS = new Set([
  'invalid hwid format',
  'hwid mismatch',
  'fingerprint required',
  'invalid fingerprint format',
  'hwid fingerprint mismatch',
]);
function clientDeviceMessage(reason) {
  return BAD_DEVICE_REASONS.has(reason) ? BAD_HWID_CODE : reason;
}

function decodeDeviceParts(body = {}) {
  const parts = [body.b, body.c, body.d, body.e, body.f];
  if (parts.some((part) => typeof part !== 'string' || !part)) return '';
  const encoded = parts.join('');
  if (encoded.length > 1024 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return '';
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (!decoded || Buffer.from(decoded, 'utf8').toString('base64') !== encoded) return '';
    if (canonical(decoded) !== decoded || deviceBindingId(decoded) !== encoded) return '';
    return decoded;
  } catch {
    return '';
  }
}

function decodeOpaqueRequest(action, body = {}) {
  // body.u may carry the client's raw-HWID decoy; deliberately ignore it.
  // Only the validated five-part Base64 representation determines identity.
  const hwid = decodeDeviceParts(body);
  switch (action) {
    case 'verify':
      return {
        key: body.a, c: hwid, scriptName: body.g, userId: body.h,
        Rng1: body.i, Rng2: body.j, Rng3: body.k,
        Rng4: body.l, Rng5: body.m, RngFloat: body.n,
      };
    case 'script':
      return { ticket: body.a, c: hwid, scriptName: body.g, Data: body.o, hop: body.q, eq: body.r };
    case 'script-verify':
      return {
        ticket: body.a, c: hwid, scriptName: body.g,
        hop: body.q, runtimeSecret: body.s, scriptToken: body.t,
      };
    case 'heartbeat':
      return { ticket: body.a, c: hwid, Data: body.o };
    case 'start':
      return { c: hwid };
    default:
      return {};
  }
}
// Ring buffer of the last 200 requests (no bodies, keys, HWIDs or tickets) so
// the panel can show what an executor actually fetched and which status it got.
const trafficLog = [];
const TRAFFIC_MAX = 200;

// ═══ Security events (bounded ring buffer, surfaced in the panel) ═══
const EVENTS_MAX = 200;
const securityEvents = [];
function noteEvent(kind, detail) {
  securityEvents.push({
    ts: Date.now(),
    kind: String(kind).slice(0, 40),
    detail: typeof detail === 'string' ? detail.slice(0, 160) : '',
  });
  if (securityEvents.length > EVENTS_MAX) securityEvents.splice(0, securityEvents.length - EVENTS_MAX);
}

// The client getter HWID is transported as five Base64 fragments. The server
// requires it to match the executor fingerprint header and trusts that
// fingerprint when deriving the persistent identifier. Base64 is reversible.
function hwidFromRequest(req, bodyValue) {
  const result = resolveHwid(req.headers || {}, bodyValue);
  if (!result.ok && result.reason === 'hwid mismatch') {
    noteEvent('hwid_spoof', 'explicit header and body disagree');
  }
  return result;
}

// A ticket is bound to the canonical HWID binding that earned it. Every
// protected request re-resolves that value before checking the ticket.
function deviceMatches(req, hwidHash, bodyValue) {
  const device = hwidFromRequest(req, bodyValue);
  if (!device.ok) return { ok: false, reason: device.reason };
  if (typeof hwidHash !== 'string' || !hwidHash) return { ok: false, reason: 'ticket has no device' };
  if (hashBindingId(device.bindingId) !== hwidHash) {
    noteEvent('device_reject', 'ticket used with a different HWID binding');
    return { ok: false, reason: 'device mismatch' };
  }
  return { ok: true, ...device };
}

// ═══ /api/link (admin) ═══
// Creates one random, expiring loader link: /x/<40 hex>?at=<token>.
async function handleLinkCreate(req, res) {
  if (!hasAdminAccess(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

  const body = req.body || {};
  const scriptName = link.normalizeScriptName(body.scriptName) || 'main';
  const hours = Math.min(Math.max(Number(body.hours) || 168, 1), 24 * 365);
  const origin = requestOrigin(req) || publicBaseUrl();
  if (!origin) return res.status(503).json({ ok: false, reason: 'origin unavailable' });

  const linkPath = link.randomLinkPath();
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const token = link.issuePathToken({ path: linkPath, expiresAt });
  if (!token) return res.status(503).json({ ok: false, reason: 'LINK_SECRET/TICKET_SECRET missing' });

  const entry = link.renderEntryBody({ baseUrl: origin, path: linkPath, token });
  const digest = link.sha256(entry);
  const url = `${origin}/x/${linkPath}?at=${token}`;

  return res.status(200).json({
    ok: true,
    id: link.linkId(linkPath),
    path: `/x/${linkPath}`,
    url,
    line: `local License = ""\nlocal Script = ${JSON.stringify(scriptName)}\nloadstring(game:HttpGet("${url}"))(License, Script)`,
    sha256: digest,
    scriptName,
    expiresAt,
    stub: link.renderStub({ baseUrl: origin, path: linkPath, token, sha256: digest, scriptName, expiresAt }),
  });
}

// ═══ /x/<40 hex> ═══
// Serves the deterministic entry script for a link, then the normal chain.
async function handleLinkServe(req, res, url) {
  const linkPath = req.query?.p || url.searchParams.get('p') || '';
  const token = url.searchParams.get('at') || req.query?.at || '';
  if (!link.isLinkPath(linkPath)) return rejectOrTrap(req, res);
  const claim = link.verifyPathToken(token, linkPath);
  if (!claim) return rejectOrTrap(req, res);
  const origin = requestOrigin(req) || publicBaseUrl();
  if (!origin) return res.status(503).send('');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(link.renderEntryBody({ baseUrl: origin, path: linkPath, token }));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const requestedAction = req.query?.action || url.searchParams.get('action');
  const action = requestedAction === 'opaque'
    ? OPAQUE_ACTIONS[req.body?.p]
    : requestedAction;
  if (requestedAction === 'opaque' && action) {
    req.body = decodeOpaqueRequest(action, req.body);
  }

  const trace = {
    ts: Date.now(),
    method: req.method,
    path: url.pathname,
    action: action || null,
    name: req.query?.name || url.searchParams.get('name') || null,
    host: String(req.headers['x-forwarded-host'] || req.headers.host || ''),
    ua: String(req.headers['user-agent'] || '').slice(0, 80),
    status: 0,
    ms: 0,
  };
  trafficLog.push(trace);
  if (trafficLog.length > TRAFFIC_MAX) trafficLog.shift();
  const finish = (code) => { trace.status = trace.status || code; trace.ms = Date.now() - trace.ts; };
  const rawStatus = res.status.bind(res);
  res.status = (code) => { finish(code); return rawStatus(code); };
  for (const methodName of ['send', 'json', 'end']) {
    if (typeof res[methodName] === 'function') {
      const raw = res[methodName].bind(res);
      res[methodName] = (...args) => { finish(200); return raw(...args); };
    }
  }

  // loadc is generated per request and is the only stage that mints a path
  // capability. The remaining legacy artifacts keep their static handoffs.
  if (action === 'artifact') {
    const artifactName = req.query?.name || url.searchParams.get('name');
    // Stage links answer only a proven POST; the entry script stays a GET.
    const requiredMethod = artifactName === 'stage' ? 'POST' : 'GET';
    if (req.method !== requiredMethod) return rejectOrTrap(req, res, 405);
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    const name = artifactName;
    return await serveArtifact(req, res, name, url, requestOrigin(req));
  }

  // Public, credential-free health probe for the landing page.
  if (action === 'health') {
    if (req.method !== 'GET') return res.status(405).json({ ok: false });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      service: '999MS',
      version: '3.0.0',
      chain: '999MS-chain-v1',
      ts: Date.now(),
    });
  }

  // ═══ Control panel (browser-facing, ADMIN_TOKEN gated) ═══
  if (CONTROL_ACTIONS.has(action)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
    if (!hasAdminAccess(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

    if (action === 'control-traffic') {
      const limit = Math.min(Number(req.body && req.body.limit) || 100, TRAFFIC_MAX);
      return res.status(200).json({ ok: true, count: trafficLog.length, traffic: trafficLog.slice(-limit).reverse() });
    }

    if (action === 'control-events') {
      const limit = Math.min(Number(req.body && req.body.limit) || 100, EVENTS_MAX);
      return res.status(200).json({ ok: true, count: securityEvents.length, events: securityEvents.slice(-limit).reverse() });
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

  // Link system: /x/<40 hex>?at=<token> serves the entry script and
  // /api/link (admin) mints a new random link.
  if (action === 'link-serve') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    return await handleLinkServe(req, res, url);
  }

  if (action === 'link-create') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    return await handleLinkCreate(req, res);
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

function renderLoaderArtifact() {
  // Stage 3 receives the per-run context as a positional local argument. Keep
  // the readable marker at byte zero; no environment normalizer is injected.
  return readArtifact('loader');
}

// ═══ Stage rendering ═══
// Bodies are deterministic for a host and a token, so a stage can pin the exact
// bytes of the next one. The next-stage link is minted while serving a stage
// and written straight into that stage's body.
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function renderStage(name, baseUrl, nextUrl, nextSha, nextNonce) {
  const raw = name === 'loader' ? renderLoaderArtifact() : readArtifact(name);
  if (typeof raw !== 'string') return null;
  let body = applyChainTokens(raw, baseUrl);
  if (typeof nextUrl === 'string' && nextUrl) body = body.replaceAll('@NEXT@', nextUrl);
  if (typeof nextSha === 'string' && nextSha) body = body.replaceAll('@NEXT_SHA@', nextSha);
  if (typeof nextNonce === 'string' && nextNonce) body = body.replaceAll('@NONCE@', nextNonce);
  return body;
}

// Raw templates, cached per host. Substitution happens per request because the
// next-stage link changes every time.
const rawBodyCache = new Map();
function stageTemplate(name, baseUrl) {
  const key = `${name}|${baseUrl}`;
  if (rawBodyCache.has(key)) return rawBodyCache.get(key);
  let body = null;
  if (name === 'payload') {
    body = renderStage('payload', baseUrl);
  } else if (name !== 'sdk') {
    body = renderStage(name === 'sdk' ? 'sdk' : name, baseUrl);
  }
  if (typeof body === 'string') rawBodyCache.set(key, body);
  return body;
}

// Walks the chain from any token: the next link is derived from the current
// one, so every stage body (and its hash) can be produced up front.
function renderChain(baseUrl, token, depth = 0) {
  if (depth > 4) return null;
  const claim = chainLinks.resolveToken(token);
  if (!claim) return null;

  if (claim.stage === 'payload') {
    const body = renderStage('payload', baseUrl);
    return body ? { stage: 'payload', body, sha: sha256(body) } : null;
  }

  const next = chainLinks.deriveNext(token);
  if (!next) return null;
  const downstream = renderChain(baseUrl, next.token, depth + 1);
  if (!downstream) return null;

  const body = renderStage(
    claim.stage,
    baseUrl,
    `${baseUrl}/${next.token}`,
    downstream.sha,
    chainLinks.deriveNonce(next.token),
  );
  return body ? { stage: claim.stage, body, sha: sha256(body) } : null;
}

async function serveArtifact(req, res, name, url, origin) {
  const baseUrl = origin || publicBaseUrl();
  if (!baseUrl) return res.status(503).send('');

  // Stage 1: a fresh Stage-2 link, obfuscated per request.
  if (name === 'loadc') {
    const link = chainLinks.mintLink('loada', Date.now(), obfuscationBudgetMs());
    if (!link) return res.status(503).send('');
    const run = renderChain(baseUrl, link.token);
    if (!run) return res.status(503).send('');
    const template = fs.readFileSync(path.join(process.cwd(), 'artifacts', 'loadc.lua'), 'utf8');
    const rendered = template
      .replaceAll('__STAGE2_TOKEN__', link.token)
      .replaceAll('__STAGE2_SHA256__', run.sha)
      .replaceAll('__STAGE2_NONCE__', chainLinks.deriveNonce(link.token))
      .replaceAll('__BASE_URL__', baseUrl);
    const obfuscated = await obfuscateStageOne(rendered);
    if (!obfuscated) return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-999ms-obf', obfuscated.method);
    if (process.env.CHAIN_DEBUG === '1') {
      res.setHeader('x-999ms-stage2', `${baseUrl}/${link.token}`);
    }
    return res.status(200).send(obfuscated.body);
  }

  // Stages 2-4: reached through a bare `https://host/<token>` link. The token
  // carries no file name; the stage is recovered from its signature.
  if (name === 'stage') {
    const token = req.query?.t || url.searchParams.get('t');
    const pending = chainLinks.resolveToken(token);
    if (!pending) return rejectOrTrap(req, res);

    // Execution proof: the body of the previous stage carried a nonce, and only
    // a client that ran it can send back the matching hash. A plain GET (curl,
    // `game:HttpGet`, a browser) never has it.
    // The proof is over the full link the stage was given, not the bare token.
    const expected = chainLinks.fetchProof(chainLinks.deriveNonce(token), `${baseUrl}/${token}`);
    let supplied = '';
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (body && typeof body.p === 'string') supplied = body.p;
    } catch { supplied = ''; }
    const proofOk = Boolean(expected) &&
      supplied.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
    if (!proofOk || req.method !== 'POST') {
      // Burn the link on the bad attempt so it cannot be retried either way.
      chainLinks.consume(token);
      noteEvent('crawl_reject', `stage ${pending.stage} fetched without proof (${req.method})`);
      return rejectOrTrap(req, res);
    }

    const claim = chainLinks.consume(token);
    if (!claim) return rejectOrTrap(req, res);
    const run = renderChain(baseUrl, token);
    if (!run) return res.status(503).send('');
    const body = run.body;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  }

  if (name === 'sdk') {
    try {
      const body = stageTemplate('sdk', baseUrl);
      if (typeof body !== 'string') return res.status(503).send('');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (error) {
      console.error('[artifact]', error.message);
      return res.status(404).send('Not Found');
    }
  }

  return rejectOrTrap(req, res);
}

// ═══ /api/verify ═══// ═══ /api/verify ═══// ═══ /api/verify ═══
async function handleVerify(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const body = req.body || {};
  const { key, userId, scriptName } = body;
  const hwid = body.c ?? body.hwid;
  // Pre-key runtime challenge: the client must prove its request context before
  // the provider is consulted. /api/script and /api/script-verify independently
  // retain the post-key challenge and runtime-proof gates.
  const clientChallenge = validateClientChallenge(body);

  if (typeof key !== 'string' || !key.trim())
    return res.status(400).json({ valid: false, error: 'key required' });
  // The key shown in the reported bypass is now revoked server-side. Compare
  // only its digest; never echo or log the raw key.
  if (isKeyRevoked(key)) {
    noteEvent('verify_reject', 'revoked key | key ' + crypto.createHash('sha256').update(key.trim()).digest('hex').slice(0, 12));
    return res.status(200).json({ valid: false, message: 'Invalid key' });
  }

  const hwidCheck = hwidFromRequest(req, hwid);
  if (!hwidCheck.ok) {
    noteEvent('verify_reject', hwidCheck.reason + ' | key ' + hashHwid(key).slice(0, 12));
    const message = clientDeviceMessage(hwidCheck.reason);
    return res.status(403).json({ valid: false, error: message, message });
  }
  const clientHwid = hwidCheck.hwid;
  const bindingId = hwidCheck.bindingId;
  if (typeof scriptName !== 'string' || scriptName.length < 1 || scriptName.length > 64)
    return res.status(400).json({ valid: false, error: 'scriptName required' });
  if (!isValidScriptName(scriptName))
    return res.status(400).json({ valid: false, error: 'invalid scriptName format' });
  const reason = checkRevoked({ hwid: clientHwid, userId, ip });
  if (reason) {
    noteEvent('ban_hit', 'verify | hwid ' + hashHwid(clientHwid).slice(0, 12));
    return res.status(403).json({ valid: false, message: 'Banned: ' + reason });
  }
  if (!clientChallenge.ok) {
    noteEvent('verify_reject', 'pre-key runtime challenge | key ' + hashHwid(key).slice(0, 12));
    return res.status(400).json({ valid: false, error: clientChallenge.reason });
  }

  const result = await verifyKey(key, bindingId);
  if (!result.valid) {
    const failure = {
      valid: false,
      message: result.message || 'Invalid key',
    };
    if (result.deviceMismatch === true) failure.deviceMismatch = true;
    return res.status(result.rateLimited ? 429 : 200).json(failure);
  }

  const ticket = issueTicket({
    // Reuse the canonical Base64-HWID binding for tickets and runtime proof.
    hwidHash: hashBindingId(bindingId),
    scope: 'script',
    userId: userId || null,
    scriptName,
  });
  const claims = verifyTicket(ticket);

  // Hand the client two things it has to work with before it may proceed:
  //  * hop    — a one-time id that /api/script must burn
  //  * A, B   — linear transforms of a secret integer; the answer is Equate(x)
  const equation = createEquationChallenge();
  const hop = issueHop(claims.jti, { answer: equation.answer, hwidHash: claims.hwidHash });

  const response = {
    valid: true,
    ticket,
    k: xorKey,
    hop,
    A: equation.a,
    B: equation.b,
  };
  if (clientChallenge.ok) response.check = createChallengeResponse(clientChallenge.values);
  return res.status(200).json(response);
}

// ═══ /api/script ═══
async function handleScript(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { ticket, Data, scriptName, hop, eq } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ Valid: false, reason: 'ticket required' });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ Valid: false, reason: 'invalid ticket' });

  const device = deviceMatches(req, payload.hwidHash, req.body?.c ?? req.body?.hwid);
  if (!device.ok)
    return res.status(403).json({ Valid: false, reason: clientDeviceMessage(device.reason) });

  // One-time hop from /api/verify: proves this request follows a real
  // verification instead of replaying a captured ticket.
  const hopEntry = consumeHop(hop, payload.jti);
  if (!hopEntry) {
    noteEvent('script_reject', 'missing or replayed hop');
    return res.status(409).json({ Valid: false, reason: 'hop required' });
  }
  if (!checkEquationAnswer({ answer: hopEntry.answer }, eq)) {
    noteEvent('script_reject', 'equation answer wrong');
    return res.status(409).json({ Valid: false, reason: 'equation rejected' });
  }
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

  const nextHop = issueHop(payload.jti, { hwidHash: payload.hwidHash });

  return res.status(200).json(encodeProtectedPayload({
    Valid: true,
    check,
    hop: nextHop,
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
  const body = req.body || {};
  const { ticket, scriptToken, runtimeSecret, scriptName, hop } = body;
  const hwid = body.c ?? body.hwid;

  if (typeof ticket !== 'string' || ticket.length > 4096) {
    return rejectRuntimeVerification(res, 400, 'D2_TICKET_MISSING');
  }

  const payload = verifyTicket(ticket);
  if (!payload) return rejectRuntimeVerification(res, 401, 'D2_TICKET_INVALID');
  if (payload.scope !== 'script') return rejectRuntimeVerification(res, 403, 'D2_TICKET_SCOPE');

  // Resolve HWID before burning the next-step hop so an invalid device
  // request does not make a retried legitimate request look replayed.
  const device = deviceMatches(req, payload.hwidHash, hwid);
  if (!device.ok) {
    const category = BAD_DEVICE_REASONS.has(device.reason)
      ? BAD_HWID_CODE
      : device.reason === 'device mismatch' ? 'D2_DEVICE_BINDING_MISMATCH' : 'D2_DEVICE_INVALID';
    return rejectRuntimeVerification(res, 403, category);
  }
  const clientHwid = device.hwid;

  const banReason = checkRevoked({ hwid: clientHwid, userId: payload.userId });
  if (banReason) return rejectRuntimeVerification(res, 403, 'D2_REVOKED');

  if (typeof runtimeSecret !== 'string' || runtimeSecret.length !== 64) {
    return rejectRuntimeVerification(res, 403, 'D2_SECRET_FORMAT');
  }
  if (!consumeHop(hop, payload.jti)) {
    noteEvent('runtime_reject', 'missing or replayed hop');
    return rejectRuntimeVerification(res, 409, 'D2_HOP_MISSING');
  }

  const proofFailure = verifyRuntimeProof({
    ticketPayload: payload,
    runtimeSecret,
    scriptToken,
    hwidHash: hashBindingId(device.bindingId),
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
  const { ticket, Data, c, hwid } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ kick: null });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ kick: 'Session expired' });

  const device = deviceMatches(req, payload.hwidHash, c ?? hwid);
  if (!device.ok) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: clientDeviceMessage(device.reason) });
  }

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

function verifiedScriptContext(ticket, req, hwid, scriptName, ip) {
  if (typeof ticket !== 'string' || ticket.length > 4096) return { error: 'ticket required', status: 400 };
  const device = hwidFromRequest(req, hwid);
  if (!device.ok) return { error: clientDeviceMessage(device.reason), status: 403 };
  const payload = verifyTicket(ticket);
  if (!payload || payload.scope !== 'script') return { error: 'invalid ticket', status: 401 };
  if (!timingSafeStringEquals(payload.hwidHash, hashBindingId(device.bindingId))) return { error: 'device mismatch', status: 403 };
  const name = typeof scriptName === 'string' && scriptName.length ? scriptName : payload.scriptName;
  if (!isValidScriptName(name) || name !== payload.scriptName) return { error: 'scriptName mismatch', status: 403 };
  const reason = checkRevoked({ hwid: device.hwid, userId: payload.userId, ip });
  if (reason) return { error: 'Banned: ' + reason, status: 403 };
  return { payload, name, hwidHash: hashBindingId(device.bindingId) };
}

async function handleStart(req, res, ip) {
  const body = req.body || {};
  const hwid = body.c ?? body.hwid;
  const device = hwidFromRequest(req, hwid);
  if (!device.ok) return res.status(403).json({ error: clientDeviceMessage(device.reason) });

  const reason = checkRevoked({ hwid: device.hwid, ip });
  if (reason)
    return res.status(403).json({ error: 'Banned: ' + reason });

  try {
    const result = await createLink(device.bindingId);
    return res.status(result.rateLimited ? 429 : 200).json(result);
  } catch (err) {
    console.error('[start]', err.message);
    return res.status(502).json({ error: 'Could not create link' });
  }
}

// ═══ /api/admin/ban ═══
async function handleAdminBan(req, res) {
  if (!hasAdminAccess(req)) return res.status(401).json({ error: 'unauthorized' });

  const { type, value } = req.body || {};
  if (typeof value !== 'string' || value.length < 1 || value.length > 512)
    return res.status(400).json({ error: 'invalid value' });

  switch (type) {
    case 'hwid': revokeHwid(value); break;
    case 'hwidHash':
      if (!/^[a-f0-9]{64}$/i.test(value)) return res.status(400).json({ error: 'invalid hash' });
      revokeHwidHash(value);
      break;
    case 'key': revokeKey(value); break;
    case 'keyHash':
      if (!/^[a-f0-9]{64}$/i.test(value)) return res.status(400).json({ error: 'invalid hash' });
      revokeKeyHash(value);
      break;
    case 'user': revokeUser(value); break;
    case 'ip':   revokeIp(value);   break;
    default: return res.status(400).json({ error: 'invalid type' });
  }

  return res.status(200).json({
    ok: true, type,
    value: type === 'key'
      ? `sha256:${crypto.createHash('sha256').update(value.trim()).digest('hex').slice(0, 12)}`
      : value.slice(0, 20) + (value.length > 20 ? '...' : ''),
    stats: stats(),
  });
    }
