'use strict';

/**
 * Shared layout for every delivered Lua stage.
 *
 * A stage source file is split at `-- ═══ BODY ═══`:
 *
 *   header  comments + the per-request values (link, sha, nonce, base url).
 *           The header is never obfuscated: the server substitutes its
 *           placeholders on every request.
 *
 *   body    the real logic. It receives the header values as extra positional
 *           arguments, so it can be obfuscated as a standalone chunk without
 *           the obfuscator ever touching a placeholder or a host name.
 *
 * The assembled stage is:
 *
 *   <header>
 *   local __ms999_stage = function(...)
 *   <body>
 *   end
 *   return __ms999_stage(..., <call>)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BODY_MARKER = '-- ═══ BODY ═══';

const STAGES = Object.freeze({
  loada: {
    source: 'source/savecheck.lua',
    artifact: 'loada.lua',
    call: 'gamaramam[1], "@NEXT_SHA@", "@NONCE@"',
    placeholders: ['@NEXT@', '@NEXT_SHA@', '@NONCE@'],
    marker: 'local gamaramam',
  },
  loader: {
    source: 'source/loader.lua',
    artifact: 'loader.lua',
    call: 'gamaramam[1], "@NEXT_SHA@", "@NONCE@", MS999_BASE_URL',
    placeholders: ['@NEXT@', '@NEXT_SHA@', '@NONCE@', '@BASE_URL@'],
    marker: 'local gamaramam',
  },
  payload: {
    source: 'source/payload.lua',
    artifact: 'payload.lua',
    call: 'MS999_BASE_URL',
    placeholders: ['@BASE_URL@'],
    marker: null,
  },
  loadc: {
    source: 'source/loadc.template.lua',
    artifact: 'loadc.lua',
    call: 'MS999_LINK, MS999_BASE, MS999_SHA, MS999_NONCE',
    placeholders: ['__STAGE2_TOKEN__', '__BASE_URL__', '__STAGE2_SHA256__', '__STAGE2_NONCE__'],
    marker: null,
  },
  main: {
    source: 'scripts/main.lua',
    artifact: 'scripts/main.lua',
    call: 'MS999_SCRIPT_ID',
    placeholders: ['${SCRIPTID}'],
    marker: null,
  },
});

function stageSpec(name) {
  const spec = STAGES[name];
  if (!spec) throw new Error(`unknown stage: ${name}`);
  return spec;
}

function sourcePath(name) {
  return path.join(ROOT, stageSpec(name).source);
}

function readSource(name) {
  return fs.readFileSync(sourcePath(name), 'utf8');
}

function splitSource(name, raw = readSource(name)) {
  const cut = raw.indexOf(BODY_MARKER);
  if (cut < 0) throw new Error(`${stageSpec(name).source} is missing the BODY marker`);
  const lineEnd = raw.indexOf('\n', cut);
  const bodyStart = lineEnd < 0 ? raw.length : lineEnd + 1;
  return {
    header: raw.slice(0, cut).replace(/\s+$/, ''),
    body: raw.slice(bodyStart),
  };
}

// The plain build ships one compact line: comments out, whitespace collapsed,
// but the placeholder literals untouched.
function compactHeader(header) {
  const out = header
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    // Keep the readable statements visibly separated after compacting:
    //   local gamaramam = { "..." };local MS999_BASE_URL = "..."
    .replace(/}\s+local\s+/g, '};local ')
    .replace(/"\s+local\s+/g, '";local ')
    .replace(/"\s+local\s+/g, '";local ');
  if (out.length === 0) throw new Error('stage header is empty');
  return out;
}

// Pretty headers are used for the obfuscated build. The placeholder lines stay
// byte-for-byte readable so the server can substitute them.
function prettyHeader(header) {
  const lines = header.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function preludeLines(name) {
  const spec = stageSpec(name);
  return [
    'local __ms999_unpack = table.unpack or unpack',
    'local __ms999_args = { n = select("#", ...), ... }',
    'local __ms999_base = __ms999_args.n',
    `local __ms999_extra = { ${spec.call} }`,
    'for __ms999_i = 1, #__ms999_extra do __ms999_args[__ms999_base + __ms999_i] = __ms999_extra[__ms999_i] end',
    '__ms999_args.n = __ms999_base + #__ms999_extra',
  ];
}

// `f(..., extra)` would truncate the chunk's varargs to one value, so append
// the readable header values to a packed argument table and expand the whole
// table as the single argument of the wrapper. The body sees the original
// arguments followed by the header values, positionally.
function wrapBody(name, body, { compact = false } = {}) {
  const tail = 'return __ms999_stage(__ms999_unpack(__ms999_args, 1, __ms999_args.n))';
  if (compact) {
    // Lua 5.1 does not allow an empty statement right after `function(...)`,
    // so only the statements around the function body get a `;`.
    const prelude = preludeLines(name).join(';');
    return `${prelude};local __ms999_stage = function(...) ${body.trim()} end; ${tail}`;
  }
  return [
    ...preludeLines(name),
    'local __ms999_stage = function(...)',
    body.trim(),
    'end',
    tail,
  ].join('\n');
}

function assemble(name, body, { header = null, compact = false } = {}) {
  const head = compact
    ? compactHeader(header ?? splitSource(name).header)
    : prettyHeader(header ?? splitSource(name).header);
  const wrapped = wrapBody(name, body, { compact });
  return compact ? `${head};${wrapped}` : `${head}\n${wrapped}\n`;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// A final artifact must carry each placeholder exactly once, outside the
// body, and must keep the save marker that Stage 2 scans for.
function validate(name, finalText, { body = null } = {}) {
  const spec = stageSpec(name);
  for (const token of spec.placeholders) {
    const hits = count(finalText, token);
    if (hits !== 1) {
      throw new Error(`${spec.artifact}: placeholder ${token} appears ${hits} times (expected 1)`);
    }
    if (body !== null && count(body, token) !== 0) {
      throw new Error(`${spec.artifact}: placeholder ${token} leaked into the obfuscated body`);
    }
  }
  if (spec.marker && !finalText.includes(spec.marker)) {
    throw new Error(`${spec.artifact}: missing marker ${spec.marker}`);
  }
  return true;
}

module.exports = {
  ROOT,
  BODY_MARKER,
  STAGES,
  stageSpec,
  sourcePath,
  readSource,
  splitSource,
  compactHeader,
  prettyHeader,
  preludeLines,
  wrapBody,
  assemble,
  validate,
};
