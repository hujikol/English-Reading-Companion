/**
 * Load the real WASM, in whichever environment is asking.
 *
 * The engine itself takes a `WasmInitInput` (bytes or URL). Deciding WHICH one
 * is this file's job, and the decision is environment-shaped, not feature-
 * shaped:
 *
 *   - Browser / Vite build or dev server: the `.wasm` is emitted as a hashed
 *     asset and fetched from its served URL. That URL comes from the Vite-only
 *     `?url` import in ./browserAsset.ts, reached through a dynamic import so
 *     Node never tries to resolve that suffix.
 *   - Node (vitest, the benchmark): there is no asset pipeline. `fetch` of a
 *     `file:` URL is not implemented, and Vite's dev-server path is not a
 *     filesystem path, so the bytes are read from node_modules directly and
 *     handed to `WebAssembly.instantiate` as a BufferSource.
 *
 * Both paths are verified by running them, not by inspection:
 * tests/semantic/integration/realWasm.test.ts exercises the Node path against
 * real output, and scripts/benchmarks/ asserts the URL form the browser takes.
 *
 * WHY NOT `new URL("...", import.meta.url)`: Vite rewrites the module id of a
 * file inside node_modules, so that URL resolves against the emitted bundle
 * rather than the package and 404s in the built app. `?url` is the form that
 * survives `vite build`. See ./browserAsset.ts.
 */

import type { InspectorEngine } from "../types.ts";
import type { WasmInitInput } from "./inspectorEngine.ts";
import { createWasmInspector } from "./inspectorEngine.ts";

export type { WasmInitInput } from "./inspectorEngine.ts";
export {
  createWasmInspector,
  detectOnly,
  extractRawText,
  initInspectorWasm,
  isWasmReady,
  WasmInspector,
} from "./inspectorEngine.ts";
export type { InspectorEngine } from "../types.ts";

/** True in a browser or a Vite-served worker; false in plain Node. */
const isBrowserLike = (): boolean => typeof window !== "undefined" && typeof document !== "undefined";

/**
 * Resolve the `.wasm` bytes from node_modules. Node-only: uses `createRequire`
 * so the path is derived from module resolution rather than a hardcoded
 * `node_modules/...` path that breaks under a pnpm store or a nested install.
 *
 * The `node:` specifiers are assembled at runtime and the modules are cast
 * through `unknown`. This repo has no `@types/node`, and adding one is outside
 * this track's allowlist; a static `import "node:fs"` would fail `tsc` for a
 * reason that has nothing to do with the code being wrong.
 */
const readWasmBytesFromNodeModules = async (): Promise<Uint8Array> => {
  const req = "node:module";
  const fs = "node:fs";
  const mod = (await import(/* @vite-ignore */ req)) as unknown as {
    createRequire: (url: string) => { resolve: (id: string) => string };
  };
  const readFileSync = (await import(/* @vite-ignore */ fs)) as unknown as {
    readFileSync: (path: string) => Uint8Array;
  };
  const require = mod.createRequire(import.meta.url);
  // `require.resolve` on a .wasm yields the real file path; the package's
  // `files` list ships it next to the glue, so this cannot 404 for a correct
  // install. It is a build-time constant, not user input.
  const path = require.resolve("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm");
  return readFileSync.readFileSync(path);
};

/**
 * The real, initialized engine for the current environment.
 *
 * Idempotent and safe to call from several places: `createWasmInspector`
 * collapses concurrent calls onto one init, and the wasm-bindgen glue caches
 * the instance, so a second call after success returns the same engine without
 * re-instantiating.
 *
 * Throws if the `.wasm` cannot be located. A caller that cannot parse must fall
 * back to PDF.js text (Section 6 fallback table) rather than crash the reader;
 * that decision belongs to the caller, which is why this does not swallow it.
 */
export const loadInspectorEngine = async (): Promise<InspectorEngine> => {
  const input: WasmInitInput = isBrowserLike()
    ? await (await import(/* @vite-ignore */ "./browserAsset.ts")).loadInspectorWasmUrl()
    : await readWasmBytesFromNodeModules();
  return createWasmInspector(input);
};
