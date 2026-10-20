# wasmcart-defold SDK

The cart engines as prebuilt static libraries, so a game with Defold native
extensions can be relinked into a cart engine in seconds, without building
Defold.

A Defold project that uses only Lua needs none of this: pack it with the stock
`dmengine_wasmcart.wasm` (or the dual GL + WebGPU `dmengine_wasmcart_dual.wasm`). A project whose
dependencies include C++ (an `ext.manifest` with sources), such as
extension-spine, needs an engine with that code linked in. Defold's editor
gets one from its build server; a cart gets one from this SDK.

## What is in it

| Path | |
| --- | --- |
| `lib/` | the engine's static libraries (wasm objects), 48 of them |
| `obj/gl`, `obj/dual` | the cart entry point (`wc_get_info`/`wc_init`/`wc_render`), built once per engine |
| `include/` | the headers an extension compiles against, laid out as Defold's Extender lays them out |
| `emdawnwebgpu_pkg/` | the Dawn emdawnwebgpu release the dual engine links, the same one the wasmcart host's WebGPU glue was generated from |
| `js/` | the engine's emscripten JS libraries, kept only because the link line names them; a cart imports none of their functions |
| `sdk.json` | versions, the extension compile flags, and each engine's link line, exported symbols and import list |
| `link.mjs` | the relink tool |

## Use

Needs Node 22 or newer and the emsdk version `sdk.json` names (`4.0.6`),
activated or passed with `--emsdk`. Objects from another emscripten do not
link reliably with these libraries, so `link.mjs` refuses one.

```bash
# resolve the project's dependencies first, if it has any
java -jar bob.jar --root mygame resolve

node wasmcart-defold-sdk/link.mjs mygame --out mygame/build/engine
# -> mygame/build/engine/dmengine_wasmcart.wasm
#    mygame/build/engine/dmengine_wasmcart_dual.wasm
```

Then build the content with bob as usual (`--platform wasm-web --archive
--use-uncompressed-lua-source`, plus `--debug-output-wgsl true` for a dual
cart) and pack it with the relinked engine as the cart's `--wasm`.

`link.mjs` finds extensions the way bob does: every folder with an
`ext.manifest` in the project, and in the dependency zips bob resolved into
`.internal/lib`. Options:

- `--variant gl|dual` relinks one engine instead of both.
- `--ext DIR` adds an extension folder from outside the project.
- `--skip-ext NAME` leaves one out, by its manifest `name`.

A project with no native extensions gets the stock engines back, byte for
byte the ones the full build produced.

## How it compiles and links

Each extension source is compiled the way Defold's Extender compiles for
`wasm-web` (`share/extender/build/wasm-web/build.yml`), with the defines and
flags from the manifest's `common`, `web` and `wasm-web` platform contexts.
Two additions for a cart: `-sSUPPORT_LONGJMP=wasm`, which the whole engine
uses because a cart host has no JS to run emscripten's longjmp trampolines,
and `DM_PLATFORM_WASMCART`, so extension code can tell a cart from a browser
build (`DM_PLATFORM_HTML5` is defined too, as on any web build).

The engine is linked with its own link line, recorded from the build that
made the libraries. The extension's manifest `name` and its `symbols` are
added to the exported-symbols list, which is what keeps the extension in the
binary: a Defold extension registers itself from a static object, and the
linker drops any object nothing refers to. Without this step the link succeeds
and the extension is silently not there.

## What does not carry over from a browser build

A cart has no JavaScript. An extension's `lib/web/*.js` libraries are skipped
with a warning, and anything its C++ calls from them (through
`EM_ASM`/`EM_JS` or a JS library function) becomes an import no wasmcart host
provides. `link.mjs` compares each engine's imports with the stock engine's
and names any new one, exiting 2, rather than leaving it to fail at load.
Such an extension needs a cart code path (`#if defined(DM_PLATFORM_WASMCART)`)
or `--skip-ext`.

## Making the SDK

From a wasmcart-defold tree, after building the engine (see the top-level
README; set `DEFOLD_EMDAWNWEBGPU_PORT` to include the dual engine):

```bash
node sdk/make-sdk.mjs --tar
# -> tmp/wasmcart-defold-sdk/ and tmp/wasmcart-defold-sdk.tar.gz
```

`sdk/test/run.mjs` proves it: it relinks both engines with a one-function
C++ extension (`sdk/test/probe`), runs each cart on the wasmcart Node host
(the dual one on GL and on WebGPU; `--no-webgpu` skips the latter) and
requires the extension's answer, and requires the same project on engines
relinked without the extension to fail.

```bash
node sdk/test/run.mjs --bob bob.jar --wasmcart ../wasmcart
```
