'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const { issueTicket, verifyTicket } = require('../lib/ticket');
const authHandler = require('../api/auth');
const {
  RNG_CHALLENGE_TRANSFORMS,
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  createRuntimeCredentials,
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
assert.equal(validateClientChallenge({ ...clientChallenge, Rng3: 1.25 }).ok, false);

const encodedChallenge = createChallengeResponse(values).split('|').map(Number);
for (let index = 0; index < values.length; index += 1) {
  const { multiplier, offset } = RNG_CHALLENGE_TRANSFORMS[index];
  assert.equal((encodedChallenge[index] - offset) / multiplier, values[index]);
}

const expectedTransforms = RNG_CHALLENGE_TRANSFORMS.map(({ multiplier, offset }) => [multiplier, offset]);
const clientSdkSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', '999MS-sdk.lua'), 'utf8');
const clientSdkTransforms = [...clientSdkSource.matchAll(
  /\{ multiplier = (-?\d+), offset = (-?\d+) \}/g,
)].map((match) => [Number(match[1]), Number(match[2])]);
assert.deepEqual(clientSdkTransforms, expectedTransforms);

const payloadSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'payload.lua'), 'utf8');
const multipliers = payloadSource.match(/local ChallengeMultipliers = \{ ([^}]+) \}/)[1]
  .split(',').map((value) => Number(value.trim()));
const offsets = payloadSource.match(/local ChallengeOffsets = \{ ([^}]+) \}/)[1]
  .split(',').map((value) => Number(value.trim()));
assert.deepEqual(multipliers.map((value, index) => [value, offsets[index]]), expectedTransforms);

const loadcSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loadc.lua'), 'utf8');
const authSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth.js'), 'utf8');
const stageTwoSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
const loadaSha = crypto.createHash('sha256').update(stageTwoSource).digest('hex');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loader.lua'), 'utf8');
const payloadLuaSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'payload.lua'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
assert.equal(loadaSha, '2106087f620508dcc5e3460edf3974cf81282b81795a102d85e9ae809c78a0df');
assert.equal(loadcSource.includes('\n'), false);
assert.match(loadcSource, /local d="__LOADA_D__"/);
assert.match(loadcSource, /local n="__LOADA_N__"/);
assert.match(loadcSource, /local i="__CHAIN_ID__"/);
assert.match(loadcSource, /local u=b\.\."\/loada\.lua\/"\.\.d\.\."\/"\.\.n/);
assert.doesNotMatch(loadcSource, /api\/bootstrap|game:HttpGet|X-999MS-Token/);
assert.match(loadcSource, new RegExp(`local h=\\"${loadaSha}\\"`));
assert.doesNotMatch(loadcSource, /LOADA_ARTIFACT_TOKEN|dae7f78cb31c846b50b01d3866ff0f2266d08ee89453ed6aea20eea46131ae6b/);
assert.match(loadcSource, /e\.MS999Chain=nil/);
assert.doesNotMatch(loadcSource, /\bKick\(|CoreGui|replicatesignal|LocalPlayer:Kick/);
assert.match(loadcSource, /error\(\"Loader artifact unavailable\",0\)/);
assert.match(loadcSource, /error\(\"Loader artifact integrity failed\",0\)/);
assert.match(loadcSource, /return f\(c,\.\.\.\)/);
assert.match(authSource, /function renderLoadcArtifact\(\)/);
assert.doesNotMatch(authSource, /action === 'bootstrap'|handleBootstrap/);
assert.match(authSource, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
assert.match(authSource, /crypto\.randomBytes\(26\)\.toString\('hex'\)/);
assert.match(authSource, /function createLoadaPathCapability\(\)/);
assert.match(authSource, /const LOADA_PATH_TTL = 20 \* 1000/);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/api/bootstrap'), false);
for (const name of ['loadc', 'loader', 'sdk']) {
  assert.equal(vercelConfig.routes.some((entry) => entry.dest === `/api/auth?action=artifact&name=${name}`), true);
}
assert.equal(vercelConfig.routes.some((entry) => (
  entry.src === '/loada\\.lua/([^/]+)/([^/]+)' &&
  entry.dest === '/api/auth?action=artifact&name=loada&d=$1&n=$2'
)), true);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/(.*)' && entry.dest === '/api/auth?action=trap'), true);
assert.match(stageTwoSource, /^-- supper_Boom\n/);
assert.match(loaderSource, /chainIs\("stage2", CHAIN_TTL\)/);
assert.match(loaderSource, /Chain\.Stage = "loader"/);
assert.match(payloadLuaSource, /chainIs\("loader", CHAIN_TTL\)/);
assert.match(payloadLuaSource, /Chain\.Stage = "payload"/);
assert.match(payloadLuaSource, /Chain\.Stage = "script"/);
assert.match(mainSource, /Chain\.Stage ~= "script"/);
assert.match(loaderSource, /local Stage2WriteMonitor = getgenv\(\)\.MS999WriteMonitor/);
assert.match(loaderSource, /RealWriteFile = type\(Stage2WriteMonitor\) == "function" and Stage2WriteMonitor/);
assert.match(payloadLuaSource, /local Stage2WriteMonitor = getgenv\(\)\.MS999WriteMonitor/);
assert.match(payloadLuaSource, /RealWriteFile = type\(Stage2WriteMonitor\) == "function" and Stage2WriteMonitor or writefile/);

assert.equal(isValidScriptName('main'), true);
assert.equal(isValidScriptName('main-v2_1'), true);
assert.equal(isValidScriptName('../main'), false);
assert.equal(isValidScriptName(''), false);

const key = 'sdk-test-xor-key';
const envelope = encodeProtectedPayload({ hello: 'world', n: 5 }, key);
assert.deepEqual(decodeProtectedPayload(envelope, key), { ok: true, data: { hello: 'world', n: 5 } });
assert.equal(decodeProtectedPayload({ Data: [999] }, key).ok, false);
assert.throws(() => encodeProtectedPayload({}, ''), /PAYLOAD_XOR_KEY/);

const credentials = createRuntimeCredentials();
const session = {
  createdAt: Date.now(),
  scriptIssuedAt: Date.now(),
  hwidHash: 'a'.repeat(64),
  scriptName: 'main',
  scriptToken: credentials.scriptToken,
  runtimeSecret: credentials.runtimeSecret,
  verified: false,
};
const proof = {
  session,
  scriptName: 'main',
  scriptToken: credentials.scriptToken,
  runtimeSecret: credentials.runtimeSecret,
  hwidHash: 'a'.repeat(64),
};
assert.equal(verifyRuntimeProof(proof), null);
assert.equal(verifyRuntimeProof({ ...proof, scriptName: 'other' }), 'scriptName changed');
assert.equal(verifyRuntimeProof({ ...proof, runtimeSecret: '0'.repeat(64) }), 'secret mismatch');
assert.equal(verifyRuntimeProof({ ...proof, hwidHash: 'b'.repeat(64) }), 'hwid mismatch');
assert.equal(verifyRuntimeProof({ ...proof, session: { ...session, verified: true } }), 'already verified');

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
if (previousTicketSecret === undefined) delete process.env.TICKET_SECRET;
else process.env.TICKET_SECRET = previousTicketSecret;

const previousLoadaPathSecret = process.env.LOADA_PATH_SECRET;
process.env.LOADA_PATH_SECRET = 'test-loada-path-secret-with-at-least-thirty-two-characters';

async function requestEndpoint(url, headers = {}) {
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
    method: 'GET',
    headers,
    socket: { remoteAddress: 'sdk-test' },
  }, response);
  return response;
}

function parseRenderedLoadc(source) {
  const chainId = source.match(/local i="([a-f0-9]{64})"/)[1];
  const d = source.match(/local d="([a-f0-9]{64})"/)[1];
  const n = source.match(/local n="([a-f0-9]{64})"/)[1];
  assert.equal(source.includes('__LOADA_D__'), false);
  assert.equal(source.includes('__LOADA_N__'), false);
  assert.equal(source.includes('__CHAIN_ID__'), false);
  return { chainId, d, n };
}

(async () => {
  const executorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const secondExecutorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const browserArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', { 'user-agent': 'Mozilla/5.0' });
  const robloxArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', {
    'user-agent': 'Mozilla/5.0',
    'x-client': 'rObLoX',
  });
  assert.equal(executorArtifact.statusCode, 200);
  assert.equal(secondExecutorArtifact.statusCode, 200);
  assert.equal(robloxArtifact.statusCode, 200);
  const firstLoadc = parseRenderedLoadc(executorArtifact.body);
  const secondLoadc = parseRenderedLoadc(secondExecutorArtifact.body);
  const robloxLoadc = parseRenderedLoadc(robloxArtifact.body);
  assert.notEqual(firstLoadc.chainId, secondLoadc.chainId);
  assert.notEqual(firstLoadc.d, secondLoadc.d);
  assert.notEqual(firstLoadc.n, secondLoadc.n);
  assert.notEqual(secondLoadc.chainId, robloxLoadc.chainId);

  const loadaWithoutPathToken = await requestEndpoint('/api/auth?action=artifact&name=loada', { 'X-Client': 'ROBLOX' });
  const loadaWrongPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${'0'.repeat(64)}`, { 'X-Client': 'ROBLOX' });
  const loadaHeaderOnly = await requestEndpoint('/api/auth?action=artifact&name=loada', {
    'X-Client': 'ROBLOX',
    'X-999MS-Token': 'legacy-header-token-is-not-used',
  });
  const loadaWithPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, {
    'X-Client': 'ROBLOX',
  });
  const loadaBrowserPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, {
    'user-agent': 'Mozilla/5.0',
  });
  const actualNow = Date.now;
  Date.now = () => actualNow() + 20001;
  const loadaExpiredPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, {
    'X-Client': 'ROBLOX',
  });
  Date.now = actualNow;
  const unknownPath = await requestEndpoint('/api/auth?action=trap');
  const robloxUnknownPath = await requestEndpoint('/api/auth?action=trap', { 'X-Roblox': 'CLIENT' });
  assert.equal(loadaWithoutPathToken.statusCode, 404);
  assert.equal(loadaWrongPathToken.statusCode, 404);
  assert.equal(loadaHeaderOnly.statusCode, 404);
  assert.equal(loadaWithPathToken.statusCode, 200);
  assert.match(loadaWithPathToken.body, /^-- supper_Boom/);
  assert.equal(loadaBrowserPath.statusCode, 302);
  assert.equal(loadaBrowserPath.headers.Location, 'https://yura.lol/09ms');
  assert.equal(loadaExpiredPath.statusCode, 404);
  assert.equal(browserArtifact.statusCode, 302);
  assert.equal(browserArtifact.headers.Location, 'https://yura.lol/09ms');
  assert.equal(unknownPath.statusCode, 302);
  assert.equal(unknownPath.headers.Location, 'https://yura.lol/09ms');
  assert.equal(robloxUnknownPath.statusCode, 404);
  assert.equal(robloxUnknownPath.headers.Location, undefined);
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  console.log('PASS 999MS Server SDK, per-request loadc capabilities, and browser trap tests');
})().catch((error) => {
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  console.error(error);
  process.exitCode = 1;
});
