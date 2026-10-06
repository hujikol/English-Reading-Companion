/**
 * Fetch and install the shipped dictionary pack.
 *
 * The pack is built at release time into `public/dictionary/` and precached by
 * the service worker, so this runs entirely offline. It is pre-loaded at app
 * startup so the first lookup is instant, and a broken pack is reported in the
 * header instead of inside the popover card.
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
  | { kind: "ready"; packVersion: string; headwords: number; attribution: { source: string; license: string; licenseUrl: string } }
  | { kind: "absent"; reason: string }
  | { kind: "busy" };

let inFlight: Promise<LoadState> | null = null;

/**
 * Fetch one chunk.
 *
 * The response is requested WITHOUT `Content-Encoding: gzip` on purpose.
 *
 * The host serves these files with `Content-Encoding: gzip`, so the browser
 * transparently inflates them and `arrayBuffer()` yields plain JSON. Handing
 * that to installPack's `gunzip` fails with "incorrect header check" — the
 * dictionary silently never installs. The pack is already compressed on disk;
 * compressing it a second time for transport buys nothing and loses the ability
 * to read it back.
 */
/**
 * Fetch one chunk as raw bytes. Does NOT decompress.
 *
 * The host may serve these files with `Content-Encoding: gzip` (the browser
 * inflates transparently, so arrayBuffer() yields JSON), or with
 * Accept-Encoding: identity (still gzipped). `decodeRows` in db.ts handles
 * both via magic-byte detection, so this function returns whatever the
 * browser gives us without guessing.
 */
async function fetchChunk(file: string): Promise<Uint8Array> {
  const response = await fetch(`${BASE}/${file}`, {
    cache: "force-cache",
    headers: { "Accept-Encoding": "identity" },
  });
  if (!response.ok) throw new Error(`chunk ${file}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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
      return { kind: "ready", packVersion: active.packVersion, headwords: active.headwordCount, attribution: { source: active.license, license: active.licenseUrl, licenseUrl: active.licenseUrl } };
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
    return { kind: "ready", packVersion: installed.packVersion, headwords: installed.headwordCount, attribution: { source: installed.license, license: installed.licenseUrl, licenseUrl: installed.licenseUrl } };
  } catch (error: unknown) {
    return { kind: "absent", reason: error instanceof Error ? error.message : String(error) };
  }
}
