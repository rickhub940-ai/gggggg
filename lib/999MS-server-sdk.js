'use strict';

const crypto = require('node:crypto');
const { xorCipher, b64encode, b64decode } = require('./crypto');

/**
 * 999MS Server SDK
 *
 * Shared protocol helpers for a 999MS-compatible authorization endpoint.
 * Tickets, key-provider checks, storage, and revocation policy intentionally
 * stay with the host application: this module only owns the portable wire
 * protocol and short-lived runtime proof helpers.
 */

const MAX_PROTECTED_BYTES = 1024 * 1024;

// These constants are protocol-visible and are not authorization secrets.
// They deliberately vary per component so a response is not a repetition of
// one arithmetic mapping.
const RNG_CHALLENGE_TRANSFORMS = Object.freeze([
  Object.freeze({ multiplier: 2, offset: -32 }),
  Object.freeze({ multiplier: 5, offset: 256 }),
  Object.freeze({ multiplier: 3, offset: -17 }),
  Object.freeze({ multiplier: 7, offset: 19 }),
  Object.freeze({ multiplier: 11, offset: -101 }),
]);

function isValidScriptName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function isFiniteNonInteger(value) {
  return Number.isFinite(value) && !Number.isInteger(value);
}

function validateClientChallenge(clientData) {
  const values = ['Rng1', 'Rng2', 'Rng3', 'Rng4', 'Rng5']
    .map((field) => clientData?.[field]);

  if (!values.every(Number.isSafeInteger)) {
    return { ok: false, reason: 'RNG integers rejected' };
  }
  // The client generates an integer in [1, 1_000_000] plus math.random().
  // Requiring a bounded non-integer catches simple constant/integer RNG hooks
  // on the server without using client stack or hook metadata as authority.
  const rngFloat = clientData?.RngFloat;
  if (!isFiniteNonInteger(rngFloat) || rngFloat <= 1 || rngFloat >= 1_000_001) {
    return { ok: false, reason: 'RNG float rejected' };
  }
  return { ok: true, values };
}

function createChallengeResponse(values) {
  if (!Array.isArray(values) || values.length !== RNG_CHALLENGE_TRANSFORMS.length ||
      !values.every(Number.isSafeInteger)) {
    throw new TypeError('Expected five safe integer RNG values');
  }

  return values.map((value, index) => {
    const { multiplier, offset } = RNG_CHALLENGE_TRANSFORMS[index];
    return (value * multiplier) + offset;
  }).join('|');
}

function requireXorKey(xorKey) {
  if (typeof xorKey !== 'string' || xorKey.length === 0 || xorKey.length > 4096) {
    throw new TypeError('A non-empty PAYLOAD_XOR_KEY is required');
  }
  return xorKey;
}

function isByteArray(value) {
  return Array.isArray(value) && value.length <= MAX_PROTECTED_BYTES &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function encodeProtectedPayload(data, xorKey) {
  const key = requireXorKey(xorKey);
  const json = JSON.stringify(data);
  if (typeof json !== 'string') throw new TypeError('Payload must be JSON serializable');

  const encrypted = xorCipher(Buffer.from(json, 'utf8'), key);
  const full = key + b64encode(encrypted);
  return { Data: Array.from(Buffer.from(full, 'utf8')) };
}

function decodeProtectedPayload(body, xorKey) {
  try {
    const key = requireXorKey(xorKey);
    const { Data } = body || {};
    if (!isByteArray(Data)) return { ok: false };

    const raw = Buffer.from(Data).toString('utf8');
    if (raw.length < key.length + 4 || raw.slice(0, key.length) !== key) {
      return { ok: false };
    }

    const b64 = raw.slice(key.length);
    const decrypted = xorCipher(b64decode(b64), key).toString('utf8');
    return { ok: true, data: JSON.parse(decrypted) };
  } catch {
    return { ok: false };
  }
}

function createRuntimeCredentials() {
  return {
    scriptToken: crypto.randomBytes(24).toString('hex'),
    runtimeSecret: crypto.randomBytes(32).toString('hex'),
  };
}

function timingSafeStringEqual(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyRuntimeProof({
  session,
  runtimeSecret,
  scriptToken,
  hwidHash,
  scriptName,
  now = Date.now(),
  sessionTtl = 30 * 60 * 1000,
  runtimeTtl = 60 * 1000,
}) {
  if (!session || typeof session !== 'object') return 'session not found';
  if (typeof scriptName === 'string' && scriptName !== session.scriptName) {
    return 'scriptName changed';
  }
  if (typeof runtimeSecret !== 'string' || runtimeSecret.length !== 64 ||
      !timingSafeStringEqual(session.runtimeSecret, runtimeSecret)) {
    return 'secret mismatch';
  }
  if (typeof scriptToken !== 'string' || scriptToken.length > 128 ||
      !timingSafeStringEqual(session.scriptToken, scriptToken)) {
    return 'token mismatch';
  }
  if (typeof hwidHash !== 'string' || !timingSafeStringEqual(session.hwidHash, hwidHash)) {
    return 'hwid mismatch';
  }
  if (now - session.createdAt > sessionTtl) return 'session expired';
  if (now - session.scriptIssuedAt > runtimeTtl) return 'runtime expired';
  if (session.verified) return 'already verified';
  return null;
}

module.exports = {
  RNG_CHALLENGE_TRANSFORMS,
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  createRuntimeCredentials,
  timingSafeStringEqual,
  verifyRuntimeProof,
};
