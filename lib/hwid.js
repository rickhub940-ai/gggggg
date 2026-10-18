'use strict';

const crypto = require('node:crypto');

const MAX_HWID_LENGTH = 512;
const MIN_HWID_LENGTH = 4;
const FINGERPRINT_HEADER_PRIORITY = Object.freeze([
  'syn-fingerprint',
  'fingerprint',
  'krnl-fingerprint',
  'flux-fingerprint',
  'wave-fingerprint',
  'sirhurt-fingerprint',
  'sw-fingerprint',
]);

function canonical(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[String(name).toLowerCase()] = value;
  }
  return normalized;
}

function headerValue(headers, name) {
  const value = headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string');
    return first ? first.trim() : '';
  }
  return '';
}

function fingerprintFromHeaders(headers = {}) {
  for (const name of FINGERPRINT_HEADER_PRIORITY) {
    const value = headerValue(headers, name);
    if (value) return value;
  }

  // Luasec accepts the first executor-specific header ending in -fingerprint.
  for (const [name, value] of Object.entries(headers)) {
    if (!name.endsWith('-fingerprint')) continue;
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (candidate) return candidate;
  }
  return '';
}

// Platoboost provides one identifier field. Encode both device signals into
// one versioned digest; the resolver requires both before producing it.
function deviceBindingId(hwid, fingerprint) {
  const h = canonical(hwid);
  const f = canonical(fingerprint);
  if (!h || !f) return '';
  return crypto.createHash('sha256')
    .update(`999MS-device-binding-v1\0${h}\0${f}`, 'utf8')
    .digest('hex');
}

function resolveHwid(headers = {}, bodyValue) {
  const normalized = normalizeHeaders(headers);
  const explicitHeader = headerValue(normalized, 'x-ms999-hwid');
  const body = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  if (explicitHeader && body && canonical(explicitHeader) !== canonical(body)) {
    return { ok: false, reason: 'hwid mismatch' };
  }

  const hwid = explicitHeader || body;
  if (hwid.length < MIN_HWID_LENGTH || hwid.length > MAX_HWID_LENGTH) {
    return { ok: false, reason: 'invalid hwid format' };
  }

  const fingerprint = fingerprintFromHeaders(normalized);
  if (fingerprint.length < MIN_HWID_LENGTH || fingerprint.length > MAX_HWID_LENGTH) {
    return { ok: false, reason: 'fingerprint required' };
  }

  return {
    ok: true,
    hwid,
    fingerprint,
    bindingId: deviceBindingId(hwid, fingerprint),
  };
}

module.exports = {
  resolveHwid,
  deviceBindingId,
  canonical,
  MAX_HWID_LENGTH,
  MIN_HWID_LENGTH,
};
