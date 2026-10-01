/**
 * Saving a mark. The selection controller (Track A/B) owns the DOM selection and
 * the transient rectangles; this module only turns a resolved selection into the
 * durable `Mark` row.
 *
 * Section 7: "Capture exact selected text, document ID, location, page/chapter,
 * quote prefix/suffix, and viewport rectangles. Store logical source anchors
 * separately from temporary screen coordinates."
 *
 * The rectangles are NOT stored. There is no field for them here, deliberately.
 */

import type { Anchor, Locator, Mark } from "../../contracts/index.ts";

export type SaveMarkInput = {
  id: string;
  documentId: string;
  titleSnapshot: string;
  /** exact selected text, unmodified */
  quote: string;
  /** text immediately before/after the selection, for re-anchoring later */
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** the locator the renderer can rebuild from, format-native */
  locator: Locator;
  color: Mark["color"];
  now: number;
};

export type SaveMarkResult =
  | { ok: true; mark: Mark }
  | { ok: false; reason: "empty-quote" | "missing-format-locator" | "bad-page-index" };

export type SaveMarkInputLike = Omit<SaveMarkInput, "locator"> & { locator?: Locator | undefined };

const MAX_QUOTE = 2000;
/** Enough to disambiguate a repeated phrase without growing the row. */
export const CONTEXT_RADIUS = 48;

const str = (v: unknown): v is string => typeof v === "string";

const hasKnownKind = (l: unknown): l is Locator =>
  typeof l === "object" &&
  l !== null &&
  ["pdf", "epub", "text"].includes((l as { kind?: unknown }).kind as string);

/**
 * A locator arrives from the renderer, so it is untrusted input at this boundary.
 * Every field is checked for the right TYPE as well as the right value: a
 * malformed locator is a rejected save, never a row that throws on read or
 * silently points at page NaN.
 */
const validLocator = (l: Locator | undefined): l is Locator => {
  if (l === undefined || l === null || typeof l !== "object") return false;
  switch (l.kind) {
    case "pdf":
      return (
        Number.isInteger(l.pageIndex) &&
        l.pageIndex >= 0 &&
        Number.isFinite(l.pageFraction) &&
        l.pageFraction >= 0 &&
        l.pageFraction <= 1
      );
    case "epub":
      return str(l.spineHref) && l.spineHref.length > 0;
    case "text":
      return str(l.blockId) && l.blockId.length > 0 && Number.isInteger(l.start) && Number.isInteger(l.end) && l.start >= 0 && l.end >= l.start;
    default:
      // An unknown format is not a locator. Trusting it would write a row no
      // adapter can ever resolve.
      return false;
  }
};

/**
 * Build the durable row.
 *
 * The new anchor is `unresolved`, not `resolved`. The user saw the text under
 * the selection, but nothing has yet proved that this quote can be re-found in
 * extraction output; a re-anchor at mount does that, and it rewrites the state
 * every time. Starting at "resolved" would claim a resolution nobody checked and
 * let a mark that later fails to re-find stay quietly marked as drawn.
 */
export function saveMark(input: SaveMarkInputLike): SaveMarkResult {
  const quote = (input.quote ?? "").trim();
  if (quote.length === 0) return { ok: false, reason: "empty-quote" };
  if (!hasKnownKind(input.locator)) return { ok: false, reason: "missing-format-locator" };
  // Check the page index before general validity, or "bad-page-index" is dead code
  // swallowed by "missing-format-locator".
  if (input.locator.kind === "pdf" && (!Number.isInteger(input.locator.pageIndex) || input.locator.pageIndex < 0))
    return { ok: false, reason: "bad-page-index" };
  if (!validLocator(input.locator)) return { ok: false, reason: "missing-format-locator" };

  const anchor: Anchor = {
    quote: quote.slice(0, MAX_QUOTE),
    locator: input.locator,
    anchorState: "unresolved",
    ...(input.prefix !== undefined && input.prefix.length > 0 ? { prefix: input.prefix.slice(-CONTEXT_RADIUS) } : {}),
    ...(input.suffix !== undefined && input.suffix.length > 0 ? { suffix: input.suffix.slice(0, CONTEXT_RADIUS) } : {}),
  };

  return {
    ok: true,
    mark: {
      id: input.id,
      documentId: input.documentId,
      titleSnapshot: input.titleSnapshot,
      anchor,
      color: input.color,
      createdAt: input.now,
    },
  };
}

/** Soft delete. The row survives so a restore can find it. */
export const deleteMark = (mark: Mark, now: number): Mark => ({ ...mark, deletedAt: now });
