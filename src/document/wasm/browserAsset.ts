/**
 * Browser-only WASM asset resolution for the real inspector.
 *
 * WHY A SEPARATE MODULE: `?url` is a Vite-only import suffix. Node cannot
 * resolve it, and the benchmark and the integration test both run in Node, so
 * this file is only ever reached through a guarded DYNAMIC import from
 * ./index.ts. A static import here would make the whole engine unloadable
 * outside Vite.
 *
 * WHY A FUNCTION, NOT A TOP-LEVEL `await`: Vite's default build target is
 * `es2020`, which has no top-level await. A module-level
 * `export const URL = (await import("...?url")).default` fails the production
 * build outright with
 *   "Top-level await is not available in the configured target environment"
 * — verified, not assumed. Raising `build.target` would fix it, but
 * vite.config.ts is not this track's file to change, so the module is shaped to
 * fit the target that exists. Returning a promise also happens to be what the
 * caller wants, since WASM init is async anyway.
 *
 * `?url` makes Vite treat the `.wasm` as an asset and hand back a served URL.
 * The `new URL("...", import.meta.url)` form does NOT work for a path inside
 * node_modules: Vite rewrites the module id, so the emitted URL points at the
 * bundle rather than the package.
 */

/**
 * The served URL of the packaged `.wasm`, hashed into the production asset
 * directory. Rejects if the asset cannot be resolved, which the caller turns
 * into a `fallback-only` capability rather than a silent parse failure.
 */
export const loadInspectorWasmUrl = async (): Promise<string> =>
  (await import("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm?url")).default;
