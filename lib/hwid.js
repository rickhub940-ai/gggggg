'use strict';

const { Buffer } = require('node:buffer');
const MAX_HWID_LENGTH = 512;
const MIN_HWID_LENGTH = 4;

function canonical(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// The matching fingerprint value is authoritative. The encoded HWID parts are
// an independent client-reported value that must agree before binding.
function deviceBindingId(fingerprint) {
  const value = canonical(fingerprint);
  return value ? Buffer.from(value, 'utf8').toString('base64') : '';
}

function headerValue(headers = {}, name) {
  const found = Object.entries(headers).find(([key]) => String(key).toLowerCase() === name);
  const value = found && found[1];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string');
    return first ? first.trim() : '';
  }
  return '';
}

// Do not whitelist executor-specific names. Accept any HTTP header whose name
// contains the word "fingerprint", case-insensitively.
function fingerprintsFromHeaders(headers = {}) {
  const values = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!String(name).toLowerCase().includes('fingerprint')) continue;
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) values.push(item.trim());
    }
  }
  return values;
}

// Accept the split/Base64 body after server reconstruction and old raw-HWID
// fields/headers during transition. A matching fingerprint is required and
// trusted for the persistent identifier.
function resolveHwid(headers = {}, bodyValue) {
  const opaqueHeader = headerValue(headers, 'x-r7q');
  const legacyHeader = headerValue(headers, 'x-ms999-hwid');
  const body = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  if (opaqueHeader && legacyHeader && canonical(opaqueHeader) !== canonical(legacyHeader)) {
    return { ok: false, reason: 'hwid mismatch' };
  }
  const header = opaqueHeader || legacyHeader;
  if (header && body && canonical(header) !== canonical(body)) {
    return { ok: false, reason: 'hwid mismatch' };
  }

  const hwid = header || body;
  if (hwid.length < MIN_HWID_LENGTH || hwid.length > MAX_HWID_LENGTH) {
    return { ok: false, reason: 'invalid hwid format' };
  }

  const fingerprints = fingerprintsFromHeaders(headers);
  if (!fingerprints.length) return { ok: false, reason: 'fingerprint required' };
  if (fingerprints.some((value) => value.length < MIN_HWID_LENGTH || value.length > MAX_HWID_LENGTH)) {
    return { ok: false, reason: 'invalid fingerprint format' };
  }
  if (fingerprints.some((value) => value !== hwid)) {
    return { ok: false, reason: 'hwid fingerprint mismatch' };
  }

  // All matching fields carry the same value; use the fingerprint as authority.
  const fingerprint = fingerprints[0];
  return { ok: true, hwid: fingerprint, fingerprint, bindingId: deviceBindingId(fingerprint) };
}

module.exports = {
  resolveHwid,
  deviceBindingId,
  canonical,
  fingerprintsFromHeaders,
  MAX_HWID_LENGTH,
  MIN_HWID_LENGTH,
};
