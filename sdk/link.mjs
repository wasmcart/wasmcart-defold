#!/usr/bin/env node
// link.mjs: relink the wasmcart-defold cart engines with a project's native
// extensions, using the prebuilt engine libraries in this SDK.
//
// Usage: node link.mjs <project-dir> [options]
//   --out DIR        where the engines go (default <project>/build/wasmcart-engine)
//   --variant V      gl, dual or all (default all the SDK has)
//   --ext DIR        an extra extension folder (repeatable)
//   --skip-ext NAME  leave out a native extension the project has (repeatable).
//                    With --ext, this replaces a project's extension with
//                    another of the same name: --skip-ext never drops an --ext.
//   --emsdk DIR      the emsdk to compile with (default $EMSDK, else em++ on PATH)
//
// Extensions are found the way bob finds them: every folder with an
// ext.manifest under the project, plus the library zips bob resolved into
// <project>/.internal/lib (run `bob.jar resolve` first if the project has
// dependencies). A project with no native extensions gets the stock engines
// back, relinked.
//
// Compiled the way Defold's Extender compiles for wasm-web (sdk.json has the
// flags), linked with the engine's own link line. Extension JavaScript
// (lib/web/*.js, --js-library) has no place in a cart, which has no JS: it is
// skipped with a warning, and any import it would have satisfied is reported
// after the link, by name, rather than failing later at load.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(SDK, 'sdk.json'), 'utf8'));

function fail(msg) { console.error(`link: ${msg}`); process.exit(1); }

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
let project = null, outDir = null, variantArg = 'all', emsdk = process.env.EMSDK || null;
const extraExts = [], skipExts = new Set();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outDir = argv[++i];
  else if (a === '--variant') variantArg = argv[++i];
  else if (a === '--ext') extraExts.push(path.resolve(argv[++i]));
  else if (a === '--skip-ext') skipExts.add(argv[++i]);
  else if (a === '--emsdk') emsdk = argv[++i];
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else project = path.resolve(a);
}
if (!project) fail('usage: node link.mjs <project-dir> [--out DIR] [--variant gl|dual|all] [--ext DIR] [--skip-ext NAME] [--emsdk DIR]');
outDir = path.resolve(outDir || path.join(project, 'build/wasmcart-engine'));
const variants = variantArg === 'all' ? Object.keys(manifest.variants) : variantArg.split(',');
for (const v of variants) if (!manifest.variants[v]) fail(`this SDK has no ${v} engine (it has: ${Object.keys(manifest.variants).join(', ')})`);

// --- toolchain ---------------------------------------------------------------
function findTool(name) {
  const cands = [];
  if (emsdk) cands.push(path.join(emsdk, 'upstream/emscripten', name), path.join(emsdk, name));
  for (const d of (process.env.PATH || '').split(path.delimiter)) cands.push(path.join(d, name));
  return cands.find(p => fs.existsSync(p)) || null;
}
const EMXX = findTool('em++');
if (!EMXX) fail('em++ not found: pass --emsdk or set EMSDK');
const emVer = execFileSync(EMXX, ['--version'], { encoding: 'utf8' }).split('\n')[0];
if (manifest.emscripten && !emVer.includes(manifest.emscripten)) {
  fail(`the engine libraries were built with emscripten ${manifest.emscripten}, but ${EMXX} is: ${emVer}\n` +
    `      objects from a different emscripten do not link reliably with them; install ${manifest.emscripten}`);
}

// --- ext.manifest (a small YAML subset: nested maps, scalars, [lists], - lists)
function parseScalar(s) {
  s = s.trim();
  if (s === '') return null;
  if (s.startsWith('[')) {
    try { return JSON.parse(s.replace(/'/g, '"')); } catch {
      return s.slice(1, -1).split(',').map(x => parseScalar(x)).filter(x => x !== null);
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}
function parseYaml(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+#.*$/, '').replace(/^#.*$/, '')).filter(l => l.trim());
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let lastKey = null, lastParent = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (body.startsWith('- ')) {
      if (lastParent && lastKey) {
        if (!Array.isArray(lastParent[lastKey])) lastParent[lastKey] = [];
        lastParent[lastKey].push(parseScalar(body.slice(2)));
      }
      continue;
    }
    const m = body.match(/^("?)([^":]+)\1\s*:\s*(.*)$/);
    if (!m) continue;
    const [, , key, rest] = m;
    if (rest === '') {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = parseScalar(rest);
    }
    lastKey = key; lastParent = parent;
  }
  return root;
}

// --- extension discovery -----------------------------------------------------
/**
 * The dependency zips bob resolved for a project. .internal/lib keeps every
 * zip ever downloaded there, a stale one included when a dependency is
 * re-pinned, and dependencies.json names the current set: each entry's zip is
 * named by the SHA-1 of its url.
 */
function dependencyZips(libDir) {
  if (!fs.existsSync(libDir)) return [];
  const zips = fs.readdirSync(libDir).filter(f => f.endsWith('.zip'));
  const manifest = path.join(libDir, 'dependencies.json');
  if (!fs.existsSync(manifest)) return zips;
  const wanted = JSON.parse(fs.readFileSync(manifest, 'utf8')).map(e => crypto.createHash('sha1').update(e.url).digest('hex'));
  return zips.filter(z => wanted.some(h => z.startsWith(h)));
}

const SKIP_DIRS = new Set(['build', '.internal', '.git', 'node_modules', '.editor_settings']);
function findManifests(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) findManifests(path.join(dir, ent.name), out);
    } else if (ent.name === 'ext.manifest') out.push(dir);
  }
  return out;
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmcart-defold-link-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

const extDirs = [...findManifests(project), ...extraExts];
const libZips = path.join(project, '.internal/lib');
{
  for (const z of dependencyZips(libZips)) {
    const dst = path.join(work, 'deps', z.replace(/\.zip$/, ''));
    fs.mkdirSync(dst, { recursive: true });
    execFileSync('unzip', ['-q', '-o', path.join(libZips, z), '-d', dst]);
    extDirs.push(...findManifests(dst));
  }
}

const PLATFORM_KEYS = ['common', 'web', 'wasm-web'];
const SOURCE_RE = /\.(cpp|c|cc|cxx|c\+\+)$/i;
function listFiles(dir, re, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, re, out);
    else if (re.test(ent.name)) out.push(p);
  }
  return out;
}

const exts = [];
for (const dir of extDirs) {
  const m = parseYaml(fs.readFileSync(path.join(dir, 'ext.manifest'), 'utf8'));
  const name = m.name;
  if (!name) fail(`${dir}/ext.manifest has no name`);
  if (skipExts.has(name) && !extraExts.includes(dir)) { console.log(`link: skipping extension ${name} (--skip-ext)`); continue; }
  const ctx = { defines: [], flags: [], linkFlags: [], libs: [], symbols: [], excludeSymbols: [], excludeLibs: [], includes: [] };
  for (const k of PLATFORM_KEYS) {
    const c = m.platforms?.[k]?.context;
    if (!c) continue;
    for (const f of Object.keys(ctx)) if (Array.isArray(c[f])) ctx[f].push(...c[f]);
  }
  const sources = listFiles(path.join(dir, 'src'), SOURCE_RE);
  const libDirs = ['wasm-web', 'web'].map(p => path.join(dir, 'lib', p)).filter(p => fs.existsSync(p));
  const archives = libDirs.flatMap(d => listFiles(d, /\.a$/));
  const jsLibs = libDirs.flatMap(d => listFiles(d, /\.js$/));
  // A manifest with no sources and no prebuilt libraries carries only content
  // or editor plugins (defold-pbr does): nothing to link, and its name is not
  // a symbol anything defines.
  if (!sources.length && !archives.length) {
    if (jsLibs.length) console.warn(`link: ${name}: only JavaScript (a cart has no JS), skipped: ${jsLibs.map(p => path.basename(p)).join(', ')}`);
    continue;
  }
  exts.push({ name, dir, ctx, sources, archives, libDirs, jsLibs });
}

// --- compile -----------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const objDir = path.join(work, 'obj');
const baseCompile = [
  ...manifest.compile.flags,
  ...manifest.compile.defines.map(d => `-D${d}`),
  ...manifest.compile.includes.map(i => `-I${path.join(SDK, i)}`),
];
const extObjects = [], extLibs = [], extLinkFlags = [];
for (const e of exts) {
  if (e.jsLibs.length) {
    console.warn(`link: ${e.name}: skipping ${e.jsLibs.length} JavaScript librar${e.jsLibs.length === 1 ? 'y' : 'ies'} (a cart has no JS): ${e.jsLibs.map(p => path.basename(p)).join(', ')}`);
  }
  const incs = [path.join(e.dir, 'include'), path.join(e.dir, 'src'), ...e.ctx.includes.map(i => path.resolve(e.dir, i))]
    .filter(p => fs.existsSync(p)).map(p => `-I${p}`);
  const extra = [`-DDLIB_LOG_DOMAIN="${e.name}"`, ...e.ctx.defines.map(d => `-D${d}`), ...e.ctx.flags];
  for (const src of e.sources) {
    const rel = path.relative(e.dir, src).replace(/[\\/]/g, '_');
    const obj = path.join(objDir, e.name, `${rel}.o`);
    fs.mkdirSync(path.dirname(obj), { recursive: true });
    const isC = /\.c$/i.test(src);
    const cmd = [...baseCompile, ...(isC ? ['-x', 'c', '-std=c11'] : ['-std=c++17']), ...extra, ...incs, '-c', src, '-o', obj];
    if (isC) { const i = cmd.indexOf('-fno-rtti'); if (i >= 0) cmd.splice(i, 1); }
    try {
      execFileSync(EMXX, cmd, { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      fail(`${e.name}: failed to compile ${path.relative(e.dir, src)}`);
    }
    extObjects.push(obj);
  }
  extLibs.push(...e.archives);
  for (const l of e.ctx.libs) {
    if (l.endsWith('.js')) continue;
    const found = e.libDirs.map(d => path.join(d, `lib${l}.a`)).find(p => fs.existsSync(p));
    extLibs.push(found || `-l${l}`);
  }
  extLinkFlags.push(...e.ctx.linkFlags);
  console.log(`link: ${e.name}: ${e.sources.length} source file${e.sources.length === 1 ? '' : 's'}, ${e.archives.length} prebuilt librar${e.archives.length === 1 ? 'y' : 'ies'}`);
}

// --- link --------------------------------------------------------------------
function wasmImports(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
  return WebAssembly.Module.imports(mod).map(i => `${i.module}.${i.name}`);
}

for (const v of variants) {
  const spec = manifest.variants[v];
  const excludeSyms = new Set(exts.flatMap(e => e.ctx.excludeSymbols));
  const excludeLibs = new Set(exts.flatMap(e => e.ctx.excludeLibs));
  const symbols = [...spec.symbols.filter(s => !excludeSyms.has(s)),
    ...exts.flatMap(e => [e.name, ...e.ctx.symbols])];
  const uniq = [...new Set(symbols)];
  const symSrc = path.join(work, `exported_symbols_${v}.cpp`);
  fs.writeFileSync(symSrc,
    uniq.map(s => `extern "C" void ${s}();`).join('\n') +
    '\n\nextern "C" void dmExportedSymbols() {\n' + uniq.map(s => `    ${s}();`).join('\n') + '\n}\n');
  const symObj = path.join(work, `exported_symbols_${v}.o`);
  execFileSync(EMXX, [...baseCompile, '-std=c++17', '-c', symSrc, '-o', symObj], { stdio: 'inherit' });

  const engineLibs = spec.libs.filter(l => !excludeLibs.has(path.basename(l).replace(/^lib|\.a$/g, '')))
    .map(l => path.join(SDK, l));
  const out = path.join(outDir, spec.output);
  const cmd = [
    ...spec.flags,
    ...spec.jsLibs.map(j => `--js-library=${path.join(SDK, j)}`),
    ...(spec.port ? [`--use-port=${path.join(SDK, spec.port)}`] : []),
    ...extLinkFlags,
    ...spec.objects.map(o => path.join(SDK, o)),
    symObj,
    ...extObjects,
    '-o', out,
    ...extLibs,
    ...engineLibs,
  ];
  try {
    execFileSync(EMXX, cmd, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    fail(`linking the ${v} engine failed`);
  }
  // Leave only the cart: em++ writes a symbol map beside it.
  for (const extra of ['.symbols', '.js.symbols']) fs.rmSync(out.replace(/\.wasm$/, extra), { force: true });
  fs.rmSync(out + '.symbols', { force: true });

  const known = new Set(spec.imports || []);
  const unknown = known.size ? wasmImports(out).filter(i => !known.has(i)) : [];
  if (unknown.length) {
    console.warn(`link: WARNING ${spec.output} imports ${unknown.length} function${unknown.length === 1 ? '' : 's'} the stock engine does not, ` +
      `so no wasmcart host provides ${unknown.length === 1 ? 'it' : 'them'} and the cart will not load:\n  ${unknown.join('\n  ')}\n` +
      `  These usually come from an extension's browser-only code. Leave it out with --skip-ext <name>, or give it a cart path.`);
    process.exitCode = 2;
  }
  console.log(`link: ${out} (${fs.statSync(out).size} bytes)`);
}
