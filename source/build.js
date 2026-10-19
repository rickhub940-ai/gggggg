#!/usr/bin/env node
'use strict';
/**
 * Builds compact, obfuscated Stage 2-4 artifacts from readable source/*.lua.
 * Stage 2/3 headers stay readable and are prepended after obfuscating bodies.
 *   source/savecheck.lua -> artifacts/loada.lua    (Stage 2)
 *   source/loader.lua    -> artifacts/loader.lua   (Stage 3)
 *   source/payload.lua   -> artifacts/payload.lua  (Stage 4)
 *   source/loadc.template.lua -> artifacts/loadc.lua (Stage 1 template)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const luamin = require('luamin');
const { obfuscate } = require('lua-obfuscator');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'source', name), 'utf8');
const write = (name, body) => fs.writeFileSync(path.join(root, 'artifacts', name), body);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Keep source files readable for maintenance. Compact all generated bodies,
// then obfuscate Stages 2-4 while preserving runtime literals and gamaramam.
const compact = (text, name) => {
  const out = luamin.minify(text);
  if (typeof out !== 'string' || out.length === 0)
    throw new Error(`${name}: minifier returned nothing`);
  if (out.includes('\n')) throw new Error(`${name}: expected a single line`);
  return out;
};

const OBFUSCATION_STEPS = Object.freeze([
  { name: 'RenameVariables' },
  { name: 'NumbersToExpressions' },
  { name: 'InsertJunk' },
]);

function obfuscateBody(text, name) {
  const minified = compact(text, name);
  const out = obfuscate(minified, 'luaU', { steps: OBFUSCATION_STEPS, minify: true });
  if (typeof out !== 'string' || out.length <= minified.length)
    throw new Error(`${name}: obfuscator returned no obfuscated output`);
  if (out.includes('\n')) throw new Error(`${name}: obfuscated output must be a single line`);
  for (const token of minified.match(/@[A-Z0-9_]+@/g) || []) {
    if (!out.includes(token)) throw new Error(`${name}: obfuscator changed runtime literal ${token}`);
  }
  if (/\bgamaramam\b/.test(minified) && !/\bgamaramam\b/.test(out))
    throw new Error(`${name}: obfuscator changed the gamaramam handoff reference`);
  return out;
}

// Stage 2 is built in two parts: the HEADER block (marker + next-stage link,
// kept verbatim) and the BODY, which is compacted then obfuscated. The save detector checks
// only the marker name; it does not depend on a base-URL placeholder.
const stage2Raw = read('savecheck.lua');

const headerEnd = stage2Raw.indexOf('-- ═══ BODY ═══');
if (headerEnd < 0) throw new Error('savecheck.lua missing the BODY marker');
const headerSource = stage2Raw.slice(0, headerEnd);
const bodySource = stage2Raw.slice(headerEnd);

// The header keeps its comments out and its whitespace collapsed, but the
// table name and both literals are untouched.
const header = headerSource
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim();
if (!/^local gamaramam\s*=/.test(header)) throw new Error('header must declare gamaramam');
if (!/^local gamaramam = \{ "@NEXT@" \}$/.test(header)) throw new Error('header must be a one-entry gamaramam table');
if (!header.includes('"@NEXT@"')) throw new Error('header lost the next-link slot');

const stage2 = `${header};${obfuscateBody(bodySource, 'savecheck.lua')}`;
if (!/local gamaramam\s*=/.test(stage2)) throw new Error('stage 2 dropped the header table');
if (!/gamaramam\s*\[/.test(stage2)) throw new Error('body no longer reads the header table');
if (!stage2.includes('local gamaramam = { "')) throw new Error('body lost the save marker needle');
if (!stage2.includes('"@NONCE@"')) throw new Error('stage 2 lost the fetch-proof nonce');
write('loada.lua', stage2);
console.log('stage 2 (loada)   ', stage2.length, 'bytes  sha256', sha256(stage2));

// Stage 3 / 4 are rendered by api/auth.js with the same substitution.
function splitHeader(source, raw, marker) {
  const cut = raw.indexOf(marker);
  if (cut < 0) throw new Error(`${source} missing the BODY marker`);
  const header = raw.slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^local gamaramam\s*=/.test(header)) throw new Error(`${source}: header must declare gamaramam`);
  if (!/^local gamaramam = \{ "@NEXT@" \}$/.test(header)) throw new Error(`${source}: header must be a one-entry gamaramam table`);
  if (!raw.includes('"@NONCE@"')) throw new Error(`${source}: body lost the fetch-proof nonce`);
  return { header, body: raw.slice(cut) };
}

// Stage 3 carries the same header (marker + next link) as Stage 2.
{
  const raw = read('loader.lua');
  const { header, body } = splitHeader('loader.lua', raw, '-- ═══ BODY ═══');
  const out = `${header};${obfuscateBody(body, 'loader.lua')}`;
  write('loader.lua', out);
  console.log('stage   loader.lua    ', out.length, 'bytes');
}

// Stage 4 is the final hand-off: no header, no next link.
{
  const raw = read('payload.lua');
  if (!raw.includes('@BASE_URL@')) throw new Error('payload.lua missing @BASE_URL@');
  const body = obfuscateBody(raw, 'payload.lua');
  write('payload.lua', body);
  console.log('stage   payload.lua   ', body.length, 'bytes');
}

// Stage 1 template keeps its tokens; the handler fills chain id, capability,
// stage-2 sha and base url at request time.
const stage1Raw = read('loadc.template.lua');
for (const token of ['__STAGE2_TOKEN__', '__STAGE2_SHA256__', '__BASE_URL__']) {
  if (!stage1Raw.includes(token)) throw new Error(`loadc template missing ${token}`);
}
const stage1 = compact(stage1Raw, 'loadc.template.lua');
write('loadc.lua', stage1);
console.log('stage 1 (loadc)   ', stage1.length, 'bytes');
console.log('\nstage2 sha256 (pin this in api/auth.js):', sha256(stage2));
