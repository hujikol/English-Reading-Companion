/**
 * Real dictionary behind the popover's `LookupSurface`.
 *
 * The popover takes the lookup function by injection so a miss can never turn
 * into a network path. This is the production binding: it calls the Track C
 * lookup against the real local database and nothing else.
 *
 * A `no-active-pack` miss is the one case that triggers work: the pack is
 * fetched from this origin (precached, so it works offline) and installed, then
 * the lookup is retried once. That is not a network request on a miss — the
 * fetch is same-origin pack installation, not a lookup escalation, and it
 * happens at most once per version.
 *
 * There is deliberately no catch-all. A corrupt pack propagates, so the card
 * reports "failed" with a reason instead of claiming the word is absent.
 */

import { dictDb } from "../../features/dictionary/db.ts";
import { lookup as dictionaryLookup } from "../../features/dictionary/lookup.ts";
import { loadDictionary } from "../../features/dictionary/loadPack.ts";
import type { Lookup } from "../vocab/selectionPopover.ts";

const MAX_CANDIDATES = 5;

export async function lookupSurface(surface: string): Promise<Lookup> {
  let first = await dictionaryLookup({ db: dictDb, surface: surface.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""), maxCandidates: MAX_CANDIDATES });
  if (first.found) return first;
  if (first.reason !== "no-active-pack") return first;
  if (first.candidates.length > 0) return first;

  // No pack yet: install the shipped one, then try once more.
  const state = await loadDictionary();
  if (state.kind === "absent") {
    // Surface WHY. Reporting a plain miss here hid a broken install behind
    // "No dictionary installed yet", which is indistinguishable from a user who
    // simply has no pack.
    throw new Error(`Dictionary pack could not be installed: ${state.reason}`);
  }

  first = await dictionaryLookup({ db: dictDb, surface: surface.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""), maxCandidates: MAX_CANDIDATES });
  if (first.found || first.candidates.length > 0) return first;

  return first;
}
