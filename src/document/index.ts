/**
 * Track E module surface. Everything semantic is pure logic except the worker,
 * which is a message loop over the adapter.
 *
 * Import from `./document/index.ts` in app code; tests import the leaf modules
 * directly so a failure names the unit, not the barrel.
 */

export type {
  ExtractedPage,
  InspectorCmapGap,
  InspectorClassification,
  InspectorEngine,
  InspectorOptions,
  InspectorPdfType,
  InspectorProcessResult,
  PageSplit,
} from "./types.ts";
export { INSPECTOR_ENGINE, NORMALIZER_VERSION, SEMANTIC_SCHEMA_VERSION } from "./types.ts";

export { extractionKey, extractionKeysFor, optionsHash } from "./cacheKey.ts";
export type { ExtractionKeyParts, ExtractionOptions } from "./cacheKey.ts";

export { blockAt, normalizeMarkdown, normalizerVersion, quoteAround, textLength } from "./normalizer.ts";

export { PAGE_MARKER, PAGE_MARKER_OPTION, scanPageMarkers, splitByPageMarkers, toUpstreamPages, validatePageIndexes } from "./pageSplit.ts";

export { assessPageQuality, countReplacementChars, garbleRatio, REPLACEMENT_CHAR, routeSemanticWork } from "./quality.ts";
export type { QualityInput, QualityVerdict, RoutingDecision } from "./quality.ts";

export {
  NORMALIZE_VERSION,
  alignSelection,
  indexPage,
  indexPages,
  normalizeForMatch,
  toOriginalOffset,
  toOriginalRange,
} from "./align.ts";
export type { Aligned, AlignInput, AlignResult, IndexedPage, MatchKind, NormalizedText, SemanticPageInput } from "./align.ts";

export { bumpGeneration, handleResponses, isCurrent, openGuard } from "./generation.ts";
export type { Generation, GenerationGuard, StaleEvent } from "./generation.ts";

export {
  DEFAULT_WATCHDOG_MS,
  DESKTOP_RADIUS,
  MAX_QUEUED_JOBS,
  PHONE_RADIUS,
  cancelActive,
  completeJob,
  emptyQueue,
  enqueue,
  enqueueBounded,
  isObsolete,
  nextJob,
  semanticWindow,
  shouldTerminate,
} from "./jobs.ts";
export type { Job, Priority, QueueState, WindowInput } from "./jobs.ts";

export {
  adapterOptionsHash,
  closeAdapter,
  createAdapter,
  extractPages,
  toSemanticPage,
} from "./adapter.ts";
export type { AdapterError, AdapterInit, ExtractResult, InspectorAdapter } from "./adapter.ts";

export { FakeInspector, fakeMarker } from "./fakeInspector.ts";
export type { FakeInspectorSpec, FakePageSpec } from "./fakeInspector.ts";

// The real parser. `loadInspectorEngine` is the production entry point: it
// resolves the `.wasm` for the environment and returns an engine that satisfies
// the same `InspectorEngine` interface `FakeInspector` does, so nothing above
// the adapter changes when the fake is swapped for the real thing.
export {
  createWasmInspector,
  detectOnly,
  extractRawText,
  initInspectorWasm,
  isWasmReady,
  loadInspectorEngine,
  WasmInspector,
} from "./wasm/index.ts";
export type { WasmInitInput } from "./wasm/index.ts";

export { associatePages } from "./wasm/pageMapping.ts";
export type { AssociatedPage, Association, AssociateOptions } from "./wasm/pageMapping.ts";
