#!/usr/bin/env node
// run.mjs: prove the SDK relinks a native extension into both cart engines.
//
// Builds the probe project (a Lua script calling a C++ extension), relinks the
// engines with the SDK, packs a GL and a WebGPU cart, runs each on the
// wasmcart Node host and requires the probe's PASS line. The same project on
// engines relinked WITHOUT the extension (--skip-ext) must FAIL: that is the
// control showing the PASS comes from the linked extension.
//
// Usage: node sdk/test/run.mjs [--sdk DIR] [--bob JAR] [--wasmcart DIR] [--emsdk DIR] [--variant V]
//   --sdk       the SDK (default tmp/wasmcart-defold-sdk, from make-sdk.mjs)
//   --bob       Defold's bob.jar matching the engine version (default $BOB_JAR)
//   --wasmcart  a wasmcart checkout or package (default ../wasmcart)
//   --emsdk     passed through to link.mjs (default $EMSDK)
//   --variant   gl or webgpu to run one cart (default every engine the SDK has;
//               CI runs gl, since a runner has software GL but no WebGPU device)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SDK = path.resolve(opt('--sdk', path.join(ROOT, 'tmp/wasmcart-defold-sdk')));
const BOB = opt('--bob', process.env.BOB_JAR);
const WASMCART = path.resolve(opt('--wasmcart', path.join(ROOT, '../wasmcart')));
const EMSDK = opt('--emsdk', process.env.EMSDK);
const JAVA = process.env.JAVA || 'java';
const ONLY = opt('--variant', null);

function fail(msg) { console.error(`sdk test: FAIL ${msg}`); process.exit(1); }
if (!BOB || !fs.existsSync(BOB)) fail('pass --bob <bob.jar> or set BOB_JAR');
if (!fs.existsSync(path.join(SDK, 'sdk.json'))) fail(`no SDK at ${SDK}; run sdk/make-sdk.mjs first`);

const PROJECT = path.join(HERE, 'probe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmcart-defold-sdktest-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

execFileSync(JAVA, ['-jar', BOB, '--root', PROJECT, '--platform', 'wasm-web', '--archive',
  '--use-uncompressed-lua-source', '--debug-output-wgsl', 'true', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
const assets = path.join(work, 'assets');
fs.mkdirSync(assets);
for (const f of ['game.arci', 'game.arcd', 'game.dmanifest', 'game.projectc']) {
  fs.copyFileSync(path.join(PROJECT, 'build/default', f), path.join(assets, f));
}

const { CartHost } = await import(pathToFileURL(path.join(WASMCART, 'index.js')).href);
const pack = path.join(WASMCART, 'bin/wasmcart-pack.js');

async function runCart(wasm, label) {
  const cart = path.join(work, `${label}.wasc`);
  execFileSync(process.execPath, [pack, '--wasm', wasm, '--assets', assets, '--name', 'sdkprobe',
    '--width', '320', '--height', '240', '--output', cart], { stdio: 'ignore' });
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  const host = new CartHost();
  try {
    await host.load(cart, { adapterOptions: { powerPreference: 'low-power' } });
    for (let f = 0; f < 10; f++) host.runFrame([]);
  } finally {
    host.destroy?.();
    Object.assign(console, orig);
  }
  return lines.map(l => l.trim()).find(l => l.includes('sdkprobe:')) || `(no sdkprobe line; the cart printed ${lines.length} lines)`;
}

const link = (out, extra) => execFileSync(process.execPath, [path.join(SDK, 'link.mjs'), PROJECT, '--out', out,
  ...(EMSDK ? ['--emsdk', EMSDK] : []), ...extra], { stdio: ['ignore', 'inherit', 'inherit'] });

const manifest = JSON.parse(fs.readFileSync(path.join(SDK, 'sdk.json'), 'utf8'));
const withExt = path.join(work, 'with'), without = path.join(work, 'without');
link(withExt, []);
link(without, ['--skip-ext', 'SdkProbe']);

let bad = 0;
for (const [variant, spec] of Object.entries(manifest.variants)) {
  if (ONLY && variant !== ONLY) continue;
  const got = await runCart(path.join(withExt, spec.output), `${variant}-with`);
  const ctl = await runCart(path.join(without, spec.output), `${variant}-without`);
  const ok = /sdkprobe: PASS/.test(got), ctlFailed = /sdkprobe: FAIL/.test(ctl);
  console.log(`${variant.padEnd(6)} with the extension:    ${got}`);
  console.log(`${variant.padEnd(6)} without (control):     ${ctl}`);
  if (!ok) { bad++; console.log(`  -> the relinked ${variant} engine did not run the extension`); }
  if (!ctlFailed) { bad++; console.log(`  -> the control did not fail, so the PASS proves nothing`); }
}
if (bad) fail(`${bad} check(s) failed`);
console.log('sdk test: PASS');
process.exit(0);
