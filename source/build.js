#!/usr/bin/env node
'use strict';

/**
 * Builds the plain-text (non-obfuscated) chain artifacts from source/*.lua.
 *
 *   source/savecheck.lua       -> artifacts/loada.lua    (Stage 2)
 *   source/loader.lua          -> artifacts/loader.lua   (Stage 3)
 *   source/payload.lua         -> artifacts/payload.lua  (Stage 4)
 *   source/loadc.template.lua  -> artifacts/loadc.lua    (Stage 1 template)
 *
 * Every stage is emitted as one line. The readable header keeps the
 * per-request placeholders outside the compacted body, exactly like the
 * obfuscated build does, so both variants are interchangeable.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const luamin = require('luamin');

const layout = require('./stage-layout');

const OUT_DIR = path.join(layout.ROOT, 'artifacts');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function compact(text, name) {
  const out = luamin.minify(text);
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error(`${name}: minifier returned nothing`);
  }
  if (out.includes('\n')) throw new Error(`${name}: expected a single line`);
  return out;
}

const files = {};
const stage2 = {};

for (const name of ['loada', 'loader', 'payload', 'loadc']) {
  const spec = layout.stageSpec(name);
  const { header, body } = layout.splitSource(name);
  const minified = compact(body, spec.source);
  const out = layout.assemble(name, minified, { header, compact: true });
  layout.validate(name, out, { body: minified });
  if (spec.marker && !out.includes('local gamaramam = { "@NEXT@" }')) {
    throw new Error(`${spec.artifact}: the readable gamaramam marker was lost`);
  }
  fs.writeFileSync(path.join(OUT_DIR, spec.artifact), out);
  if (name === 'loada') stage2.sha = sha256(out);
  files[name] = {
    file: spec.artifact,
    sha256: sha256(out),
    bytes: Buffer.byteLength(out),
    obfuscated: false,
    engine: 'plain',
  };
  console.log(`stage ${name.padEnd(8)} ${spec.artifact.padEnd(12)} ${String(out.length).padStart(7)} bytes  sha256 ${sha256(out)}`);
}

// The SDK artifact is shipped pre-obfuscated; keep it byte-for-byte.
const sdkPath = path.join(OUT_DIR, '999MS-sdk.lua');
const sdk = fs.readFileSync(sdkPath, 'utf8');
files.sdk = {
  file: '999MS-sdk.lua',
  sha256: sha256(sdk),
  bytes: Buffer.byteLength(sdk),
  obfuscated: true,
  engine: 'prebuilt',
};

const manifest = {
  generatedAt: new Date().toISOString(),
  engine: 'plain',
  obfuscated: false,
  files,
};
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

console.log('\nstage2 sha256 (plain):', stage2.sha);
console.log('manifest:', path.join(OUT_DIR, 'manifest.json'));
