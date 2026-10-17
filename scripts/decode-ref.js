#!/usr/bin/env node
'use strict';
// Decodes a [999MS] kick reference (MS9-XXXXXXXX) by matching it against every
// kick/diagnostic string that has ever existed in this repository's history.
// Usage: node scripts/decode-ref.js MS9-0530EB6F
const path = require('node:path');
const table = require('./reference-codes.json');

const code = String(process.argv[2] || '').toUpperCase();
if (!/^MS9-[0-9A-F]{8}$/.test(code)) {
  console.error('usage: node scripts/decode-ref.js MS9-XXXXXXXX');
  process.exit(1);
}
if (table[code]) {
  console.log(`${code} = "${table[code]}"`);
  process.exit(0);
}
console.log(`${code} = not found in ${Object.keys(table).length} indexed strings`);
console.log('Try scripts/decode-ref.js --list to print every known mapping.');
process.exit(2);
