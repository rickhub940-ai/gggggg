#!/usr/bin/env node
'use strict';
/**
 * Assemble the user-supplied Centurion-obfuscated Stage 2–4 files.
 * This script does not read, parse, minify, or obfuscate source/*.lua.
 * Stage 2/3 receive the runtime header at byte zero; Stage 4 has no header.
 * Stage 1 remains untouched and is generated/obfuscated per request elsewhere.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const obfuscatedDir = path.join(root, 'obfuscated');
const artifactsDir = path.join(root, 'artifacts');
const HEADER = 'local gamaramam = { "@NEXT@" };\n';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readSupplied(name) {
  const body = fs.readFileSync(path.join(obfuscatedDir, name), 'utf8');
  if (!body.includes('Centurion v6.3')) {
    throw new Error(`${name}: expected the supplied Centurion v6.3 output`);
  }
  return body;
}

const stage2 = HEADER + readSupplied('loada.lua');
const stage3 = HEADER + readSupplied('loader.lua');
const stage4 = readSupplied('payload.lua');

fs.mkdirSync(artifactsDir, { recursive: true });
fs.writeFileSync(path.join(artifactsDir, 'loada.lua'), stage2);
fs.writeFileSync(path.join(artifactsDir, 'loader.lua'), stage3);
fs.writeFileSync(path.join(artifactsDir, 'payload.lua'), stage4);

console.log('Stage 2 (user obfuscated) bytes:', Buffer.byteLength(stage2), 'sha256:', sha256(stage2));
console.log('Stage 3 (user obfuscated) bytes:', Buffer.byteLength(stage3));
console.log('Stage 4 (user obfuscated) bytes:', Buffer.byteLength(stage4));
console.log('Stage 2 sha256 pin must match api/auth.js.');
