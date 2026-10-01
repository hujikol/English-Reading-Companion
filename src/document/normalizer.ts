/**
 * Section 6 semantic path step 5: normalize parser output into canonical page
 * text plus blocks.
 *
 * Markdown is an ADAPTER INPUT, never the canonical model (ADR 009). Everything
 * a downstream consumer sees comes out of here as plain text with UTF-16 offsets.
 *
 * Decisions that are not obvious:
 * - Ligatures expand and soft hyphens vanish, but REAL hyphens stay. The
 *   matching-only variant is `normalizeForMatch` in ./align.ts.
 * - Blocks split on blank lines, the only structure Markdown guarantees. `#`,
 *   bullets, pipes and emphasis are consumed as syntax, not kept.
 * - Block ids are `b<N>` inside the page: stable within an extraction key
 *   (Section 12) and deliberately not across normalizer versions, which is why
 *   they are never persisted inside a user anchor.
 * - A whitespace-only page still yields one block so a block range is always
 *   addressable; its text is empty and quality decides its use.
 */

import type { BlockKind, SemanticBlock } from "../contracts/semantic.ts";
import type { NormalizedPage } from "./types.ts";
import { NORMALIZER_VERSION } from "./types.ts";

export const normalizerVersion = NORMALIZER_VERSION;

/** Typography that carries meaning only in appearance. Order is irrelevant. */
const TRANSLITERATE: Array<[RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/ﬆ/g, "st"],
  [/ß/g, "ss"],
  [/[‐-―−]/g, "-"],
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
];

/** Zero-width, soft hyphen, word joiner, BOM: invisible to a reader, poison for matching. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

const expandTypography = (raw: string): string => {
  let s = (raw ?? "").replace(INVISIBLE, "");
  for (const [re, to] of TRANSLITERATE) s = s.replace(re, to);
  return s;
};

/**
 * Line joining. A newline inside a block is a wrapped line and becomes a space.
 * A real trailing hyphen is PRESERVED with a space: "well-known" and
 * "well- known" are indistinguishable here, and Section 7 forbids guessing.
 * Line-end hyphenation is reversed only by `align.ts` when evidence supports it.
 */
const joinLines = (raw: string): string =>
  raw
    .replace(/\r\n?/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** Markdown tables are a pipe line followed by a dashes-only line. */
const TABLE_RULE = /^\|?[\s:|-]+\|[\s:|-]*$/;

const classify = (markdown: string): BlockKind => {
  const trimmed = markdown.trim();
  if (/^#{1,6}\s/.test(trimmed)) return "heading";
  if (/^(?:[-*+]|\d+[.)])\s/.test(trimmed)) return "list";
  if (trimmed.split("\n").some((l) => l.includes("-") && TABLE_RULE.test(l.trim()))) return "table";
  return "paragraph";
};

/**
 * Consume block- and inline-level syntax, keeping the readable text. Headings
 * lose `#`, list items lose their bullet, table rows lose pipes, images keep
 * their alt text, links keep their label.
 */
const inlineText = (markdown: string): string =>
  markdown
    .split("\n")
    .map((line) => {
      let l = line.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "");
      l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
      l = l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      l = l.replace(/`([^`]*)`/g, "$1");
      l = l.replace(/\*\*([^*]*)\*\*/g, "$1").replace(/__([^_]*)__/g, "$1");
      l = l.replace(/\*([^*]*)\*/g, "$1").replace(/(?<!\w)_([^_]*)_(?!\w)/g, "$1");
      l = l.replace(/~~([^~]*)~~/g, "$1");
      return l.replace(/^\|/, "").replace(/\|$/, "").replace(/\|/g, " ");
    })
    .join("\n");

/**
 * Canonical page text plus blocks whose [start, end) ranges index that text, so
 * a saved quote can be located again without re-parsing Markdown.
 */
export function normalizeMarkdown(markdown: string): NormalizedPage {
  const expanded = expandTypography(markdown);
  const rawBlocks = expanded
    .split(/\n[ \t]*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const pieces: string[] = [];
  const blocks: SemanticBlock[] = [];
  let cursor = 0;

  rawBlocks.forEach((raw, i) => {
    const body = joinLines(inlineText(raw));
    if (i > 0) {
      // A blank line in canonical text keeps paragraph boundaries visible and
      // matchable, and keeps blocks non-adjacent so an offset gap is meaningful.
      pieces.push("\n\n");
      cursor += 2;
    }
    pieces.push(body);
    blocks.push({ id: `b${i}`, kind: classify(raw), start: cursor, end: cursor + body.length });
    cursor += body.length;
  });

  if (blocks.length === 0) blocks.push({ id: "b0", kind: "unknown", start: 0, end: 0 });

  return { text: pieces.join(""), blocks };
}

/** Real text length, ignoring block separators. */
export const textLength = (page: NormalizedPage): number => page.blocks.reduce((n, b) => n + (b.end - b.start), 0);

/** The block containing an offset, or null when it falls in a separator. */
export const blockAt = (page: NormalizedPage, offset: number): SemanticBlock | null => {
  const hit = page.blocks.find((b) => offset >= b.start && offset < b.end);
  if (hit) return hit;
  // An offset exactly at the end of the page belongs to the last block.
  if (offset === page.text.length) return page.blocks[page.blocks.length - 1] ?? null;
  return null;
};

/**
 * The text on both sides of a matched [start, end) range. Both sides stop
 * exactly at the range, so prefix + quote + suffix is the original text. This
 * is what an Anchor stores, and it is what disambiguates a repeated phrase.
 */
export const quoteAround = (
  text: string,
  start: number,
  end: number,
  radius: number,
): { prefix: string; suffix: string } => ({
  prefix: text.slice(Math.max(0, start - radius), start),
  suffix: text.slice(end, end + radius),
});
