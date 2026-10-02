/**
 * Fetch and install the shipped dictionary pack.
 *
 * The pack is built at release time into `public/dictionary/` and precached by
 * the service worker, so this runs entirely offline. It is deliberately NOT run
 * on app start: installing 17,876 rows is real work, and a reader who never
 * looks a word up should not pay for it. It runs when a lookup first misses on
 * "no active pack", and again only when a newer version appears.
 *
 * Every failure path here is a status, never a thrown error at the UI: a broken
 * or absent pack must leave the reader reading, with the card reporting that
 * the word is not in this dictionary rather than breaking the page.
 */

import { activePack, dictDb, installPack } from "./db.ts";
import type { PackManifest } from "./pack.ts";

/** Where the release build puts the pack. Same-origin by construction. */
const BASE = "/dictionary";

export type LoadState =
  | { kind: "ready"; packVersion: string; headwords: number }
  | { kind: "absent"; reason: string }
  | { kind: "busy" };

let inFlight: Promise<LoadState> | null = null;

/**
 * Decode one gzipped chunk.
 *
 * `DecompressionStream` is native in every browser this app targets, so no
 * compression library is needed here. The pack builder already emitted raw
 * deflate via fflate; `DecompressionStream("gzip")` reads that directly.
 */
async function fetchChunk(file: string): Promise<Uint8Array> {
  const response = await fetch(`${BASE}/${file}`, { cache: "force-cache" });
  if (!response.ok) throw new Error(`chunk ${file}: HTTP ${response.status}`);
  const stream = response.body;
  if (stream === null) throw new Error(`chunk ${file}: no body`);

  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  return bytes;
}

/** Idempotent: a second call while one is in flight returns the same promise. */
export async function loadDictionary(): Promise<LoadState> {
  inFlight ??= install().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function install(): Promise<LoadState> {
  try {
    const active = await activePack(dictDb);
    if (active !== null) {
      return { kind: "ready", packVersion: active.packVersion, headwords: active.headwordCount };
    }

    const response = await fetch(`${BASE}/manifest.json`, { cache: "force-cache" });
    if (!response.ok) return { kind: "absent", reason: `manifest: HTTP ${response.status}` };

    const manifest = (await response.json()) as PackManifest;
    if (typeof manifest.packVersion !== "string" || !Array.isArray(manifest.chunks)) {
      return { kind: "absent", reason: "manifest is not a pack manifest" };
    }

    // installPack is already transactional: it stages, validates every chunk
    // against the manifest's row count and hash, and only then flips active. A
    // failure part-way leaves any previous pack in place.
    const installed = await installPack(dictDb, manifest, { fetchChunk });
    return { kind: "ready", packVersion: installed.packVersion, headwords: installed.headwordCount };
  } catch (error: unknown) {
    return { kind: "absent", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a pack is present, for UI that wants to say so up front. */
export async function dictionaryReady(): Promise<boolean> {
  return (await activePack(dictDb)) !== null;
}
