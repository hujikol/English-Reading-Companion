/**
 * Real dictionary behind the popover's `LookupSurface`.
 *
 * The popover takes the lookup function by injection so a miss can never turn
 * into a network path. This is the production binding: it calls the Track C
 * lookup against the real local database and nothing else.
 *
 * There is deliberately no fallback and no catch-all miss. No pack installed
 * means every lookup returns `{found:false, reason:"no-active-pack"}` and the
 * card shows that honestly — an unconfigured app must not invent a gloss, and a
 * corrupt pack must not read as a clean miss.
 */

import { dictDb } from "../../features/dictionary/db.ts";
import { lookup as dictionaryLookup } from "../../features/dictionary/lookup.ts";
import type { Lookup } from "../vocab/selectionPopover.ts";

const MAX_CANDIDATES = 5;

/**
 * Errors propagate. `PopoverState` has a real `failed` status and
 * `failLookup()` for exactly this case; swallowing the error into a synthetic
 * miss would show the learner "not in this dictionary" when the truth is that
 * their pack is broken.
 */
export async function lookupSurface(surface: string): Promise<Lookup> {
  return dictionaryLookup({ db: dictDb, surface, maxCandidates: MAX_CANDIDATES });
}
