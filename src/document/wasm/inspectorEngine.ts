/**
 * The REAL inspector engine: `@firecrawl/pdf-inspector-wasm@1.25.2`.
 *
 * It satisfies the same `InspectorEngine` interface as `FakeInspector`, so the
 * adapter, the worker and every existing test are unchanged. Nothing above
 * this file knows whether it is talking to the real parser or a test double.
 *
 * TWO FACTS FROM THE REAL API THAT SHAPED THIS FILE (verified against 1.25.2,
 * not inferred from docs):
 *
 * 1. `markdown` is ONE FLAT STRING for the whole document. There is no
 *    per-page structure at all. The ONLY thing that makes a page boundary
 *    addressable is `includePageMarkers: true`, which inserts `<!-- Page N -->`
 *    lines. See ./pageMapping.ts for how those become zero-based page indexes.
 *
 * 2. EVERY call is SYNCHRONOUS after `init()` and blocks the calling thread.
 *    There is no async variant, no yield, and no cancel. That is why this
 *    module is not the place concurrency lives: the job queue and the watchdog
 *    in ../jobs.ts and ../workers/inspector.worker.ts exist precisely because
 *    of this file, and cancelling means terminating the worker.
 *
 * PAGE INDEX CONVENTION — this class is deliberately index-agnostic. Upstream
 * `processPdf` takes 1-INDEXED pages and rejects `pages: [0]`; `classifyPdf`
 * returns 0-INDEXED `pagesNeedingOcr`. Both shapes are passed through
 * untouched. The single zero-based <-> one-based conversion lives in
 * ../pageSplit.ts (`toUpstreamPages` outbound, `scanPageMarkers` inbound).
 * Adding a second conversion here would be the exact off-by-one the spec
 * forbids, so it is not here.
 */

import initWasm from "@firecrawl/pdf-inspector-wasm";
import {
  classifyPdf as wasmClassifyPdf,
  detectPdf as wasmDetectPdf,
  extractText as wasmExtractText,
  processPdf as wasmProcessPdf,
  version as wasmVersion,
} from "@firecrawl/pdf-inspector-wasm";
import type {
  InspectorClassification,
  InspectorEngine,
  InspectorOptions,
  InspectorProcessResult,
} from "../types.ts";

/**
 * Whatever the real `__wbg_init` accepts. A `Uint8Array` (Node, tests, the
 * benchmark) or a URL string (browser, served by Vite as a hashed asset).
 * These are the package's own `InitInput` members, narrowed to the two this
 * project uses rather than importing the full wasm-bindgen type surface.
 */
export type WasmInitInput = Uint8Array | string;

/**
 * Instantiate the WASM module. Idempotent: the wasm-bindgen glue caches the
 * instance and returns it on every later call, so racing callers (two windows,
 * a retry after a watchdog termination) cannot double-initialize.
 *
 * MUST be awaited before any engine method is called. The returned engine
 * throws a named error rather than trapping inside WASM if it was not.
 */
export const initInspectorWasm = async (input: WasmInitInput): Promise<void> => {
  await initWasm({ module_or_path: input });
};

let initialized = false;

/**
 * A real `InspectorEngine` over the actual WASM exports.
 *
 * Construct it through `createWasmInspector`, which awaits init first. The
 * class itself is exported for the rare caller that wants to construct against
 * an already-initialized module, and its methods still refuse to run before
 * init — a missing init otherwise surfaces as a wasm-bindgen
 * "uninitialized" panic with no useful message.
 */
export class WasmInspector implements InspectorEngine {
  // An explicit field, not a constructor parameter property: `node
  // --experimental-strip-types` (how the benchmark runs this code) cannot
  // erase a parameter property, so the shorthand would make the whole engine
  // unloadable outside a bundler.
  private readonly requireInit: () => void;

  constructor(requireInit: () => void) {
    this.requireInit = requireInit;
  }

  version(): string {
    this.requireInit();
    return wasmVersion();
  }

  processPdf(bytes: Uint8Array, options?: InspectorOptions): InspectorProcessResult {
    this.requireInit();
    // `pages` is forwarded exactly as the adapter built it. Upstream rejects 0
    // and the adapter never sends it; this layer does not re-index.
    return wasmProcessPdf(bytes, {
      ...(options?.pages !== undefined ? { pages: [...options.pages] } : {}),
      ...(options?.password !== undefined ? { password: options.password } : {}),
      ...(options?.profile !== undefined ? { profile: options.profile } : {}),
      ...(options?.includePageMarkers !== undefined
        ? { includePageMarkers: options.includePageMarkers }
        : {}),
      ...(options?.includeImages !== undefined ? { includeImages: options.includeImages } : {}),
    });
  }

  /** NOTE: upstream returns 0-INDEXED pages here, unlike `processPdf`. */
  classifyPdf(bytes: Uint8Array): InspectorClassification {
    this.requireInit();
    return wasmClassifyPdf(bytes);
  }
}

const NOT_INITIALIZED =
  "inspector WASM is not initialized: await createWasmInspector() before using the engine";

/** State for the in-flight init, so concurrent callers await ONE promise. */
let pending: Promise<InspectorEngine> | null = null;

/**
 * The production engine. Awaits WASM init once and returns the same engine to
 * every concurrent caller; `input` is only used by whichever call wins the
 * race, which is why callers in one document should pass the same bytes or URL.
 */
export const createWasmInspector = (input: WasmInitInput): Promise<InspectorEngine> => {
  if (pending !== null) return pending;
  initialized = false;
  pending = initInspectorWasm(input)
    .then(() => {
      initialized = true;
      // The engine identity in every SemanticPage and extraction key. Read from
      // the module itself, never from package.json: a lockfile bump and a
      // shipped binary must not be able to disagree.
      return new WasmInspector(() => {
        if (!initialized) throw new Error(NOT_INITIALIZED);
      }) as InspectorEngine;
    })
    .catch((e: unknown) => {
      // A failed init must not poison later retries with a rejected promise.
      pending = null;
      throw e;
    });
  return pending;
};

/** True once the module has initialized. For capability reporting. */
export const isWasmReady = (): boolean => initialized;

/**
 * Detection without text extraction. Not on `InspectorEngine` because the
 * adapter has no use for it, and adding an unused method to the interface would
 * push a test-double burden onto `FakeInspector`. Used by the benchmark to
 * measure parse-only cost separately from markdown conversion.
 */
export const detectOnly = (bytes: Uint8Array): { pdfType: string; pageCount: number; processingTimeMs: number } => {
  if (!initialized) throw new Error(NOT_INITIALIZED);
  const r = wasmDetectPdf(bytes);
  return { pdfType: r.pdfType, pageCount: r.pageCount, processingTimeMs: r.processingTimeMs };
};

/** Raw plain-text extraction. Benchmark-only; the app normalizes Markdown. */
export const extractRawText = (bytes: Uint8Array): string => {
  if (!initialized) throw new Error(NOT_INITIALIZED);
  return wasmExtractText(bytes);
};
