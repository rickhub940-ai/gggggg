#!/usr/bin/env node
'use strict';

/**
 * Build-time obfuscation of every delivered stage.
 *
 * The header (placeholders, next link, sha, nonce, base url) never enters the
 * obfuscator. Only the BODY is sent, and the assembled file keeps the readable
 * header so the server can substitute values per request.
 *
 * Engines, in `auto` order:
 *   1. wearedevs   POST https://wearedevs.net/api/obfuscate
 *                  (the public endpoint the site itself calls)
 *   2. prometheus  the open-source engine WeAreDevs documents as its backend
 *                  (needs a Lua 5.1 binary and a Prometheus checkout)
 *   3. local       lua-obfuscator from npm (offline fallback)
 *
 * Usage:
 *   node source/obf-build.js --engine auto
 *   node source/obf-build.js --engine wearedevs
 *   PROMETHEUS_LUA=/path/to/lua5.1 \
 *   PROMETHEUS_DIR=/path/to/Prometheus \
 *     node source/obf-build.js --engine prometheus --preset Strong
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const layout = require('./stage-layout');

const ROOT = layout.ROOT;
const DEFAULT_OUT = path.join(ROOT, 'obf');
const OBF_MARKER = '-- 999MS-OBF:';
const WEARE_API_URL = process.env.WEARE_API_URL || 'https://wearedevs.net/api/obfuscate';
const WEARE_TIMEOUT_MS = Number(process.env.WEARE_API_TIMEOUT_MS) || 20000;
const WEARE_RETRY_MS = (process.env.WEARE_API_RETRY_MS || '800,2000,4000')
  .split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);

const LOCAL_STEPS = Object.freeze([
  { name: 'RenameVariables' },
  { name: 'ConstantArray' },
  { name: 'StringsToExpressions' },
  { name: 'NumbersToExpressions' },
  { name: 'EncryptStrings' },
  { name: 'EncryptNumbers' },
  { name: 'InsertJunk' },
  { name: 'WrapInFunction' },
]);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The endpoint answers {"obfuscated": "..."} (optionally with success:true).
// A plain Lua body is accepted too; an explicit success:false is not.
function parseWeAreDevs(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || parsed.success === false) return null;
    const output = parsed.obfuscated || parsed.result || parsed.output;
    return typeof output === 'string' && output.length >= 100 ? output : null;
  }
  if (trimmed.startsWith('--') || trimmed.startsWith('return') || trimmed.startsWith('local')) {
    return trimmed.length >= 100 ? trimmed : null;
  }
  return null;
}

async function postWeAreDevs(source, { url = WEARE_API_URL, timeoutMs = WEARE_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // The public endpoint rejects non-browser agents.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      origin: 'https://wearedevs.net',
      referer: 'https://wearedevs.net/obfuscator',
    },
    body: JSON.stringify({ script: source }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    const error = new Error('HTTP 429');
    error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    throw error;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  const output = parseWeAreDevs(text);
  if (!output) throw new Error(`unexpected response: ${text.slice(0, 160)}`);
  return output;
}

async function obfuscateWithWeAreDevs(source, options = {}) {
  const retries = options.retries ?? WEARE_RETRY_MS.length;
  const delays = options.retryDelays ?? WEARE_RETRY_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const body = await postWeAreDevs(source, options);
      return { body, engine: 'wearedevs', detail: 'wearedevs.net/api/obfuscate', attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const delay = error.retryAfter ?? delays[attempt];
      if (delay === undefined) break;
      log(`wearedevs attempt ${attempt + 1} failed (${error.message}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
  throw lastError || new Error('wearedevs obfuscation failed');
}

function which(binary) {
  try {
    return execFileSync('sh', ['-c', `command -v ${JSON.stringify(binary)}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function prometheusPaths() {
  const lua = process.env.PROMETHEUS_LUA || which('lua5.1') || which('lua') || which('luajit');
  const dir = process.env.PROMETHEUS_DIR || path.join(ROOT, 'vendor', 'Prometheus');
  const cli = path.join(dir, 'cli.lua');
  return { lua, dir, cli };
}

function obfuscateWithPrometheus(source, { preset = process.env.OBF_PRESET || 'Strong' } = {}) {
  const { lua, cli } = prometheusPaths();
  if (!lua) throw new Error('no Lua 5.1 interpreter (set PROMETHEUS_LUA)');
  if (!fs.existsSync(cli)) throw new Error(`Prometheus CLI not found at ${cli} (set PROMETHEUS_DIR)`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms999-obf-'));
  const input = path.join(temp, 'body.lua');
  const output = path.join(temp, 'body.obf.lua');
  try {
    fs.writeFileSync(input, source);
    const result = spawnSync(lua, [cli, '--preset', preset, '--Lua51', '--nocolors', '--out', output, input], {
      cwd: path.dirname(cli),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Prometheus exited ${result.status}: ${(result.stderr || result.stdout || '').slice(-400)}`);
    }
    if (!fs.existsSync(output)) throw new Error('Prometheus produced no output file');
    const body = fs.readFileSync(output, 'utf8').trim();
    if (body.length < 100) throw new Error('Prometheus output is empty/too small');
    return { body, engine: 'prometheus', detail: `Prometheus ${preset} (Lua 5.1)` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function obfuscateLocally(source) {
  let obfuscate;
  try {
    ({ obfuscate } = require('lua-obfuscator'));
  } catch {
    throw new Error('lua-obfuscator is not installed');
  }
  const body = obfuscate(source, 'luaU', { steps: LOCAL_STEPS, minify: true });
  if (typeof body !== 'string' || body.length < 100) throw new Error('local obfuscator produced no output');
  return { body, engine: 'local', detail: 'lua-obfuscator (offline fallback)' };
}

async function obfuscateBody(source, engine = 'auto', options = {}) {
  const failures = [];
  const tryEngine = async (name, fn) => {
    try {
      const result = await fn();
      log(`${name}: ok (${result.body.length} bytes)`);
      return result;
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      log(`${name}: ${error.message}`);
      return null;
    }
  };

  if (engine === 'wearedevs') {
    return obfuscateWithWeAreDevs(source, options);
  }
  if (engine === 'prometheus') {
    return obfuscateWithPrometheus(source, options);
  }
  if (engine === 'local') {
    return obfuscateLocally(source);
  }
  if (engine !== 'auto') throw new Error(`unknown engine: ${engine}`);

  let result = await tryEngine('wearedevs', () => obfuscateWithWeAreDevs(source, options));
  if (result) return result;
  result = await tryEngine('prometheus', () => obfuscateWithPrometheus(source, options));
  if (result) return result;
  result = await tryEngine('local', () => obfuscateLocally(source));
  if (result) return result;

  throw new Error(`every obfuscation engine failed:\n  ${failures.join('\n  ')}`);
}

const SUBSTITUTIONS = {
  loada: [['@NEXT@', 'https://example.invalid/' + 'a'.repeat(40)], ['@NEXT_SHA@', 'a'.repeat(64)], ['@NONCE@', 'b'.repeat(32)]],
  loader: [['@NEXT@', 'https://example.invalid/' + 'a'.repeat(40)], ['@NEXT_SHA@', 'a'.repeat(64)], ['@NONCE@', 'b'.repeat(32)], ['@BASE_URL@', 'https://example.invalid']],
  payload: [['@BASE_URL@', 'https://example.invalid']],
  loadc: [['__STAGE2_TOKEN__', 'a'.repeat(32) + '.1700000000000.' + 'b'.repeat(32)], ['__BASE_URL__', 'https://example.invalid'], ['__STAGE2_SHA256__', 'c'.repeat(64)], ['__STAGE2_NONCE__', 'd'.repeat(32)]],
  main: [['${SCRIPTID}', 'main']],
};

let luaparse = null;
try { luaparse = require('luaparse'); } catch { luaparse = null; }

function syntaxCheck(name, text) {
  if (!luaparse) return;
  let substituted = text;
  for (const [token, value] of SUBSTITUTIONS[name] || []) substituted = substituted.split(token).join(value);
  try {
    luaparse.parse(substituted, { luaVersion: '5.1' });
  } catch (error) {
    throw new Error(`${name}: produced invalid Lua (${error.message})`);
  }
}

function assembleObfuscated(name, header, body, engineDetail) {
  return [
    `${OBF_MARKER} ${engineDetail}`,
    layout.prettyHeader(header),
    layout.wrapBody(name, body),
    '',
  ].join('\n');
}

function writeManifest(dir, files, meta) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    ...meta,
    files,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function log(message) {
  console.log(`[obf] ${message}`);
}

function parseArgs(argv) {
  const options = {
    engine: 'auto',
    out: DEFAULT_OUT,
    preset: process.env.OBF_PRESET || 'Strong',
    zip: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--engine' || arg === '-e') options.engine = argv[++i];
    else if (arg === '--out' || arg === '-o') options.out = path.resolve(argv[++i]);
    else if (arg === '--preset' || arg === '-p') options.preset = argv[++i];
    else if (arg === '--no-zip') options.zip = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('node source/obf-build.js [--engine auto|wearedevs|prometheus|local] [--preset Strong] [--out DIR] [--no-zip]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.out;
  fs.mkdirSync(path.join(outDir, 'scripts'), { recursive: true });
  log(`output: ${path.relative(ROOT, outDir) || outDir}`);
  log(`engine: ${options.engine}`);

  const files = {};
  const engines = new Set();
  for (const name of ['loada', 'loader', 'payload', 'loadc', 'main']) {
    const spec = layout.stageSpec(name);
    const { header, body } = layout.splitSource(name);
    log(`obfuscating ${name} (${body.length} bytes body)`);
    const result = await obfuscateBody(body, options.engine, { preset: options.preset });
    const final = assembleObfuscated(name, header, result.body, result.detail);
    layout.validate(name, final, { body: result.body });
    syntaxCheck(name, final);
    const target = path.join(outDir, spec.artifact);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, final);
    engines.add(result.engine);
    files[name] = {
      file: path.relative(outDir, target).split(path.sep).join('/'),
      sha256: sha256(final),
      bytes: Buffer.byteLength(final),
      obfuscated: true,
      engine: result.engine,
      detail: result.detail,
    };
    log(`${name}: ${final.length} bytes -> ${files[name].file}`);
  }

  // The SDK is already obfuscated; ship the exact bytes that are served today.
  const sdkSource = fs.readFileSync(path.join(ROOT, 'artifacts', '999MS-sdk.lua'), 'utf8');
  fs.writeFileSync(path.join(outDir, '999MS-sdk.lua'), sdkSource);
  files.sdk = {
    file: '999MS-sdk.lua',
    sha256: sha256(sdkSource),
    bytes: Buffer.byteLength(sdkSource),
    obfuscated: true,
    engine: 'prebuilt',
    detail: 'shipped 999MS-sdk artifact',
  };

  const primary = [...engines][0];
  const meta = {
    engine: primary,
    engines: [...engines],
    preset: options.preset,
    obfuscated: true,
    marker: OBF_MARKER.trim(),
  };
  writeManifest(outDir, files, meta);

  console.log('\nsummary');
  for (const [name, info] of Object.entries(files)) {
    console.log(`  ${name.padEnd(8)} ${String(info.bytes).padStart(8)} bytes  ${info.engine.padEnd(11)} ${info.sha256}`);
  }
  console.log(`  manifest ${path.join(path.relative(ROOT, outDir) || '.', 'manifest.json')}`);

  if (options.zip) {
    const zipPath = path.join(outDir, '999ms-obf.zip');
    const zip = which('zip');
    if (zip) {
      try {
        fs.rmSync(zipPath, { force: true });
        execFileSync(zip, ['-q', '-r', zipPath, '.'], { cwd: outDir });
        log(`zip: ${path.relative(ROOT, zipPath)}`);
      } catch (error) {
        log(`zip failed: ${error.message}`);
      }
    } else {
      log('zip not installed; skipped archive');
    }
  }
}

module.exports = {
  OBF_MARKER,
  parseWeAreDevs,
  postWeAreDevs,
  obfuscateWithWeAreDevs,
  obfuscateWithPrometheus,
  obfuscateLocally,
  obfuscateBody,
  assembleObfuscated,
  syntaxCheck,
  SUBSTITUTIONS,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[obf] ${error.stack || error.message}`);
    process.exit(1);
  });
}
