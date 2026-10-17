#!/usr/bin/env node
// make-sdk.mjs: package a built engine tree as the wasmcart-defold SDK.
//
// The SDK is everything needed to relink the cart engines with extra native
// code (a Defold native extension) without rebuilding Defold: the engine's
// static libraries, the two cart entry objects, the headers an extension
// compiles against, the exact link lines, and link.mjs to drive them.
//
// It reads the link lines straight from the engine build's ninja graph, so the
// SDK relinks exactly what build.py links. Run it after:
//
//   ./scripts/build.py --platform=wasm-web --skip-tests build_engine -- \
//       --skip-build-tests --with-wasmcart
//
// Usage: node sdk/make-sdk.mjs [--out DIR] [--tar]
//   --out  output directory (default tmp/wasmcart-defold-sdk)
//   --tar  also write DIR.tar.gz next to it
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DYNAMO = path.join(ROOT, 'tmp/dynamo_home');
const TOP_BUILD = path.join(ROOT, 'engine/build/wasm-web');
const ENGINE_BUILD = path.join(ROOT, 'engine/engine/build/wasm-web');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'tmp/wasmcart-defold-sdk')));
const TAR = args.includes('--tar');

/** The two engines the SDK can relink, keyed by the name link.mjs uses. */
const VARIANTS = {
  gl: 'dmengine_wasmcart',
  webgpu: 'dmengine_wasmcart_webgpu',
};

function fail(msg) { console.error(`make-sdk: ${msg}`); process.exit(1); }

function linkCommand(target) {
  const out = path.join(ENGINE_BUILD, `${target}.wasm`);
  let text;
  try {
    text = execFileSync('ninja', ['-C', TOP_BUILD, '-t', 'commands', out], { encoding: 'utf8', maxBuffer: 1 << 30 });
  } catch (e) {
    return null;
  }
  const line = text.trim().split('\n').pop();
  if (!line.includes(`${target}.wasm`)) return null;
  // ": && em++ ... && :" is CMake's wrapper around the real command.
  const toks = line.replace(/^:\s*&&\s*/, '').replace(/\s*&&\s*:\s*$/, '').split(/\s+/).filter(Boolean);
  return toks;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst, skip = () => false) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (skip(s, ent)) continue;
    if (ent.isDirectory()) copyTree(s, d, skip);
    else if (ent.isFile()) copyFile(s, d);
  }
}

/** Symbols named in a generated __exported_symbols_*.cpp, in order. */
function exportedSymbols(cppPath) {
  const src = fs.readFileSync(cppPath, 'utf8');
  return [...src.matchAll(/^extern "C" void (\w+)\(\);$/gm)].map(m => m[1]).filter(s => s !== 'dmExportedSymbols');
}

const libDirs = [path.join(DYNAMO, 'lib/wasm-web'), path.join(DYNAMO, 'ext/lib/wasm-web')];
function findLib(name) {
  for (const d of libDirs) {
    const p = path.join(d, `lib${name}.a`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = {
  sdk: 1,
  defold: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(),
  build: execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  emscripten: null,
  emdawnwebgpu: null,
  compile: {
    // Extender's wasm-web compile line (share/extender/build/wasm-web/build.yml),
    // plus what a cart build adds: wasm-native longjmp (the cart host has no JS
    // to run emscripten's longjmp trampolines) and DM_PLATFORM_WASMCART, so an
    // extension can tell a cart from a browser build.
    defines: ['DM_PLATFORM_HTML5', 'DM_PLATFORM_WASMCART', 'DM_LUA_USE_LUA51'],
    flags: ['-O3', '-fno-exceptions', '-fno-rtti', '-fPIC', '-Wno-nontrivial-memcall',
      '-sDISABLE_EXCEPTION_CATCHING=1', '-sSUPPORT_LONGJMP=wasm'],
    includes: ['include/dynamo', 'include/sdk', 'include/ext'],
  },
  variants: {},
};

let ported = false;
for (const [variant, target] of Object.entries(VARIANTS)) {
  const toks = linkCommand(target);
  if (!toks) {
    if (variant === 'gl') fail(`no link line for ${target}; build the engine first (see the header of this file)`);
    console.warn(`make-sdk: ${target} is not in this build (DEFOLD_EMDAWNWEBGPU_PORT unset?); the SDK will relink GL only`);
    continue;
  }
  const v = { output: `${target}.wasm`, objects: [], libs: [], jsLibs: [], flags: [], symbols: [], port: null };
  for (let i = 1; i < toks.length; i++) { // toks[0] is em++
    const t = toks[i];
    if (t === '-o') { i++; continue; }
    if (t.startsWith('-L')) continue;
    if (t === '--js-library' || t.startsWith('--js-library=')) {
      const p = t === '--js-library' ? toks[++i] : t.slice('--js-library='.length);
      const rel = `js/${path.basename(p)}`;
      copyFile(p, path.join(OUT, rel));
      v.jsLibs.push(rel);
      continue;
    }
    if (t.startsWith('--use-port=')) {
      const port = t.slice('--use-port='.length);
      const pkg = path.dirname(port);
      if (!ported) {
        copyTree(pkg, path.join(OUT, 'emdawnwebgpu_pkg'), s => s.includes('__pycache__'));
        ported = true;
        const ver = fs.readFileSync(path.join(pkg, 'VERSION.txt'), 'utf8').match(/release (v[\d.]+)/);
        manifest.emdawnwebgpu = ver ? ver[1] : 'unknown';
      }
      v.port = `emdawnwebgpu_pkg/${path.basename(port)}`;
      continue;
    }
    if (t.endsWith('.o')) {
      const base = path.basename(t);
      if (base.startsWith('__exported_symbols_')) {
        v.symbols = exportedSymbols(path.join(ENGINE_BUILD, base.replace(/\.o$/, '')));
        continue;
      }
      const rel = `obj/${variant}/${base}`;
      copyFile(t, path.join(OUT, rel));
      v.objects.push(rel);
      continue;
    }
    if (t.endsWith('.a')) {
      const rel = `lib/${path.basename(t)}`;
      if (!fs.existsSync(path.join(OUT, rel))) copyFile(t, path.join(OUT, rel));
      v.libs.push(rel);
      continue;
    }
    if (/^-l[\w.+-]+$/.test(t) && !t.endsWith('.js')) {
      const name = t.slice(2);
      const p = findLib(name);
      if (!p) { v.flags.push(t); continue; } // a system library emscripten provides (-lm)
      const rel = `lib/lib${name}.a`;
      if (!fs.existsSync(path.join(OUT, rel))) copyFile(p, path.join(OUT, rel));
      v.libs.push(rel);
      continue;
    }
    // ninja prints the command for a shell; this runs it without one.
    v.flags.push(t.replace(/\\"/g, '"'));
  }
  if (!v.symbols.length) fail(`could not read the exported symbols for ${target}`);
  // What the stock engine imports, so link.mjs can name any import an
  // extension adds: the host provides exactly these and nothing else.
  const wasm = new WebAssembly.Module(fs.readFileSync(path.join(ENGINE_BUILD, `${target}.wasm`)));
  v.imports = WebAssembly.Module.imports(wasm).map(i => `${i.module}.${i.name}`);
  manifest.variants[variant] = v;
}

// Headers, as Extender lays them out: dynamo_home/include, sdk/include and
// ext/include. The per-OS and GPU-API folders other platforms use are left out.
const skipExt = (s, ent) => ent.isDirectory() && /\/ext\/include\/(vulkan|directx|x86_64-|arm64-|armv7-|x86-|win32|js-web|wasm_pthread-web)/.test(s + '/');
copyTree(path.join(DYNAMO, 'include'), path.join(OUT, 'include/dynamo'));
copyTree(path.join(DYNAMO, 'sdk/include'), path.join(OUT, 'include/sdk'));
copyTree(path.join(DYNAMO, 'ext/include'), path.join(OUT, 'include/ext'), skipExt);

const emVersion = path.join(DYNAMO, 'ext/SDKs');
const emDir = fs.existsSync(emVersion) ? fs.readdirSync(emVersion).find(d => d.startsWith('emsdk-')) : null;
manifest.emscripten = emDir ? emDir.slice('emsdk-'.length) : null;

for (const f of ['link.mjs', 'README.md']) copyFile(path.join(HERE, f), path.join(OUT, f));
copyFile(path.join(ROOT, 'LICENSE.txt'), path.join(OUT, 'LICENSE.txt'));
fs.writeFileSync(path.join(OUT, 'sdk.json'), JSON.stringify(manifest, null, 2) + '\n');

const size = execFileSync('du', ['-sh', OUT], { encoding: 'utf8' }).split('\t')[0];
console.log(`make-sdk: ${OUT} (${size}), variants: ${Object.keys(manifest.variants).join(', ')}`);
if (TAR) {
  const tar = `${OUT}.tar.gz`;
  execFileSync('tar', ['-czf', tar, '-C', path.dirname(OUT), path.basename(OUT)]);
  console.log(`make-sdk: ${tar}`);
}
