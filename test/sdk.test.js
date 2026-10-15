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
const goofyscatorClientArtifacts = [
  ['loada', stageTwoSource, true, '1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d'],
  ['sdk', fs.readFileSync(path.join(__dirname, '..', 'artifacts', '999MS-sdk.lua'), 'utf8'), false,
    '6c82e1714a0aafd562ccaed8545d670612297f89ea1c8344f19ffe4bc0b88a39'],
];
for (const [name, source, hasStageTwoSentinel, expectedHash] of goofyscatorClientArtifacts) {
  assert.ok(source.length > 1000, `${name} must not be an empty client artifact`);
  if (hasStageTwoSentinel) assert.match(source, /^-- supper_Boom\nreturn \(/);
  else assert.match(source, /^return \(/);
  assert.doesNotMatch(source, /^-- This file is protected by goofyscator/m);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), expectedHash);
}

const runLuaRuntimeArtifacts = [
  ['loader', fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loader.lua'), 'utf8'),
    '1cebe688fbbc811681973ce0859c7b406f651c7efa1125b4d5282f98f4838026'],
  ['payload', fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'payload.lua'), 'utf8'),
    'c21ce99eb56c6152cc6df33a5b3aa60a91ebcf55a57a7640a3a2c9d9c2a53b5c'],
];
for (const [name, source, expectedHash] of runLuaRuntimeArtifacts) {
  assert.ok(source.length > 1000, `${name} must not be empty`);
  assert.match(source, /^return select\(1,function\(\.\.\.\)/);
  assert.match(source, /(?:\+=|-=)/);
  assert.doesNotMatch(source, /^-- This file was obfuscated with RUNLUA/m);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), expectedHash);
}
assert.doesNotMatch(mainSource, /--/);

assert.equal(loadaSha, '1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d');
assert.match(loadcSource, /if not game:IsLoaded\(\) then game.Loaded:Wait\(\) end/);
assert.match(loadcSource, /local __stRunUrl="https:\/\/loader999ms\.vercel\.app\/loader\/ride-a-pet\.lua"\.\.'\?run='\.\.tostring\(os\.clock\(\)\)/);
assert.match(loadcSource, /game:HttpGet\(__stRunUrl\)/);
assert.doesNotMatch(loadcSource, /__LOADA_D__|__LOADA_N__|__CHAIN_ID__|crypt\.hash|syn\.request|http_request/);
assert.doesNotMatch(loadcSource, /\bKick\(|CoreGui|replicatesignal|LocalPlayer:Kick/);
assert.match(loadcSource, /error\("0x4f98daf3fd5d",0\)/);
assert.match(loadcSource, /error\("0x75934d1098b9",0\)/);
assert.match(loadcSource, /error\("0xc6ee23173a05",0\)/);
assert.match(loadcSource, /return __stChunk\(\.\.\.\)/);
assert.match(authSource, /function serveRideLoader\(res\)/);
assert.match(authSource, /MS999Chain=\{Version="999MS-chain-v1"/);

assert.match(authSource, /function renderLoadcArtifact\(\)/);
assert.doesNotMatch(authSource, /action === 'bootstrap'|handleBootstrap/);
assert.match(authSource, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
assert.match(authSource, /crypto\.randomBytes\(26\)\.toString\('hex'\)/);
assert.match(authSource, /function createLoadaPathCapability\(\)/);
assert.match(authSource, /const LOADA_PATH_TTL = 20 \* 1000/);
assert.match(authSource, /const clientChallenge = validateClientChallenge\(req\.body\)/);
assert.match(authSource, /check: createChallengeResponse\(clientChallenge\.values\)/);
assert.match(authSource, /scriptBody = scriptBody/);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/api/bootstrap'), false);
for (const name of ['loadc', 'loader', 'sdk']) {
  assert.equal(vercelConfig.routes.some((entry) => entry.dest === `/api/auth?action=artifact&name=${name}`), true);
}
assert.equal(vercelConfig.routes.some((entry) => (
  entry.src === '/loader/ride-a-pet\\.lua' &&
  entry.dest === '/api/auth?action=ride-loader'
)), true);
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

  const rideArtifact = await requestEndpoint('/api/auth?action=ride-loader');
  const secondRideArtifact = await requestEndpoint('/api/auth?action=ride-loader');
  const browserRide = await requestEndpoint('/api/auth?action=ride-loader', { 'user-agent': 'Mozilla/5.0' });
  const robloxRide = await requestEndpoint('/api/auth?action=ride-loader', {
    'user-agent': 'Mozilla/5.0', 'x-client': 'rObLoX',
  });
  assert.equal(rideArtifact.statusCode, 200);
  assert.equal(secondRideArtifact.statusCode, 200);
  assert.equal(robloxRide.statusCode, 200);
  assert.match(rideArtifact.body, /^local __stEnv=\(getgenv and getgenv\(\)\)or _G/);
  assert.match(rideArtifact.body, /MS999Chain=\{Version="999MS-chain-v1",Id="[a-f0-9]{64}",Stage="stage1"/);
  assert.match(rideArtifact.body, /-- supper_Boom/);
  assert.notEqual(rideArtifact.body.slice(0, 200), secondRideArtifact.body.slice(0, 200));
  assert.equal(browserRide.statusCode, 302);
  assert.equal(browserRide.headers.Location, 'https://yura.lol/09ms');

  const unknownPath = await requestEndpoint('/api/auth?action=trap');
  const robloxUnknownPath = await requestEndpoint('/api/auth?action=trap', { 'X-Roblox': 'CLIENT' });
  assert.equal(unknownPath.statusCode, 302);
  assert.equal(unknownPath.headers.Location, 'https://yura.lol/09ms');
  assert.equal(robloxUnknownPath.statusCode, 404);
  assert.equal(robloxUnknownPath.headers.Location, undefined);
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  if (previousTicketSecret === undefined) delete process.env.TICKET_SECRET;
  else process.env.TICKET_SECRET = previousTicketSecret;
  console.log('PASS 999MS Server SDK, per-request loadc capabilities, and browser trap tests');
})().catch((error) => {
  if (previousLoadaPathSecret === undefined) delete process.env.LOADA_PATH_SECRET;
  else process.env.LOADA_PATH_SECRET = previousLoadaPathSecret;
  if (previousTicketSecret === undefined) delete process.env.TICKET_SECRET;
  else process.env.TICKET_SECRET = previousTicketSecret;
  console.error(error);
  process.exitCode = 1;
});
