/**
 * The assigned hashing/import worker. Owned by Track B. Runs SHA-256 over the
 * ORIGINAL bytes off the main thread so display never waits for the digest
 * (Section 5: "Rendering starts independently of classification, hashing, and
 * semantic extraction").
 *
 * No network. No geometry. The worker only turns bytes into a content hash and
 * a head buffer; validation itself runs on the main thread because it is cheap.
 */

import { sha256, type Sha256 } from "../features/library/identity.ts";

export type ImportWorkerRequest = {
  requestId: string;
  type: "HASH";
  bytes: ArrayBuffer;
};

export type ImportWorkerResponse =
  | { requestId: string; ok: true; contentHash: Sha256 }
  | { requestId: string; ok: false; error: string };

/**
 * Requesting a head buffer rather than the whole file back to the main thread:
 * only the first KiB is needed for signature and MIME cross-checks.
 */

/**
 * ponytail: no worker pool, no chunked streaming. One file at a time, whole
 * buffer digested (Section 5 permits this for moderate files). Move to
 * `digestIncremental` only if the FG-DEVICE large-file gate requires it.
 */
export async function handleHash(req: ImportWorkerRequest): Promise<ImportWorkerResponse> {
  if (req.type !== "HASH") return { requestId: req.requestId, ok: false, error: `unknown request ${String(req.type)}` };
  try {
    const contentHash = await sha256(req.bytes);
    return { requestId: req.requestId, ok: true, contentHash };
  } catch (e) {
    return { requestId: req.requestId, ok: false, error: e instanceof Error ? e.message : "hashing failed" };
  }
}

// Only install the listener when actually running inside a worker.
declare const self: { postMessage(m: unknown): void; addEventListener(t: "message", h: (e: MessageEvent<ImportWorkerRequest>) => void): void };

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.addEventListener("message", (e) => {
    void handleHash(e.data).then((r) => self.postMessage(r));
  });
}
