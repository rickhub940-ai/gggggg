'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const port = 30_000 + (process.pid % 10_000);
const env = {
  ...process.env,
  PORT: String(port),
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  TICKET_SECRET: 'ticket-test-secret-at-least-thirty-two-characters',
  PAYLOAD_XOR_KEY: 'payload-test-key',
  ADMIN_TOKEN: 'admin-ui-test-token-at-least-thirty-two-characters',
  CHAIN_DEBUG: '1',
  CHAIN_LINK_TTL_MS: '10000',
  WEARE_API_TIMEOUT_MS: '4000',
  PLATO_SERVICE_ID: '',
  PLATO_SECRET: '',
};
process.env.TICKET_SECRET = env.TICKET_SECRET;

const { hashBindingId, issueTicket } = require('../lib/ticket');
const { resolveHwid, deviceBindingId } = require('../lib/hwid');
const bindingHash = (hwid) => hashBindingId(deviceBindingId(hwid));
const deviceParts = (hwid) => {
  const encoded = Buffer.from(hwid.trim().toLowerCase(), 'utf8').toString('base64');
  const parts = {};
  for (let index = 1; index <= 5; index += 1) {
    const first = Math.floor((index - 1) * encoded.length / 5);
    const last = Math.floor(index * encoded.length / 5);
    parts[String.fromCharCode(97 + index)] = encoded.slice(first, last);
  }
  return parts;
};
const chainLinks = require('../lib/chainlink');

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
});

function stop() {
  if (!child.killed) child.kill('SIGTERM');
}

let requestCounter = 1;
async function post(pathname, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-roblox-client': 'test',
      'x-forwarded-for': `198.51.100.${requestCounter++}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  // HWID-only binding: the canonical HWID's Base64 representation is stable,
  // while executor fingerprint headers have no effect on the identity.
  const pair = resolveHwid({
    'x-r7q': ' Native-ID ',
    'Syn-Fingerprint': ' Executor-ID-01 ',
  }, 'native-id');
  assert.equal(pair.ok, true);
  assert.equal(pair.hwid, 'Native-ID');
  assert.equal(pair.fingerprint, undefined);
  assert.equal(pair.bindingId, Buffer.from('native-id').toString('base64'));
  assert.equal(resolveHwid({ 'x-ms999-hwid': 'legacy-id' }, 'legacy-id').ok,
    true, 'server can accept already-deployed legacy clients during transition');
  assert.equal(resolveHwid({ 'x-r7q': 'device-A' }, 'device-B').reason,
    'hwid mismatch', 'rejects conflicting explicit HWID values');
  assert.equal(resolveHwid({ 'Syn-Fingerprint': 'Executor-ID-01' }).reason,
    'invalid hwid format', 'fingerprint alone is not a HWID');
  assert.equal(resolveHwid({ 'x-r7q': 'device-A' }, 'device-A').bindingId,
    deviceBindingId('device-A'), 'HWID alone produces the persistent binding');
  assert.equal(resolveHwid({}).reason, 'invalid hwid format',
    'rejects a request without the client getter HWID');
  assert.equal(
    deviceBindingId(' Native-ID '),
    deviceBindingId('native-id'),
    'canonicalization makes equivalent HWIDs stable',
  );
  assert.notEqual(
    deviceBindingId('native-id'),
    deviceBindingId('different-id'),
    'changing the HWID changes the bound identity',
  );
  assert.deepEqual(Object.values(deviceParts('Native-ID')).join(''),
    Buffer.from('native-id').toString('base64'), 'five Base64 request parts reassemble exactly');

  // Platoboost only accepts one identifier; ensure it receives the hash of the
  // case-sensitive Base64 HWID binding, not the plaintext getter value.
  const { verifyKey } = require('../lib/platoboost');
  const oldFetch = global.fetch;
  const oldService = process.env.PLATO_SERVICE_ID;
  const oldSecret = process.env.PLATO_SECRET;
  let providerUrl;
  process.env.PLATO_SERVICE_ID = 'composite-test-service';
  process.env.PLATO_SECRET = 'composite-test-secret';
  global.fetch = async (url) => {
    providerUrl = String(url);
    return { status: 200, json: async () => ({ success: false, message: 'test response' }) };
  };
  try {
    await verifyKey('non-prefix-test-key', pair.bindingId);
  } finally {
    global.fetch = oldFetch;
    if (oldService === undefined) delete process.env.PLATO_SERVICE_ID;
    else process.env.PLATO_SERVICE_ID = oldService;
    if (oldSecret === undefined) delete process.env.PLATO_SECRET;
    else process.env.PLATO_SECRET = oldSecret;
  }
  assert.equal(new URL(providerUrl).searchParams.get('identifier'), hashBindingId(pair.bindingId));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('startup timeout')), 5_000);
    child.stdout.on('data', (data) => {
      if (data.toString().includes('api listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', reject);
  });

  // ── WeAreDevs response shapes ──
  // The documented reply is {"obfuscated": "..."} with no success flag; the
  // live endpoint also sends success:true. Both must be accepted, and an
  // explicit failure must not be.
  const { parsePayload } = require('../lib/obfuscate');
  const luaBody = '--[[ v1.0.0 https://wearedevs.net/obfuscator ]] return ' + 'x'.repeat(120);
  assert.equal(parsePayload(JSON.stringify({ obfuscated: luaBody })), luaBody,
    'accepts the documented reply without a success flag');
  assert.equal(parsePayload(JSON.stringify({ success: true, obfuscated: luaBody })), luaBody);
  assert.equal(parsePayload(JSON.stringify({ success: false, obfuscated: luaBody })), null);
  assert.equal(parsePayload(luaBody), luaBody, 'accepts a plain Lua body');
  assert.equal(parsePayload('{"error":"nope"}'), null, 'rejects an unexpected payload');

  // ── health ──
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, '999MS');
  assert.equal(healthBody.realtime, undefined, 'health must not advertise realtime');

  // `/api/start` uses the same five-part HWID-only Base64 transport.
  const startWithoutHwid = await post('/api/q', { p: 'k8' },
    { 'syn-fingerprint': 'syn-device-01' });
  assert.equal(startWithoutHwid.status, 400);
  assert.equal((await startWithoutHwid.json()).error, 'invalid hwid format');
  const startWithHwid = await post('/api/q', { p: 'k8', ...deviceParts('Start-HWID') });
  assert.equal(startWithHwid.status, 502,
    'HWID alone reaches Platoboost; empty test provider credentials cause the expected provider failure');

  // ── the realtime/WebSocket surface is gone ──
  for (const gone of ['/admin', '/api/realtime-ticket', '/api/realtime/sessions',
    '/api/realtime/command', '/api/session-renew']) {
    const get = await fetch(`http://127.0.0.1:${port}${gone}`, { redirect: 'manual' });
    assert.ok(get.status >= 300 || get.status === 404, gone + ' must be gone, got ' + get.status);
    const posted = await post(gone, {});
    assert.ok(posted.status >= 300 || posted.status === 404, gone + ' POST must be gone, got ' + posted.status);
  }

  // ── control panel API (HTTP only) ──
  const denied = await post('/api/control/bans', {});
  assert.equal(denied.status, 401);
  const bans = await post('/api/control/bans', {}, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(bans.status, 200);
  const bansBody = await bans.json();
  assert.equal(bansBody.ok, true);
  assert.equal(typeof bansBody.stats.hwids, 'number');

  const traffic = await post('/api/control/traffic', { limit: 5 }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(traffic.status, 200);
  assert.equal(Array.isArray((await traffic.json()).traffic), true);

  const removedControl = await post('/api/control/sessions', {}, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.ok(removedControl.status >= 300 || removedControl.status === 404);

  // ── ban enforcement ──
  const banned = await post('/api/admin/ban', { type: 'hwid', value: 'banned-hwid' }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(banned.status, 200);
  const bannedVerify = await post('/api/verify', { key: 'KEY_TEST', c: 'banned-hwid', scriptName: 'main' });
  assert.equal(bannedVerify.status, 403);

  // ── key revocation is opt-in and does not block unrelated keys ──
  const keyToRevoke = 'KEY_ADMIN_REVOKE_TEST';
  const revokeKeyResponse = await post('/api/admin/ban', { type: 'key', value: keyToRevoke },
    { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(revokeKeyResponse.status, 200);
  const revokeKeyBody = await revokeKeyResponse.json();
  assert.ok(!revokeKeyBody.value.includes(keyToRevoke), 'admin response must not echo a raw key');
  const revokedKeyVerify = await post('/api/verify', {
    key: keyToRevoke, c: 'revoked-key-test-hwid', scriptName: 'main',
  });
  assert.equal(revokedKeyVerify.status, 200);
  assert.equal((await revokedKeyVerify.json()).valid, false);

  // ── regression: payload-style /api/verify without RNG still reaches key checks ──
  const payloadStyleVerify = await post('/api/verify', {
    key: 'KEY_TEST', c: 'api-test-hwid', scriptName: 'main', userId: '7',
  });
  const payloadStyleBody = await payloadStyleVerify.json().catch(() => ({}));
  assert.notEqual(payloadStyleBody.error, 'RNG integers rejected',
    'payload-style /api/verify must reach key verification');

  const forgedVerify = await post('/api/verify', {
    key: 'KEY_TEST', c: 'api-test-hwid', scriptName: 'main',
    Rng1: 1.5, Rng2: 1, Rng3: 1, Rng4: 1, Rng5: 1, RngFloat: 2,
  });
  assert.equal(forgedVerify.status, 400);
  assert.equal((await forgedVerify.json()).error, 'RNG integers rejected');

  const opaqueVerify = await post('/api/q', {
    p: 'q7', a: 'KEY_TEST', ...deviceParts('api-test-hwid'),
    g: 'main', h: '7', i: 1.5, j: 1, k: 1, l: 1, m: 1, n: 2,
  });
  assert.equal(opaqueVerify.status, 400);
  assert.equal((await opaqueVerify.json()).error, 'RNG integers rejected',
    'opaque request aliases are decoded before the existing RNG validation');

  // ── ticket flow still works without realtime ──
  const hwid = 'api-test-hwid';
  const ticket = issueTicket({ scope: 'script', hwidHash: bindingHash(hwid), userId: '7', scriptName: 'main' });
  const opaqueScript = await post('/api/q', {
    p: 'm2', a: ticket, ...deviceParts(hwid), g: 'main', o: [], q: '', r: 1,
  });
  assert.equal(opaqueScript.status, 409);
  assert.equal((await opaqueScript.json()).reason, 'hop required',
    'opaque script action reassembles and checks the HWID parts');

  const script = await post('/api/q', {
    p: 'x9', a: ticket, ...deviceParts(hwid), g: 'main', q: '',
    s: 'y'.repeat(64), t: 'x',
  }, { 'syn-fingerprint': 'different-executor-fingerprint' });
  assert.equal(script.status, 409, 'a missing hop is rejected before the proof check');
  assert.equal((await script.json()).diagnostic, 'D2_HOP_MISSING',
    'fingerprint changes do not affect the HWID-only ticket binding');

  // A fingerprint header cannot substitute for a missing HWID.
  const fingerprintOnlyRuntime = await post('/api/q', {
    p: 'x9', a: ticket, g: 'main', q: '', s: 'y'.repeat(64), t: 'x',
  }, { 'syn-fingerprint': 'syn-device-01' });
  assert.equal(fingerprintOnlyRuntime.status, 403);
  assert.equal((await fingerprintOnlyRuntime.json()).diagnostic, 'D2_HWID_FORMAT',
    'fingerprint is ignored and cannot provide the client getter HWID');

  const forgedHop = await post('/api/script-verify', {
    ticket, c: hwid, scriptToken: 'x', runtimeSecret: 'y'.repeat(64), scriptName: 'main',
    hop: 'f'.repeat(48),
  });
  assert.equal(forgedHop.status, 409, 'a guessed hop is rejected');

  // ── /api/script refuses a ticket that never came through /api/verify ──
  const noHop = await post('/api/script', { ticket, scriptName: 'main' }, { 'x-r7q': hwid });
  assert.equal(noHop.status, 409, 'script requires a hop issued by verify');

  // ── a ticket is worthless on another device ──
  const otherDevice = await post('/api/script', { ticket, scriptName: 'main' },
    { 'x-r7q': 'a-different-machine' });
  assert.equal(otherDevice.status, 403, 'the ticket is bound to the device that earned it');
  assert.equal((await otherDevice.json()).reason, 'device mismatch');

  const noDevice = await post('/api/script', { ticket, scriptName: 'main' });
  assert.equal(noDevice.status, 403, 'a request without a device is refused');
  assert.equal((await noHop.json()).reason, 'hop required');

  const guessedHop = await post('/api/script', { ticket, scriptName: 'main', hop: 'a'.repeat(48), eq: 1 },
    { 'x-r7q': hwid });
  assert.equal(guessedHop.status, 409, 'a guessed hop is never accepted');
  assert.equal((await guessedHop.json()).reason, 'hop required');

  // The hop/equation primitives are one-time and bound to the ticket.
  const sdk = require('../lib/999MS-server-sdk');
  const jti = 'a'.repeat(24);
  const firstHop = sdk.issueHop(jti, { answer: 42 });
  assert.equal(sdk.consumeHop(firstHop, 'b'.repeat(24)), null, 'hop is bound to its ticket');
  assert.equal(sdk.consumeHop(firstHop, jti).answer, 42, 'hop carries its metadata');
  assert.equal(sdk.consumeHop(firstHop, jti), null, 'a burned hop cannot be reused');
  const eq = sdk.createEquationChallenge();
  assert.equal(sdk.checkEquationAnswer(eq, eq.answer), true);
  assert.equal(sdk.checkEquationAnswer(eq, eq.answer + 1), false);
  assert.equal(sdk.checkEquationAnswer(eq, String(eq.answer)), false);
  const invalid = await post('/api/script-verify', { ticket: 'bad' });
  assert.equal(invalid.status, 401); // malformed ticket is rejected before any proof check

  // ── Stages 2-4 stay plain, readable Lua (only Stage 1 is obfuscated) ──
  // Served stages now require a run token, so readability is checked on the
  // artifacts that the chain hands out.
  for (const file of ['loada', 'loader', 'payload']) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'artifacts', file + '.lua'), 'utf8');
    assert.equal(/WeAreDevs|obfuscate/i.test(body), false, file + ' must stay readable');
    assert.equal(/getgenv|_G\\s*\\./i.test(body), false, file + ' must not use executor-global context');
    assert.ok(body.includes('local '), file + ' keeps plain Lua statements');
  }
  // Without a token the stage routes fall through to the trap.
  for (const file of ['loada', 'loader', 'payload']) {
    const res = await fetch(`http://127.0.0.1:${port}/${file}.lua`, { redirect: 'manual' });
    assert.notEqual(res.status, 200, file + ' must require a run link');
  }

  // ── loader chain must not use executor-global storage ──
  for (const file of ['loadc.template.lua', 'savecheck.lua', 'loader.lua', 'payload.lua']) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'source', file), 'utf8');
    assert.equal(/getgenv|_G\s*\./i.test(body), false, file + ' must use explicit local context');
  }
  const mainForContext = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
  assert.equal(/getgenv|_G\s*\./i.test(mainForContext), false, 'main.lua must not use executor-global context');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'source', 'loadc.template.lua'), 'utf8'), /return chunk\(ctx\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'source', 'savecheck.lua'), 'utf8'), /pcall\(chunk, ctx\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'source', 'loader.lua'), 'utf8'), /pcall\(fn, ctx\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'source', 'payload.lua'), 'utf8'), /HttpRequest, Chain, ctx\)/);
  assert.match(mainForContext, /local Context = K[\s\S]*Context\.chain == Chain/);
  const payloadSource = fs.readFileSync(path.join(__dirname, '..', 'source', 'payload.lua'), 'utf8');
  assert.ok(payloadSource.includes('local StartupError = ""'), 'UI error text uses its own local');
  assert.equal(payloadSource.includes('local E1 = ""'), false, 'UI error text must not shadow RNG helper E1');

  // ── runner-safe failure handling: abort, never kick or deliberately hang ──
  const loaderSources = [
    fs.readFileSync(path.join(__dirname, '..', 'source', 'loadc.template.lua'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'source', 'savecheck.lua'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'source', 'loader.lua'), 'utf8'),
    payloadSource,
    mainForContext,
  ].join('\n');
  assert.equal(/:Kick\s*\(|replicatesignal|SecureCrash|NfCrash/.test(loaderSources), false,
    'client stages must not disconnect a player or use the crash loop');
  assert.equal(/while\s+true\s+do/.test(loaderSources), false,
    'loader and payload stages must not contain unbounded loops');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'source', 'loader.lua'), 'utf8'),
    /if not compileOk or type\(fn\) ~= "function"/);
  assert.equal(payloadSource.includes('local HttpRequest = nil'), false,
    'payload must keep the request API passed by the previous stage');
  assert.ok(payloadSource.includes('add(gethwid)') && payloadSource.includes('add(get_exwid)'),
    'client prefers the executor getters used by the reference client');
  assert.equal(payloadSource.includes('RbxAnalyticsService'), false,
    'client uses the executor getters rather than Roblox ClientId');
  assert.match(payloadSource, /if type\(hwid\) ~= "string" or #hwid < 4/,
    'client requires a valid HWID from its getter');
  assert.match(mainForContext, /if type\(HWID\) ~= "string" or #HWID < 4/,
    'final verifier requires the same client getter HWID');
  assert.match(payloadSource, /local function AddDeviceParts\(out, hwid\)/);
  assert.match(payloadSource, /out\.p, out\.a = "q7", payload\.key/);
  assert.match(payloadSource, /out\.i, out\.j, out\.k = payload\.Rng1, payload\.Rng2, payload\.Rng3/);
  assert.match(payloadSource, /out\.l, out\.m, out\.n = payload\.Rng4, payload\.Rng5, payload\.RngFloat/);
  assert.match(payloadSource, /Url = BASE_URL \.\. "\/api\/q"/);
  assert.match(payloadSource, /Body = EncodeJson\(packed\)/);
  assert.doesNotMatch(payloadSource, /\["x-r7q"\]/, 'plaintext HWID header is not sent');
  assert.match(mainForContext, /local function SplitDevice\(value\)/);
  assert.match(mainForContext, /Url = BASE_URL \.\. "\/api\/q"/);
  assert.match(mainForContext, /p = "x9"/);
  assert.match(mainForContext, /for key, value in pairs\(SplitDevice\(HWID\)\)/);
  assert.doesNotMatch(mainForContext, /headers\["x-r7q"\]/, 'runtime verifier sends only split Base64 parts');
  assert.match(mainForContext, /Body = HttpService:JSONEncode\(body\)/);
  const verifierBody = (mainForContext.match(/local body = \{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.equal(/\b(ticket|hwid|runtimeSecret|scriptToken)\s*=/.test(verifierBody), false,
    'outgoing verifier body uses opaque field names');
  assert.match(mainForContext, /local function Abort\(reason\)/,
    'final verification failures use a non-kicking abort');

  // ── client Lua must not carry any realtime code ──
  const mainLua = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
  assert.equal(/WebSocket|websocket|realtime|Realtime/i.test(mainLua), false,
    'main.lua must not reference the realtime system');

  // ── loader links (somtank-style random namespace + token) ──
  const linkDenied = await post('/api/link', {});
  assert.equal(linkDenied.status, 401);

  const created = await post('/api/link', { scriptName: 'main', hours: 2 }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(created.status, 200);
  const linkBody = await created.json();
  assert.equal(linkBody.ok, true);
  assert.match(linkBody.path, /^\/x\/[a-f0-9]{40}$/, 'link path must be 40 random hex');
  assert.match(linkBody.url, /^http[^?]+\/x\/[a-f0-9]{40}\?at=[0-9a-z]+\.[A-Za-z0-9_-]{32}$/);
  assert.ok(linkBody.line.startsWith('local key = ""\nlocal script = "main"\n'));
  assert.match(linkBody.line, /loadstring\(game:HttpGet\("/);
  assert.match(linkBody.line, /\)\(key, script\)$/);
  assert.match(linkBody.stub, /local key = \"\"[\s\S]*local script = \"main\"[\s\S]*chunk\(key, script\)/);
  assert.match(linkBody.sha256, /^[a-f0-9]{64}$/);
  assert.ok(linkBody.stub.includes(linkBody.url), 'stub carries the link');
  assert.ok(linkBody.stub.includes(linkBody.sha256), 'stub pins the hash');

  const linkPathAndQuery = new URL(linkBody.url).pathname + new URL(linkBody.url).search;
  const linkRes = await fetch(`http://127.0.0.1:${port}${linkPathAndQuery}`, {
    headers: { 'x-roblox-client': 'test' },
  });
  assert.equal(linkRes.status, 200);
  const entry = await linkRes.text();
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(entry).digest('hex'), linkBody.sha256,
    'served entry must hash to the pinned value');
  assert.ok(entry.includes('/loadc.lua'), 'entry hands over to the chain');
  assert.ok(entry.includes('chunk(key, scriptName)'), 'entry forwards positional key and script values');

  const tampered = await fetch(`http://127.0.0.1:${port}${linkBody.path}?at=${'0'.repeat(8)}.${'a'.repeat(32)}`, {
    redirect: 'manual',
  });
  assert.ok(tampered.status >= 300, 'a bad token must not serve the entry');

  const second = await (await post('/api/link', { scriptName: 'main' }, { 'x-admin-token': env.ADMIN_TOKEN })).json();
  assert.notEqual(second.path, linkBody.path, 'every link gets its own random namespace');

  // ── save-detector marker: a fixed literal, styled as the next-hop variable ──
  const STAGE2 = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
  assert.equal(/supper_Boom|super_boom/i.test(STAGE2), false, 'the old literal is gone');
  assert.equal(STAGE2.includes('__CHAIN_MARKER__'), false, 'the marker is not a serve-time token');
  // The next-stage link lives in a one-entry table that the build keeps outside
  // the compacted body, so the name and the link stay readable.
  assert.ok(STAGE2.startsWith('local gamaramam = { "@NEXT@" };'),
    'the header is exactly `local gamaramam = { "<link>" }`');
  const savecheckSource = fs.readFileSync(path.join(__dirname, '..', 'source', 'savecheck.lua'), 'utf8');
  assert.ok(savecheckSource.includes('firstLine:sub(1, #HEAD_LINE) ~= HEAD_LINE'),
    'save detection only accepts the marker at byte zero');
  assert.ok(savecheckSource.includes('local savedLink = firstLine:match'),
    'save detection validates the hand-off URL on the marker line');
  assert.equal(savecheckSource.includes('text:find(HEAD_LINE, 1, true)'), false,
    'save detection must not match marker text buried inside unrelated files');
  assert.ok(STAGE2.includes(`'local gamaramam = { "'`),
    'the save marker is that header line, with the token left out of the needle');
  assert.ok(/gamaramam\s*\[/.test(STAGE2), 'the body reads the table instead of copying it');
  assert.equal((STAGE2.match(/gamaramam/g) || []).length >= 3, true,
    'the name survives compaction');
  assert.equal(STAGE2.includes('\n'), false, 'Stage 2 ships as a single line');
  assert.equal(/NEXT_LINK|local marker/.test(STAGE2), false, 'no descriptive name survives');
  assert.equal(
    require('node:crypto').createHash('sha256').update(STAGE2).digest('hex'),
    fs.readFileSync(path.join(__dirname, '..', 'api', 'auth.js'), 'utf8')
      .match(/STAGE_TWO_RAW_SHA256 = '([a-f0-9]{64})'/)[1],
    'the raw-artifact pin must match artifacts/loada.lua',
  );

  // ── 4-stage chain: bare token links, minted on demand, 10-second window ──
  const TOKEN = /^[a-f0-9]{32}\.[0-9]{13}\.[a-f0-9]{32}$/;
  const loadc1 = await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  });
  const loadc1Body = await loadc1.text();
  assert.equal(loadc1.status, 200);
  assert.equal(loadc1Body.includes('\n'), false, 'Stage 1 ships as a single line');
  assert.ok(['wearedevs', 'local', 'plain'].includes(loadc1.headers.get('x-999ms-obf')),
    'Stage 1 reports how it was obfuscated');
  assert.equal(/loada/.test(loadc1Body), false,
    'Stage 1 does not mention the next artifact by name');
  const stage2Url = loadc1.headers.get('x-999ms-stage2');
  assert.ok(stage2Url, 'debug header carries the Stage-2 link');

  // Every later link is `<base>/<token>` and nothing else.
  const tokenOf = (link) => link.slice(link.lastIndexOf('/') + 1);
  // The same proof the running stage sends: the server derives the nonce from
  // the link itself, so the test can do that too (no shared state needed).
  const proofOf = (link) => chainLinks.fetchProof(chainLinks.deriveNonce(tokenOf(link)), link);
  const openStage = (link) => fetch(link, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roblox-client': 'test' },
    body: JSON.stringify({ p: proofOf(link) }),
  });
  assert.match(tokenOf(stage2Url), TOKEN, 'the Stage-2 link is a bare token');
  assert.equal(stage2Url.replace(tokenOf(stage2Url), ''), `http://127.0.0.1:${port}/`,
    'the link carries no file name or sub-path');

  // A bare GET (game:HttpGet, curl, a browser) gets the trap, not the stage.
  const bareGet = await fetch(stage2Url, { headers: { 'x-roblox-client': 'test' }, redirect: 'manual' });
  assert.notEqual(bareGet.status, 200, 'a plain GET never returns a stage body');

  // Re-mint for the real fetch: the bare GET burned the first link.
  const loadcB = await fetch(`http://127.0.0.1:${port}/loadc.lua`, { headers: { 'x-roblox-client': 'test' } });
  await loadcB.text();
  const stage2UrlB = loadcB.headers.get('x-999ms-stage2');
  assert.ok(stage2UrlB && stage2UrlB !== stage2Url, 'the re-minted link is different');

  const stage2Res = await openStage(stage2UrlB);
  assert.equal(stage2Res.status, 200, 'the minted Stage-2 link opens for a proven fetch');
  const stage2 = await stage2Res.text();
  assert.ok(stage2.length > 500, 'Stage 2 body arrived');
  assert.notEqual((await openStage(stage2UrlB)).status, 200,
    'a burned Stage-2 link is never served twice');

  // ── The next link is minted while serving and embedded in the body ──
  // No lookup endpoint exists: the only way to advance is the link in the body.
  const LINK = /https?:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\.[0-9]{13}\.[a-f0-9]{32}/;
  assert.equal(/stage-pickup/.test(stage2), false, 'Stage 2 names no pickup endpoint');
  const stage3Url = (stage2.match(LINK) || [])[0];
  assert.ok(stage3Url, 'Stage 2 carries a freshly minted Stage-3 link');
  assert.equal(stage3Url.includes('loada') || stage3Url.includes('loader') || stage3Url.includes('payload'),
    false, 'the link does not name its stage');

  const stage3Res = await openStage(stage3Url);
  assert.equal(stage3Res.status, 200, 'Stage 3 link works');
  const stage3 = await stage3Res.text();
  assert.equal(/stage-pickup/.test(stage3), false, 'Stage 3 names no pickup endpoint');
  assert.match(stage3, /^local gamaramam = \{ "[^"]+" \};/,
    'Stage 3 opens with the same readable header');
  assert.notEqual((await openStage(stage3Url)).status, 200,
    'Stage 3 link is single use');

  // Regression: the placeholder must not appear inside the guard that checks
  // for it, otherwise the server writes the URL into its own guard and every
  // run kicks with "Stage link unavailable".
  for (const [label, body] of [['stage 2', stage2], ['stage 3', stage3]]) {
    assert.equal(body.includes('find(' + String.fromCharCode(34) + stage3Url + String.fromCharCode(34)),
      false, label + ' must not embed its next URL inside a find() guard');
    assert.ok(body.includes('find("NEXT@",1,true)') || body.includes('find("NEXT@", 1, true)'),
      label + ' keeps the unresolved-slot guard readable');
  }

  const stage4Url = (stage3.match(LINK) || [])[0];
  assert.ok(stage4Url, 'Stage 3 carries a freshly minted Stage-4 link');
  const stage4Res = await openStage(stage4Url);
  assert.equal(stage4Res.status, 200, 'Stage 4 link works');
  const stage4 = await stage4Res.text();
  assert.ok(stage4.length > 1000, 'payload body arrived');
  assert.equal(LINK.test(stage4), false, 'the payload is the end of the chain');
  assert.equal(new Set([tokenOf(stage2UrlB), tokenOf(stage3Url), tokenOf(stage4Url)]).size, 3,
    'every link in a run is different');

  // The old lookup route is gone.
  const pickupGone = await fetch(
    `http://127.0.0.1:${port}/api/stage-pickup?t=${tokenOf(stage2Url)}&want=loader`,
    { redirect: 'manual' },
  );
  assert.notEqual(pickupGone.status, 200, 'there is no stage-pickup endpoint any more');

  // Two runs never share links, and Stage 1 is re-obfuscated each time.
  const loadc2 = await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  });
  const loadc2Body = await loadc2.text();
  assert.notEqual(loadc2.headers.get('x-999ms-stage2'), stage2Url, 'each run gets fresh links');
  assert.notEqual(loadc2Body, loadc1Body, 'each run is obfuscated again');

  console.log('PASS API without realtime');  console.log('PASS API without realtime');
}

main().then(() => { stop(); process.exit(0); })
  .catch((error) => { console.error(error); stop(); process.exit(1); });
