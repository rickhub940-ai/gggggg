'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { issueTicket, verifyTicket } = require('../lib/ticket');
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
const clientSdkSource = fs.readFileSync(path.join(__dirname, '..', 'public', '999MS-sdk.lua'), 'utf8');
const clientSdkTransforms = [...clientSdkSource.matchAll(
  /\{ multiplier = (-?\d+), offset = (-?\d+) \}/g,
)].map((match) => [Number(match[1]), Number(match[2])]);
assert.deepEqual(clientSdkTransforms, expectedTransforms);

const payloadSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'payload.lua'), 'utf8');
const multipliers = payloadSource.match(/local ChallengeMultipliers = \{ ([^}]+) \}/)[1]
  .split(',').map((value) => Number(value.trim()));
const offsets = payloadSource.match(/local ChallengeOffsets = \{ ([^}]+) \}/)[1]
  .split(',').map((value) => Number(value.trim()));
assert.deepEqual(multipliers.map((value, index) => [value, offsets[index]]), expectedTransforms);

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'loader.lua'), 'utf8');
const payloadLuaSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'payload.lua'), 'utf8');
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

console.log('PASS 999MS Server SDK and randomized ticket tests');
