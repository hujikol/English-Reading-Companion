/**
 * Shared cross-track contracts. Frozen at gate A1. One writer: Track A.
 * Feature tracks import from here; they do not redeclare these shapes.
 */

export type Format = "pdf" | "epub" | "txt" | "md";

/**
 * A position inside one document. Geometry-free by decision: no bounding boxes.
 * `pageFraction` is a scroll position within a page, not a box.
 */
export type Locator =
  | {
      kind: "pdf";
      pageIndex: number;
      pageFraction: number;
      quote?: string;
      prefix?: string;
      suffix?: string;
    }
  | { kind: "epub"; spineHref: string; cfi?: string; quote?: string; prefix?: string; suffix?: string }
  | { kind: "text"; blockId: string; start: number; end: number; quote?: string; prefix?: string; suffix?: string };

/** How an anchor last resolved. Rewritten on every successful re-anchor. */
export type AnchorState = "resolved" | "unresolved" | "lost";

/**
 * The single durable user-anchor shape. Marks, occurrences and bookmarks all
 * use it. Selection-time viewport rectangles are transient and never stored.
 */
export type Anchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
  locator: Locator;
  anchorState: AnchorState;
  resolvedAt?: number;
};

export type Bookmark = {
  id: string;
  documentId: string;
  titleSnapshot: string;
  locator: Locator;
  label: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

/** Runtime capability flags, published by a format adapter or parser. */
export type Capabilities = {
  semantic: "inspector" | "fallback-only" | "unavailable";
  password: boolean;
  ocr: boolean;
  positionedText: false;
};
