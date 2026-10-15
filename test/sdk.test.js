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
assert.match(loadcSource, /local __CLOCK__=os\.clock\(\)/);
assert.match(loadcSource, /local __TIME__=os\.time\(\)/);
assert.match(loadcSource, /local __DATE__=os\.date\("\*t"\)/);
assert.match(loadcSource, /local __DIFF__=os\.difftime\(__TIME__,__TIME__-1\)/);
assert.match(loadcSource, /local __STAMP__=table\.concat\(\{tostring\(__TIME__\),tostring\(__DATE__\.year\),tostring\(__DATE__\.yday\),tostring\(__DATE__\.hour\),tostring\(__DATE__\.min\),tostring\(__DATE__\.sec\),tostring\(__DIFF__\)\},"-"\)/);
assert.doesNotMatch(loadcSource, /\bprint\s*\(/);
assert.match(loadcSource, /local __D__="__LOADA_D__"/);
assert.match(loadcSource, /local __N__="__LOADA_N__"/);
assert.match(loadcSource, /local __ID__="__CHAIN_ID__"/);
assert.match(loadcSource, /local __URL__=__BASE__\.\."\/loada\.lua\/"\.\.__D__\.\."\/"\.\.__N__\.\.'\?run='\.\.tostring\(__CLOCK__\)\.\.'&stamp='\.\.__STAMP__/);
assert.match(loadcSource, /game:HttpGet\(__URL__\)/);
assert.match(loadcSource, new RegExp(`local __HASH__="${loadaSha}"`));
assert.doesNotMatch(loadcSource, /api\/bootstrap|syn\.request|http_request/);
assert.doesNotMatch(loadcSource, /\bKick\(|CoreGui|replicatesignal|LocalPlayer:Kick/);
assert.match(loadcSource, /error\("0x4f98daf3fd5d",0\)/);
assert.match(loadcSource, /error\("0x31d7a640f95e",0\)/);
assert.match(loadcSource, /error\("0x75934d1098b9",0\)/);
assert.match(loadcSource, /error\("0xc6ee23173a05",0\)/);
assert.match(loadcSource, /return __FUNCTION__\(__ARGS__,\.\.\.\)/);

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
  entry.src === '/loada\\.lua/([^/]+)/([^/]+)' &&
  entry.dest === '/api/auth?action=artifact&name=loada&d=$1&n=$2'
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

function parseRenderedLoadc(source) {
  const localValues = new Map([...source.matchAll(/local ([a-z])="([a-f0-9]{64})"/g)]
    .map((match) => [match[1], match[2]]));
  const chainVariable = source.match(/MS999Chain=\{Version="999MS-chain-v1",Id=([a-z]),Stage="stage1"/)[1];
  const pathVariables = source.match(/\/loada\.lua\/"\.\.([a-z])\.\."\/"\.\.([a-z])\.\.'\?run='/);
  const chainId = localValues.get(chainVariable);
  const d = localValues.get(pathVariables[1]);
  const n = localValues.get(pathVariables[2]);
  assert.match(chainId, /^[a-f0-9]{64}$/);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.match(n, /^[a-f0-9]{64}$/);
  assert.equal(source.includes('__LOADA_D__'), false);
  assert.equal(source.includes('__LOADA_N__'), false);
  assert.equal(source.includes('__CHAIN_ID__'), false);
  assert.equal(source.includes('__CLOCK__'), false);
  const localNames = [...source.matchAll(/local ([a-z](?:,[a-z])*)=/g)]
    .flatMap((match) => match[1].split(','));
  assert.ok(localNames.length >= 20);
  assert.equal(new Set(localNames).size, localNames.length);
  return { chainId, d, n, localNames };
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

  const executorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const secondExecutorArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc');
  const browserArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', { 'user-agent': 'Mozilla/5.0' });
  const robloxArtifact = await requestEndpoint('/api/auth?action=artifact&name=loadc', {
    'user-agent': 'Mozilla/5.0', 'x-client': 'rObLoX',
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
  assert.notDeepEqual(firstLoadc.localNames, secondLoadc.localNames);
  assert.notDeepEqual(secondLoadc.localNames, robloxLoadc.localNames);
  assert.notEqual(secondLoadc.chainId, robloxLoadc.chainId);

  const loadaWithoutPathToken = await requestEndpoint('/api/auth?action=artifact&name=loada', { 'X-Client': 'ROBLOX' });
  const loadaWrongPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${'0'.repeat(64)}`, { 'X-Client': 'ROBLOX' });
  const loadaWithPathToken = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, { 'X-Client': 'ROBLOX' });
  const loadaBrowserPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, { 'user-agent': 'Mozilla/5.0' });
  const actualNow = Date.now;
  Date.now = () => actualNow() + 20001;
  const loadaExpiredPath = await requestEndpoint(`/api/auth?action=artifact&name=loada&d=${firstLoadc.d}&n=${firstLoadc.n}`, { 'X-Client': 'ROBLOX' });
  Date.now = actualNow;
  const unknownPath = await requestEndpoint('/api/auth?action=trap');
  const robloxUnknownPath = await requestEndpoint('/api/auth?action=trap', { 'X-Roblox': 'CLIENT' });
  assert.equal(loadaWithoutPathToken.statusCode, 404);
  assert.equal(loadaWrongPathToken.statusCode, 404);
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
