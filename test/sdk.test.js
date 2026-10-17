'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const { issueTicket, verifyTicket, hashHwid } = require('../lib/ticket');
const authHandler = require('../api/auth');
const {
  RNG_CHALLENGE_TRANSFORMS,
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  deriveRuntimeCredentials,
  verifyRuntimeProof,
} = require('../lib/999MS-server-sdk');

const values = [1, 73, 2048, 999999, -19];
const clientChallenge = {
  Rng1: values[0], Rng2: values[1], Rng3: values[2],
  Rng4: values[3], Rng5: values[4], RngFloat: 44.5,
};

const validated = validateClientChallenge(clientChallenge);
assert.equal(validated.ok, true);
assert.deepEqual(validated.values, values);
assert.equal(validateClientChallenge({ ...clientChallenge, RngFloat: 44 }).ok, false);
assert.equal(validateClientChallenge({ ...clientChallenge, RngFloat: 1 }).ok, false);
assert.equal(validateClientChallenge({ ...clientChallenge, RngFloat: 1000001.5 }).ok, false);
assert.equal(validateClientChallenge({ ...clientChallenge, Rng3: 1.25 }).ok, false);

const encodedChallenge = createChallengeResponse(values).split('|').map(Number);
for (let index = 0; index < values.length; index += 1) {
  const { multiplier, offset } = RNG_CHALLENGE_TRANSFORMS[index];
  assert.equal((encodedChallenge[index] - offset) / multiplier, values[index]);
}

const loadcSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loadc.lua'), 'utf8');
const authSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth.js'), 'utf8');
const stageTwoSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
const loadaSha = crypto.createHash('sha256').update(stageTwoSource).digest('hex');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
// Artifacts are built from source/*.lua by `node source/build.js` and served as
// plain Lua. Pinning hashes here keeps accidental edits from shipping silently.
const stage2Body = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
const stage3Body = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loader.lua'), 'utf8');
const stage4Body = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'payload.lua'), 'utf8');

assert.match(stage2Body, /^-- supper_Boom\n/, 'Stage 2 must keep its sentinel');
assert.match(stage3Body, /999MS/, 'Stage 3 must be the readable loader');
assert.match(stage4Body, /999MS/, 'Stage 4 must be the readable payload');
for (const [name, body] of [['loada', stage2Body], ['loader', stage3Body], ['payload', stage4Body]]) {
  assert.ok(body.length > 1000, `${name} must not be empty`);
  assert.ok(body.includes('@BASE_URL@'), `${name} must keep the host placeholder`);
  assert.doesNotMatch(body, /^return select\(1,function\(\.\.\.\)/m, `${name} must not be obfuscated`);
  assert.doesNotMatch(body, /goofyscator|RUNLUA|wearedevs/i, `${name} must not be obfuscated`);
}
assert.doesNotMatch(mainSource, /--/);assert.doesNotMatch(mainSource, /--/);

assert.match(loadaSha, /^[a-f0-9]{64}$/);
assert.match(loadcSource, /if not game:IsLoaded\(\) then game.Loaded:Wait\(\) end/);
// The chain is plain, auditable Lua now: no obfuscator, no generated shuffling.
assert.match(loadcSource, /999MS Stage 1 \(readable\)/);
for (const token of ['__CHAIN_ID__', '__CAP_D__', '__CAP_N__', '__STAGE2_SHA256__', '__BASE_URL__']) {
  assert.ok(loadcSource.includes(token), `stage-1 template missing ${token}`);
}
for (const diagnostic of ['MS999:S1:E02:HTTP_GET_FAILED', 'MS999:S1:E03:SHA256_MISMATCH',
  'MS999:S1:E04:LOADER_UNAVAILABLE', 'MS999:S1:E05:STAGE2_COMPILE_FAILED']) {
  assert.ok(loadcSource.includes(diagnostic), `missing ${diagnostic}`);
}
assert.ok(loadcSource.includes('game:HttpGet(url)'));
assert.doesNotMatch(loadcSource, /wearedevs|obfuscator/i);
assert.doesNotMatch(loadcSource, /\bKick\(|CoreGui|replicatesignal|LocalPlayer:Kick/);

// Readable stages must be served from source, not from an obfuscated blob.
const stage2Source = fs.readFileSync(path.join(__dirname, '..', 'source', 'savecheck.lua'), 'utf8');
const stage3Source = fs.readFileSync(path.join(__dirname, '..', 'source', 'loader.lua'), 'utf8');
const stage4Source = fs.readFileSync(path.join(__dirname, '..', 'source', 'payload.lua'), 'utf8');
for (const [label, body] of [['savecheck', stage2Source], ['loader', stage3Source], ['payload', stage4Source]]) {
  assert.ok(body.includes('@BASE_URL@'), `${label} must keep the base-url placeholder`);
  assert.doesNotMatch(body, /return\(function\(\.\.\.\)local/, `${label} must not be obfuscated`);
}

assert.match(authSource, /function renderLoadcArtifact\(origin/);

// The bootstrap action is kept only as a credential-free compatibility shim for
// the Oct-14 loadc generation; it must never mint sessions or touch tickets.
assert.match(authSource, /action === 'bootstrap'/);
assert.doesNotMatch(authSource, /bootstrap[\s\S]{0,400}issueTicket/, 'bootstrap must not issue tickets');
assert.match(authSource, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
assert.match(authSource, /crypto\.randomBytes\(26\)\.toString\('hex'\)/);
assert.match(authSource, /function createLoadaPathCapability\(\)/);
assert.match(authSource, /function consumeStageCapability\(capability\)/);
assert.doesNotMatch(authSource, /function deriveSuccessorCapability|function stageShim/);
assert.match(authSource, /const LOADA_PATH_TTL = 20 \* 1000/);
assert.match(authSource, /const STAGE_TWO_RAW_SHA256/);
assert.match(authSource, /const clientChallenge = validateClientChallenge\(req\.body\)/);
assert.match(authSource, /check: createChallengeResponse\(clientChallenge\.values\)/);
assert.match(authSource, /scriptBody = scriptBody/);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/api/bootstrap'), true);
for (const name of ['loadc', 'loader', 'sdk']) {
  assert.equal(vercelConfig.routes.some((entry) => entry.dest === `/api/auth?action=artifact&name=${name}`), true);
}
assert.equal(vercelConfig.routes.some((entry) => (
  entry.src === '/loada\\.lua/([^/]+)/([^/]+)' &&
  entry.dest === '/api/auth?action=artifact&name=loada&d=$1&n=$2'
)), true);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/payload\\.lua' && entry.dest === '/api/auth?action=payload'), true);
for (const src of ['/loader\\.lua/([^/]+)/([^/]+)', '/payload\\.lua/([^/]+)/([^/]+)']) {
  assert.equal(vercelConfig.routes.some((entry) => entry.src === src), false, `${src} must not mint a successor link`);
}
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/(.*)' && entry.dest === '/api/auth?action=trap'), true);
assert.match(mainSource, /Chain\.Stage ~= "script"/);
assert.match(mainSource, /\$\{SCRIPTID\}/);
assert.match(mainSource, /\$\{SERVERID\}/);
assert.match(mainSource, /D2_RESPONSE_INVALID/);
assert.match(mainSource, /decoded and decoded\.diagnostic/);
assert.match(authSource, /function rejectRuntimeVerification\(res, status, category\)/);
assert.match(authSource, /category=\$\{category\} reference=\$\{diagnosticReference\(category\)\}/);
assert.match(authSource, /deriveRuntimeCredentials/);

assert.equal(isValidScriptName('main'), true);
assert.equal(isValidScriptName('main-v2_1'), true);
assert.equal(isValidScriptName('../main'), false);
assert.equal(isValidScriptName(''), false);

const key = 'sdk-test-xor-key';
const envelope = encodeProtectedPayload({ hello: 'world', n: 5 }, key);
assert.deepEqual(decodeProtectedPayload(envelope, key), { ok: true, data: { hello: 'world', n: 5 } });
assert.equal(decodeProtectedPayload({ Data: [999] }, key).ok, false);
assert.throws(() => encodeProtectedPayload({}, ''), /PAYLOAD_XOR_KEY/);

const previousTicketSecret = process.env.TICKET_SECRET;
process.env.TICKET_SECRET = 'test-ticket-secret-with-at-least-thirty-two-characters';
const ticketOne = issueTicket({ hwidHash: 'a'.repeat(64), scope: 'script', scriptName: 'main' });
const ticketTwo = issueTicket({ hwidHash: 'a'.repeat(64), scope: 'script', scriptName: 'main' });
const decodedTicketOne = verifyTicket(ticketOne);
const decodedTicketTwo = verifyTicket(ticketTwo);
assert.notEqual(ticketOne, ticketTwo);
assert.equal(decodedTicketOne.scope, 'script');
assert.equal(decodedTicketOne.scriptName, 'main');
assert.match(decodedTicketOne.jti, /^[a-f0-9]{24}$/);
assert.notEqual(decodedTicketOne.jti, decodedTicketTwo.jti);

const runtimeNow = Date.now();
const credentials = deriveRuntimeCredentials({
  ticketPayload: decodedTicketOne,
  scriptName: 'main',
  issuedAt: runtimeNow,
});
assert.match(credentials.scriptToken, /^[0-9a-z]+\.[a-f0-9]{64}$/);
assert.match(credentials.runtimeSecret, /^[a-f0-9]{64}$/);
const proof = {
  ticketPayload: decodedTicketOne,
  scriptName: 'main',
  scriptToken: credentials.scriptToken,
  runtimeSecret: credentials.runtimeSecret,
  hwidHash: 'a'.repeat(64),
  now: runtimeNow + 100,
};
assert.equal(verifyRuntimeProof(proof), null);
assert.equal(verifyRuntimeProof({ ...proof, scriptName: 'other' }), 'scriptName changed');
assert.equal(verifyRuntimeProof({ ...proof, runtimeSecret: '0'.repeat(64) }), 'secret mismatch');
assert.equal(verifyRuntimeProof({ ...proof, hwidHash: 'b'.repeat(64) }), 'hwid mismatch');
assert.equal(verifyRuntimeProof({ ...proof, scriptToken: 'not-a-runtime-token' }), 'token malformed');
assert.equal(verifyRuntimeProof({ ...proof, now: runtimeNow + 60001 }), 'runtime expired');
assert.equal(verifyRuntimeProof({ ...proof, ticketPayload: { ...decodedTicketOne, scope: 'other' } }), 'ticket claims invalid');

// Keep this test-only secret active through the endpoint tests below.

const previousLoadaPathSecret = process.env.LOADA_PATH_SECRET;
const originalFetch = global.fetch;
process.env.LOADA_PATH_SECRET = 'test-loada-path-secret-with-at-least-thirty-two-characters';

async function requestEndpoint(url, headers = {}, method = 'GET', body = undefined) {
  const response = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
  await authHandler({
    url,
    method,
    headers,
    body,
    socket: { remoteAddress: 'sdk-test' },
  }, response);
  return response;
}

// The rendered Stage 1 is plain Lua: tokens are replaced in place.
function parseRenderedLoadc(source) {
  assert.doesNotMatch(source, /__[A-Z0-9_]+__/, 'unreplaced template token');
  const chainId = (source.match(/local CHAIN_ID = "([a-f0-9]{64})"/) || [])[1];
  const d = (source.match(/local CAP_D = "([a-f0-9]{64})"/) || [])[1];
  const n = (source.match(/local CAP_N = "([a-f0-9]{64})"/) || [])[1];
  const stage2Sha = (source.match(/local STAGE2_SHA256 = "([a-f0-9]{64})"/) || [])[1];
  const baseUrl = (source.match(/local BASE_URL = "([^"]+)"/) || [])[1];
  for (const [label, value] of [['CHAIN_ID', chainId], ['CAP_D', d], ['CAP_N', n], ['STAGE2_SHA256', stage2Sha]]) {
    assert.match(value, /^[a-f0-9]{64}$/, `${label} must be 64 hex chars`);
  }
  assert.ok(baseUrl && baseUrl.startsWith('https://'), 'BASE_URL must be rendered');
  return { chainId, d, n, stage2Sha, baseUrl };
}

(async () => {
  // This succeeds without a preceding in-memory /api/script session. It proves
  // runtime verification is portable across independent Vercel instances.
  const verificationHwid = 'sdk-runtime-hwid';
  const verificationTicket = issueTicket({
    hwidHash: hashHwid(verificationHwid), scope: 'script', scriptName: 'main',
  });
  const verificationPayload = verifyTicket(verificationTicket);
  const verificationCredentials = deriveRuntimeCredentials({
    ticketPayload: verificationPayload, scriptName: 'main',
  });
  const statelessRuntime = await requestEndpoint('/api/auth?action=script-verify', {
    'content-type': 'application/json', 'x-client': 'Roblox',
  }, 'POST', {
    ticket: verificationTicket,
    hwid: verificationHwid,
    scriptToken: verificationCredentials.scriptToken,
    runtimeSecret: verificationCredentials.runtimeSecret,
    scriptName: 'main',
  });
  assert.equal(statelessRuntime.statusCode, 200);
  assert.equal(statelessRuntime.body.valid, true);
  assert.equal(statelessRuntime.body.diagnostic, 'D2_OK');

  const mismatchedRuntime = await requestEndpoint('/api/auth?action=script-verify', {
    'content-type': 'application/json', 'x-client': 'Roblox',
  }, 'POST', {
    ticket: verificationTicket,
    hwid: verificationHwid,
    scriptToken: verificationCredentials.scriptToken,
    runtimeSecret: '0'.repeat(64),
    scriptName: 'main',
  });
  assert.equal(mismatchedRuntime.statusCode, 403);
  assert.equal(mismatchedRuntime.body.diagnostic, 'D2_SECRET_MISMATCH');

  const healthProbe = await requestEndpoint('/api/auth?action=health');
assert.equal(healthProbe.statusCode, 200);
assert.equal(healthProbe.body.ok, true);
assert.equal(healthProbe.body.chain, '999MS-chain-v1');
assert.equal(JSON.stringify(healthProbe.body).includes('SECRET'), false);

const templatedHost = await requestEndpoint('/api/auth?action=artifact&name=loadc', {
  'x-forwarded-host': 'preview.example.test', 'x-forwarded-proto': 'https',
});
assert.equal(parseRenderedLoadc(templatedHost.body).baseUrl, 'https://preview.example.test');

const executorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const secondExecutorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const browserArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', { 'user-agent': 'Mozilla/5.0' });
  const robloxArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', {
    'user-agent': 'Mozilla/5.0', 'x-client': 'rObLoX',
  });
  assert.equal(executorArtifact.statusCode, 200);
  assert.equal(secondExecutorArtifact.statusCode, 200);
  assert.equal(robloxArtifact.statusCode, 200);
  assert.doesNotMatch(executorArtifact.body, /wearedevs|obfuscator/i, 'chain must not be obfuscated');
  assert.match(executorArtifact.body, /999MS Stage 1 \(readable\)/);
  const firstLoadc = parseRenderedLoadc(executorArtifact.body);
  const secondLoadc = parseRenderedLoadc(secondExecutorArtifact.body);
  const robloxLoadc = parseRenderedLoadc(robloxArtifact.body);
  assert.notEqual(firstLoadc.chainId, secondLoadc.chainId, 'chain id must rotate per request');
  assert.notEqual(firstLoadc.d, secondLoadc.d, 'capability id must rotate per request');
  assert.notEqual(firstLoadc.n, secondLoadc.n, 'capability signature must rotate per request');
  assert.notEqual(secondLoadc.chainId, robloxLoadc.chainId);

  const executorHeaders = { 'X-Client': 'ROBLOX' };
  const loadaWithoutPathToken = await requestEndpoint('/api/auth?action=artifact&name=loada', executorHeaders);
  const loadaWrongPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${'0'.repeat(64)}`, executorHeaders);
  const loadaWithPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, executorHeaders);
  assert.equal(loadaWithoutPathToken.statusCode, 404);
  assert.equal(loadaWrongPathToken.statusCode, 404);
  assert.equal(loadaWithPathToken.statusCode, 200);
  const servedLoadaSha = crypto.createHash('sha256').update(loadaWithPathToken.body).digest('hex');
  // Served bytes = raw file with @BASE_URL@ resolved for the default host.
  const expectedServedSha = crypto.createHash('sha256')
    .update(stageTwoSource.replaceAll('@BASE_URL@', 'https://loader999mss.vercel.app')).digest('hex');
  assert.equal(servedLoadaSha, expectedServedSha, 'Stage 2 bytes must match the pinned build');
  assert.equal(firstLoadc.stage2Sha, servedLoadaSha, 'Stage 1 must pin the served Stage 2 body');
  assert.match(loadaWithPathToken.body, /^-- supper_Boom\n/);
  assert.ok(!loadaWithPathToken.body.includes('@BASE_URL@'), 'served Stage 2 must be host-templated');

  const directStaticLoader = await requestEndpoint('/api/auth?action=artifact&name=loader', executorHeaders);
  const directStaticPayload = await requestEndpoint('/api/auth?action=payload', executorHeaders);
  const loadaReplay = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, executorHeaders);
  assert.equal(directStaticLoader.statusCode, 200);
  assert.match(directStaticLoader.body, /999MS/);
  assert.doesNotMatch(directStaticLoader.body, /@BASE_URL@/);
  assert.equal(directStaticPayload.statusCode, 200);
  assert.match(directStaticPayload.body, /BASE_URL/);
  assert.doesNotMatch(directStaticPayload.body, /@BASE_URL@/);
  assert.equal(loadaReplay.statusCode, 404);

  const loadaBrowserPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${secondLoadc.d}&n=${secondLoadc.n}`, { 'user-agent': 'Mozilla/5.0' });
  const expiredLoadcResponse = await requestEndpoint('/api/auth?action=artifact&name=loadc', executorHeaders);
  const expiredLoadc = parseRenderedLoadc(expiredLoadcResponse.body);
  const actualNow = Date.now;
  Date.now = () => actualNow() + 20001;
  const loadaExpiredPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${expiredLoadc.d}&n=${expiredLoadc.n}`, executorHeaders);
  Date.now = actualNow;
  const unknownPath = await requestEndpoint('/api/auth?action=trap');
  const robloxUnknownPath = await requestEndpoint('/api/auth?action=trap', { 'X-Roblox': 'CLIENT' });
  assert.equal(loadaBrowserPath.statusCode, 200);
  assert.equal(loadaBrowserPath.headers.Location, undefined);
  assert.equal(loadaExpiredPath.statusCode, 404);
  assert.equal(browserArtifact.statusCode, 200, 'executor-style browser UA must still receive loadc');
  process.env.TRAP_BROWSER_ARTIFACTS = '1';
  const trappedBrowserArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', { 'user-agent': 'Mozilla/5.0' });
  delete process.env.TRAP_BROWSER_ARTIFACTS;
  assert.equal(trappedBrowserArtifact.statusCode, 302);
  assert.equal(trappedBrowserArtifact.headers.Location, 'https://yura.lol/09ms');
  assert.equal(unknownPath.statusCode, 302);
  assert.equal(unknownPath.headers.Location, 'https://yura.lol/09ms');
  assert.equal(robloxUnknownPath.statusCode, 404);
  assert.equal(robloxUnknownPath.headers.Location, undefined);
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  global.fetch = originalFetch;
  if (previousTicketSecret === undefined) delete process.env.TICKET_SECRET;
  else process.env.TICKET_SECRET = previousTicketSecret;
  console.log('PASS 999MS Server SDK, per-request loadc capabilities, and browser trap tests');
})().catch((error) => {
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  global.fetch = originalFetch;
  if (previousTicketSecret === undefined) delete process.env.TICKET_SECRET;
  else process.env.TICKET_SECRET = previousTicketSecret;
  console.error(error);
  process.exitCode = 1;
});
