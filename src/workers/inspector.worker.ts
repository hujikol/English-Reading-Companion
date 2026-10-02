/**
 * Dedicated inspector worker (Section 6 step 2: one per active document).
 *
 * This is where the REAL `@firecrawl/pdf-inspector-wasm` is loaded and used.
 * The adapter takes an injected `InspectorEngine`, so this file is the seam:
 * production injects the WASM engine via ../document/wasm/index.ts, and unit
 * tests can still inject `FakeInspector`. Nothing above the adapter changed.
 *
 * WHY EVERYTHING AFTER INIT IS SYNCHRONOUS: `processPdf` blocks the thread
 * until it returns and offers no yield, no async variant and no cancellation.
 * Three consequences are load-bearing, not stylistic:
 *
 *   - The watchdog lives on the MAIN thread and its only correct action is
 *     `worker.terminate()`. A cancel message posted here would queue behind the
 *     running WASM call and arrive after the work it was meant to stop.
 *   - WASM init is the one genuinely async step, so `bootInspectorWorker` does
 *     not attach its `message` listener until init settles. Messages posted
 *     before that are buffered by the worker's own event loop, not dropped, so
 *     an early OPEN is not lost.
 *   - A failed init must still ANSWER. If init rejected and the worker silently
 *     stopped listening, the main thread would wait out its 15s watchdog for a
 *     reply that could never arrive. So failure is reported through the normal
 *     OPEN response with `semantic: "fallback-only"`, and reading continues on
 *     PDF.js text.
 *
 * NO GEOMETRY. `positionedText` is permanently false: the WASM exposes no
 * positioned API and this project does not invent one (ADR 004).
 */

import type { Capabilities, WorkerRequest, WorkerResponse } from "../contracts/index.ts";
import { createAdapter, extractPages } from "../document/adapter.ts";
import { openGuard, bumpGeneration } from "../document/generation.ts";
import { routeSemanticWork } from "../document/quality.ts";
import { INSPECTOR_ENGINE } from "../document/types.ts";
import type { InspectorAdapter } from "../document/adapter.ts";
import type { InspectorEngine } from "../document/types.ts";

/** What the worker is doing now. Tracked so CLOSE can release parser input. */
export type Session = {
  documentId: string;
  generation: number;
  adapter: InspectorAdapter | null;
  pageCount: number;
  password?: string | undefined;
};

const ok = (requestId: string, documentId: string, generation: number, value: unknown): WorkerResponse => ({
  requestId,
  documentId,
  generation,
  ok: true,
  value,
});
const fail = (requestId: string, documentId: string, generation: number, error: string): WorkerResponse => ({
  requestId,
  documentId,
  generation,
  ok: false,
  error,
});

/**
 * Honest capability flags.
 *
 * `semanticAvailable` must reflect an engine that ACTUALLY initialized. The
 * previous hardcoded `true` was accurate only while the WASM was absent and
 * every call fell back anyway; with a real engine present, claiming `inspector`
 * after a failed init would send the reader down a semantic path that always
 * errors. `password: true` because `processPdf` accepts a password; `ocr: false`
 * because this release ships no OCR, so a scanned page renders and says so
 * rather than pretending to have been read.
 */
export const capabilities = (semanticAvailable: boolean): Capabilities => ({
  semantic: semanticAvailable ? "inspector" : "fallback-only",
  password: true,
  ocr: false,
  positionedText: false,
});

export const emptySession = (documentId: string): Session => ({
  documentId,
  generation: 0,
  adapter: null,
  pageCount: 0,
});

/**
 * Pure request handler: no `self`, no WASM, no timers. Fully testable with a
 * fake engine; `bootInspectorWorker` is the only impure wrapper.
 *
 * `engineReady` is passed in rather than read from a module-level flag so the
 * capabilities this reports are always the truth at the moment of the call.
 */
export function handleRequest(
  request: WorkerRequest,
  session: Session,
  guard: { documentId: string; current: number },
  engineReady: boolean,
): { session: Session; guard: { documentId: string; current: number }; response: WorkerResponse } {
  switch (request.type) {
    case "OPEN": {
      // A reopen bumps the generation, so every response from the old session is
      // refused even if it lands late (Section 14).
      const next = bumpGeneration(guard);
      return {
        session: {
          documentId: request.documentId,
          generation: next.current,
          adapter: null,
          pageCount: 0,
          password: request.password,
        },
        guard: next,
        response: ok(request.requestId, request.documentId, next.current, {
          engine: INSPECTOR_ENGINE,
          capabilities: capabilities(engineReady),
        }),
      };
    }

    case "CLASSIFY": {
      if (request.generation < guard.current)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "stale-generation") };
      const adapter = session.adapter;
      if (adapter === null)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "not-open") };
      // CLOSE released the bytes. Saying so beats throwing a WASM error the
      // caller would have to pattern-match.
      if (adapter.bytes === null)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "parser-input-released") };
      try {
        // The DOCUMENT bytes, held once per active document. The previous
        // `new Uint8Array(0)` was harmless against a test double that ignored
        // its input and is fatal against the real engine, which rejects empty
        // input with "Not a PDF: file appears to be plain text".
        const c = adapter.engine.classifyPdf(adapter.bytes);
        return {
          session,
          guard,
          response: ok(request.requestId, request.documentId, request.generation, {
            pdfType: c.pdfType,
            pageCount: c.pageCount,
            // Upstream `classifyPdf` returns 0-INDEXED pages, unlike
            // `processPdf`. Passed through untouched: the adapter owns every
            // conversion, and a second one here is the off-by-one to avoid.
            pagesNeedingOcr: c.pagesNeedingOcr,
            ...routeSemanticWork(c, false),
          }),
        };
      } catch (e) {
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, String(e)) };
      }
    }

    case "EXTRACT": {
      if (request.generation < guard.current)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "stale-generation") };
      const adapter = session.adapter;
      if (adapter === null)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "not-open") };
      const result = extractPages(adapter, request.pageIndexes);
      if (!result.ok)
        return {
          session,
          guard,
          response: fail(request.requestId, request.documentId, request.generation, result.message ?? result.kind),
        };
      return { session, guard, response: ok(request.requestId, request.documentId, request.generation, result) };
    }

    case "CLOSE": {
      // Drop the adapter so its bytes are collectable. WASM linear memory does
      // not shrink on its own, which is why CLOSE matters even though the
      // adapter is cheap to rebuild.
      return {
        session: { ...session, adapter: null, pageCount: 0 },
        guard: bumpGeneration(guard),
        response: ok(request.requestId, request.documentId, guard.current, { released: true }),
      };
    }
  }
}

/** The scope surface this worker needs. Narrow, so a test can fake it. */
export type WorkerScope = {
  postMessage: (m: WorkerResponse) => void;
  addEventListener: (type: "message", handler: (e: { data: WorkerRequest }) => void) => void;
};

/** Builds the adapter for a document's bytes. Injected so this file never
 *  imports the WASM itself and stays testable. */
export type MakeAdapter = (bytes: Uint8Array, password: string | undefined) => InspectorAdapter;

/**
 * Attach the message loop. Assumes the engine is already initialized; use
 * `bootInspectorWorker` for the real entry point.
 */
export const attachWorkerScope = (makeAdapter: MakeAdapter, scope: WorkerScope): { engine: InspectorEngine | null } => {
  let session = emptySession("");
  let guard = openGuard("");
  let engine: InspectorEngine | null = null;

  scope.addEventListener("message", (e) => {
    const request = e.data;
    if (request.type === "OPEN") {
      session = emptySession(request.documentId);
      guard = openGuard(request.documentId);
    }

    // The adapter is built on the first OPEN that carries bytes, so OPEN stays
    // cheap and a document with no semantic work never pays for parsing.
    if (request.type === "OPEN" && request.bytes.byteLength > 0) {
      const adapter = makeAdapter(new Uint8Array(request.bytes), request.password);
      engine = adapter.engine;
      session = { ...session, adapter, pageCount: adapter.pageCount };
    }

    const handled = handleRequest(request, session, guard, engine !== null);
    session = handled.session;
    guard = handled.guard;
    scope.postMessage(handled.response);
  });

  return {
    get engine() {
      return engine;
    },
  };
};

/**
 * The real entry point: initialize the WASM, then attach the message loop.
 *
 * A rejection is caught and recorded rather than thrown, because an unhandled
 * rejection here would leave the worker alive but deaf — the worst outcome,
 * since the main thread's watchdog would terminate a worker that is
 * technically running. Reporting `fallback-only` lets reading proceed on
 * PDF.js text immediately.
 */
export const bootInspectorWorker = async (scope: WorkerScope, loadEngine: () => Promise<InspectorEngine> = defaultEngineLoader): Promise<{
  ready: boolean;
  error: string | null;
}> => {
  try {
    const engine = await loadEngine();
    attachWorkerScope(
      (bytes, password) => createAdapter(engine, { bytes, pageCount: 0, password }),
      scope,
    );
    return { ready: true, error: null };
  } catch (e) {
    // Still attach, so an OPEN gets an honest `fallback-only` answer instead
    // of silence. Every extraction then fails as `not-open`, and the reader
    // uses PDF.js text.
    attachWorkerScope(
      () =>
        createAdapter(
          unavailableEngine(),
          { bytes: new Uint8Array(0), pageCount: 0 },
        ),
      scope,
    );
    return { ready: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** An engine that refuses every call, for the failed-init path. */
const unavailableEngine = (): InspectorEngine => ({
  version: () => "unavailable",
  processPdf: () => {
    throw new Error("inspector WASM failed to initialize");
  },
  classifyPdf: () => {
    throw new Error("inspector WASM failed to initialize");
  },
});

/**
 * Production loader. Imported lazily and behind a function reference so this
 * module stays importable in a test environment with no WASM present, and so
 * the failure is catchable at boot rather than at module-evaluation time.
 */
const defaultEngineLoader = async (): Promise<InspectorEngine> => {
  const { loadInspectorEngine } = await import("../document/wasm/index.ts");
  return loadInspectorEngine();
};
