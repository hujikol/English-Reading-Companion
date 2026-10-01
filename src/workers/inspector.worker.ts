/**
 * Dedicated inspector worker (Section 6 step 2: one per active document).
 *
 * `processPdf` is SYNCHRONOUS after init(), so nothing in this file can interrupt
 * a running extraction. The watchdog therefore lives on the main thread and its
 * only correct action is `worker.terminate()`. A cancel message posted here
 * would be queued behind the WASM call and arrive too late — see ./jobs.ts.
 *
 * The WASM module is NOT installed in this repository yet, so it is loaded
 * through an injected loader. Until the dependency lands, `createInspectorWorker`
 * reports `fallback-only` and reading continues on PDF.js text.
 */

import type { Capabilities, WorkerRequest, WorkerResponse } from "../contracts/index.ts";
import { closeAdapter, createAdapter, extractPages } from "../document/adapter.ts";
import { openGuard, bumpGeneration } from "../document/generation.ts";
import { routeSemanticWork } from "../document/quality.ts";
import { INSPECTOR_ENGINE } from "../document/types.ts";
import type { InspectorAdapter } from "../document/adapter.ts";
import type { InspectorEngine } from "../document/types.ts";

/** What the worker is doing now. Tracked so CLOSE can release parser input. */
type Session = {
  documentId: string;
  generation: number;
  adapter: InspectorAdapter | null;
  pageCount: number;
  password?: string | undefined;
};

const REPLY = (r: WorkerResponse, post: (m: WorkerResponse) => void): void => post(r);
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
 * Pure request handler. Kept free of `self` so it is testable with a fake
 * engine and a fake post function; `onmessage` is the only impure wrapper.
 */
export function handleRequest(
  request: WorkerRequest,
  session: Session,
  guard: { documentId: string; current: number },
): { session: Session; guard: { documentId: string; current: number }; response: WorkerResponse } {
  switch (request.type) {
    case "OPEN": {
      // A reopen bumps the generation, so every response from the old session is
      // refused even if it lands late.
      const next = bumpGeneration(guard);
      return {
        session: { documentId: request.documentId, generation: next.current, adapter: null, pageCount: 0, password: request.password },
        guard: next,
        response: ok(request.requestId, request.documentId, next.current, { engine: INSPECTOR_ENGINE, capabilities: capabilities(true) }),
      };
    }
    case "CLASSIFY": {
      if (request.generation < guard.current)
        return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "stale-generation") };
      const adapter = session.adapter;
      if (adapter === null) return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "not-open") };
      try {
        const c = adapter.engine.classifyPdf(new Uint8Array(0));
        return {
          session,
          guard,
          response: ok(request.requestId, request.documentId, request.generation, {
            pdfType: c.pdfType,
            pageCount: c.pageCount,
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
      if (adapter === null) return { session, guard, response: fail(request.requestId, request.documentId, request.generation, "not-open") };
      const result = extractPages(adapter, request.pageIndexes);
      if (!result.ok) return { session, guard, response: fail(request.requestId, request.documentId, request.generation, result.message ?? result.kind) };
      return { session, guard, response: ok(request.requestId, request.documentId, request.generation, result) };
    }
    case "CLOSE": {
      const adapter = session.adapter;
      return {
        session: { documentId: session.documentId, generation: session.generation, adapter: null, pageCount: 0 },
        guard: bumpGeneration(guard),
        response: ok(request.requestId, request.documentId, guard.current, { released: adapter !== null }),
      };
    }
  }
}

/** Honest capability flags. positionedText is false permanently (ADR 004). */
export const capabilities = (semanticAvailable: boolean): Capabilities => ({
  semantic: semanticAvailable ? "inspector" : "fallback-only",
  password: true,
  ocr: false,
  positionedText: false,
});

export const emptySession = (documentId: string): Session => ({ documentId, generation: 0, adapter: null, pageCount: 0 });

/**
 * Wire the handler to a real worker scope. `makeAdapter` is injected so the WASM
 * import is the caller's problem, not this file's.
 */
export const attachWorkerScope = (
  makeAdapter: (bytes: Uint8Array, password: string | undefined) => InspectorAdapter,
  scope: {
    postMessage: (m: WorkerResponse) => void;
    addEventListener: (type: "message", handler: (e: { data: WorkerRequest }) => void) => void;
  },
): { engine: InspectorEngine | null } => {
  let session = emptySession("");
  let guard = openGuard("");
  let engine: InspectorEngine | null = null;

  scope.addEventListener("message", (e) => {
    const request = e.data;
    if (request.type === "OPEN") {
      session = emptySession(request.documentId);
      guard = openGuard(request.documentId);
    }
    const before = session;
    const handled = handleRequest(request, session, guard);
    session = handled.session;
    guard = handled.guard;
    // The adapter is built on the first request that needs bytes, so OPEN stays
    // cheap and a document with no semantic work never pays for parsing.
    if (request.type === "OPEN" && request.bytes.byteLength > 0) {
      const adapter = makeAdapter(new Uint8Array(request.bytes), request.password);
      engine = adapter.engine;
      session = { ...session, adapter, pageCount: adapter.pageCount };
    }
    if (request.type === "CLOSE" && before.adapter !== null) session = { ...session, adapter: null };
    REPLY(handled.response, (m) => scope.postMessage(m));
  });

  return {
    get engine() {
      return engine;
    },
  };
};
