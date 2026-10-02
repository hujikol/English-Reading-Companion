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
  const first = await dictionaryLookup({ db: dictDb, surface, maxCandidates: MAX_CANDIDATES });
  if (first.found || first.reason !== "no-active-pack") return first;

  // No pack yet: install the shipped one, then try once more.
  const state = await loadDictionary();
  if (state.kind !== "ready") return first;
  return dictionaryLookup({ db: dictDb, surface, maxCandidates: MAX_CANDIDATES });
}
