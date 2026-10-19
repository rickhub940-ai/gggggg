'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const layout = require('../source/stage-layout');
const obf = require('../source/obf-build');

const ROOT = path.join(__dirname, '..');
const luaparse = require('luaparse');
const luamin = require('luamin');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const DUMMY = {
  loada: [['@NEXT@', 'https://example.invalid/' + 'a'.repeat(40)], ['@NEXT_SHA@', 'a'.repeat(64)], ['@NONCE@', 'b'.repeat(32)]],
  loader: [['@NEXT@', 'https://example.invalid/' + 'a'.repeat(40)], ['@NEXT_SHA@', 'a'.repeat(64)], ['@NONCE@', 'b'.repeat(32)], ['@BASE_URL@', 'https://example.invalid']],
  payload: [['@BASE_URL@', 'https://example.invalid']],
  loadc: [['__STAGE2_TOKEN__', 'a'.repeat(32) + '.1700000000000.' + 'b'.repeat(32)], ['__BASE_URL__', 'https://example.invalid'], ['__STAGE2_SHA256__', 'c'.repeat(64)], ['__STAGE2_NONCE__', 'd'.repeat(32)]],
  main: [['${SCRIPTID}', 'main']],
};

function substitute(name, text) {
  let out = text;
  for (const [token, value] of DUMMY[name] || []) out = out.split(token).join(value);
  return out;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertStageShape(name, text, { body = null, marker = true } = {}) {
  const spec = layout.stageSpec(name);
  for (const token of spec.placeholders) {
    assert.equal(count(text, token), 1, `${spec.artifact}: ${token} must appear exactly once`);
    if (body !== null) assert.equal(count(body, token), 0, `${spec.artifact}: ${token} leaked into the body`);
  }
  if (marker && spec.marker) assert.ok(text.includes(spec.marker), `${spec.artifact}: marker missing`);
  assert.equal(count(text, '__ms999_stage(...,'), 0, `${spec.artifact}: varargs must not be truncated by f(..., x)`);
  luaparse.parse(substitute(name, text), { luaVersion: '5.1' });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function testWeAreDevsClient() {
  const lua = '--[[ v1.0.0 https://wearedevs.net/obfuscator ]] return ' + 'x'.repeat(120);
  const seen = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls += 1;
      seen.push({ method: req.method, headers: req.headers, body });
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '0');
        res.end('slow down');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, obfuscated: lua }));
    });
  });
  const port = await listen(server);
  try {
    const result = await obf.obfuscateWithWeAreDevs('print(1)', {
      url: `http://127.0.0.1:${port}/api/obfuscate`,
      timeoutMs: 3000,
      retryDelays: [0],
      retries: 1,
    });
    assert.equal(result.body, lua);
    assert.equal(result.engine, 'wearedevs');
    assert.equal(result.attempts, 2, 'a 429 is retried once');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].headers.origin, 'https://wearedevs.net');
    assert.equal(seen[1].headers.referer, 'https://wearedevs.net/obfuscator');
    assert.match(seen[1].headers['user-agent'], /Mozilla/);
    assert.deepEqual(JSON.parse(seen[1].body), { script: 'print(1)' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(obf.parseWeAreDevs(JSON.stringify({ obfuscated: lua })), lua);
  assert.equal(obf.parseWeAreDevs(JSON.stringify({ success: false, obfuscated: lua })), null);
  assert.equal(obf.parseWeAreDevs(JSON.stringify({ error: 'nope' })), null);
  assert.equal(obf.parseWeAreDevs(lua), lua);
}

function testLayout() {
  for (const name of Object.keys(layout.STAGES)) {
    const { header, body } = layout.splitSource(name);
    // The plain build compacts the body before assembly, which also removes
    // comments (a `;` before a `--` comment would swallow the rest of a line).
    const minified = luamin.minify(body);
    const plain = layout.assemble(name, minified, { header, compact: true });
    assertStageShape(name, plain, { body: minified });
    const pretty = layout.assemble(name, body, { header, compact: false });
    assertStageShape(name, pretty, { body });
    assert.ok(pretty.includes('local __ms999_unpack = table.unpack or unpack'));
    assert.ok(pretty.includes('__ms999_stage(__ms999_unpack(__ms999_args, 1, __ms999_args.n))'));
  }
}

function testBuiltPlainArtifacts() {
  const manifestPath = path.join(ROOT, 'artifacts', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'run node source/build.js first');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const name of ['loada', 'loader', 'payload', 'loadc']) {
    const info = manifest.files[name];
    const text = fs.readFileSync(path.join(ROOT, 'artifacts', info.file), 'utf8');
    assert.equal(sha256(text), info.sha256, `${info.file} sha`);
    assertStageShape(name, text, { body: null });
  }
  const auth = fs.readFileSync(path.join(ROOT, 'api', 'auth.js'), 'utf8');
  assert.ok(auth.includes(manifest.files.loada.sha256), 'Stage-2 pin matches the built plain artifact');
}

function testObfArtifacts() {
  const dir = path.join(ROOT, 'obf');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('SKIP obf artifacts (run npm run obf)');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.obfuscated, true);
  for (const name of ['loada', 'loader', 'payload', 'loadc', 'main']) {
    const info = manifest.files[name];
    const text = fs.readFileSync(path.join(dir, info.file), 'utf8');
    assert.equal(sha256(text), info.sha256, `${info.file} sha`);
    assert.ok(text.startsWith(obf.OBF_MARKER), `${info.file} starts with the obf marker`);
    assertStageShape(name, text, { body: info.body || null });
  }
  // The body is opaquely obfuscated: the readable prefix must be the marker +
  // header only, and must not contain the actual next-stage values.
  console.log(`OK obf artifacts (${manifest.engine}/${manifest.preset})`);
}

(async () => {
  testLayout();
  await testWeAreDevsClient();
  testBuiltPlainArtifacts();
  testObfArtifacts();
  console.log('PASS obf build');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
