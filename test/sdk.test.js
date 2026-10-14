'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  RNG_CHALLENGE_TRANSFORMS,
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  createRuntimeCredentials,
  verifyRuntimeProof,
} = require('../lib/luasec-server-sdk');

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
const clientSdkSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'luasec-sdk.lua'), 'utf8');
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

console.log('PASS Luasec Server SDK protocol tests');
