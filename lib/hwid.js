'use strict';

const { Buffer } = require('node:buffer');
const MAX_HWID_LENGTH = 512;
const MIN_HWID_LENGTH = 4;

function canonical(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Deterministic, reversible transport representation. Platoboost's wrapper
// hashes this one stable value before using it as its sole identifier.
function deviceBindingId(hwid) {
  const value = canonical(hwid);
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

// Accept the new split/Base64 body after server reconstruction and old custom
// headers/field names during transition. Executor fingerprint headers are not
// used for persistent key binding.
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
  return { ok: true, hwid, bindingId: deviceBindingId(hwid) };
}

module.exports = { resolveHwid, deviceBindingId, canonical, MAX_HWID_LENGTH, MIN_HWID_LENGTH };
