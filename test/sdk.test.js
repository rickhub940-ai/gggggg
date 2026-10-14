'use strict';

const fs = require('node:fs');
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
const loadaToken = authSource.match(/const LOADA_ARTIFACT_TOKEN = '([a-f0-9]{64})';/)[1];
const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const stageTwoSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loader.lua'), 'utf8');
const payloadLuaSource = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'payload.lua'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
assert.equal(loadcSource.includes('\n'), false);
assert.match(loadcSource, /game:HttpGet\(b\.\."\/api\/bootstrap"\)/);
assert.match(loadcSource, /b\.\."\/loada\.lua"/);
assert.match(loadcSource, /\["X-999MS-Token"\]=n/);
assert.match(loadcSource, new RegExp(`n="${loadaToken}"`));
assert.match(loadcSource, /Id=id,Stage="stage1"/);
assert.match(loadcSource, /e\.MS999Chain=nil/);
assert.doesNotMatch(loadcSource, /\bKick\(|CoreGui|replicatesignal|LocalPlayer:Kick|\berror\(/);
assert.match(authSource, /action === 'bootstrap'/);
assert.match(authSource, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/api/bootstrap' && entry.dest === '/api/auth?action=bootstrap'), true);
for (const name of ['loadc', 'loada', 'loader', 'sdk']) {
  assert.equal(vercelConfig.routes.some((entry) => entry.dest === `/api/auth?action=artifact&name=${name}`), true);
}
assert.equal(vercelConfig.routes.some((entry) => entry.src === '/(.*)' && entry.dest === '/api/auth?action=trap'), true);
assert.match(stageTwoSource, /chainIs\("stage1", CHAIN_TTL\)/);
assert.match(stageTwoSource, /chain\.Stage = "stage2"/);
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

(async () => {
  const firstBootstrap = await requestEndpoint('/api/auth?action=bootstrap');
  const secondBootstrap = await requestEndpoint('/api/auth?action=bootstrap');
  assert.equal(firstBootstrap.statusCode, 200);
  assert.equal(secondBootstrap.statusCode, 200);
  assert.match(firstBootstrap.body.id, /^[a-f0-9]{64}$/);
  assert.match(secondBootstrap.body.id, /^[a-f0-9]{64}$/);
  assert.notEqual(firstBootstrap.body.id, secondBootstrap.body.id);

  const executorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const browserArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', { 'user-agent': 'Mozilla/5.0' });
  const robloxArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', {
    'user-agent': 'Mozilla/5.0',
    'x-client': 'rObLoX',
  });
  const loadaWithoutToken = await requestEndpoint('/api/auth?action=artifact&name=loada', { 'X-Client': 'ROBLOX' });
  const loadaWithToken = await requestEndpoint('/api/auth?action=artifact&name=loada', {
    'X-Client': 'ROBLOX',
    'X-999MS-Token': loadaToken,
  });
  const unknownPath = await requestEndpoint('/api/auth?action=trap');
  const robloxUnknownPath = await requestEndpoint('/api/auth?action=trap', { 'X-Roblox': 'CLIENT' });
  assert.equal(executorArtifact.statusCode, 200);
  assert.match(executorArtifact.body, /api\/bootstrap/);
  assert.equal(robloxArtifact.statusCode, 200);
  assert.match(robloxArtifact.body, /api\/bootstrap/);
  assert.equal(loadaWithoutToken.statusCode, 404);
  assert.equal(loadaWithToken.statusCode, 200);
  assert.match(loadaWithToken.body, /^-- supper_Boom/);
  assert.equal(browserArtifact.statusCode, 302);
  assert.equal(browserArtifact.headers.Location, 'https://yura.lol/09ms');
  assert.equal(unknownPath.statusCode, 302);
  assert.equal(unknownPath.headers.Location, 'https://yura.lol/09ms');
  assert.equal(robloxUnknownPath.statusCode, 404);
  assert.equal(robloxUnknownPath.headers.Location, undefined);
  console.log('PASS 999MS Server SDK, randomized ticket, bootstrap, and browser trap tests');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
