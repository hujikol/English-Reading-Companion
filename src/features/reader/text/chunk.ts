/**
 * Paragraph chunking for plain text (IDEA.md s8: split into paragraph chunks
 * while preserving stable source offsets and line breaks).
 *
 * Blocks tile the source in order, and block IDs are derived from the start
 * offset, so they are stable across reopen with nothing persisted. Internal
 * line breaks are preserved so a quote resolved against a block's text
 * round-trips exactly.
 */

export type TextBlock = {
  /** `txt-<startOffset>`: deterministic, geometry-free, stable. */
  blockId: string;
  kind: "paragraph" | "heading" | "preformatted";
  /** Offsets into the decoded source string. */
  start: number;
  end: number;
  /** Text with the terminating blank line removed. */
  text: string;
};

export type ChunkOptions = {
  /** Soft cap per block. A longer run of lines is split at a line boundary. */
  maxChars?: number;
};

const BLANK = /^[ \t]*$/;

/** CHAPTER 1 / CHAPTER IV / Chapter One — a label, not prose. Never a locator
 * on its own (s8: headings are not unique); `kind` is display metadata only. */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  return /^chapter\s+[0-9ivxlcdm]+[.:\s]?/i.test(trimmed) && trimmed.length <= 80 && !/[.!?]$/.test(trimmed);
}

/**
 * Split decoded text into paragraph blocks. Line breaks inside a paragraph are
 * kept; a blank line ends it.
 */
export function chunkText(source: string, options: ChunkOptions = {}): TextBlock[] {
  const maxChars = Math.max(1, options.maxChars ?? 4000);
  const blocks: TextBlock[] = [];

  let paragraphStart = -1;
  let cursor = 0;

  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? source.length : newline;
    const nextLine = newline < 0 ? source.length : newline + 1;
    const line = source.slice(cursor, lineEnd).replace(/\r$/, "");

    if (BLANK.test(line)) {
      if (paragraphStart >= 0) {
        pushBlock(blocks, source, paragraphStart, cursor);
        paragraphStart = -1;
      }
      cursor = nextLine;
      continue;
    }

    if (paragraphStart < 0) paragraphStart = cursor;
    if (cursor - paragraphStart >= maxChars) {
      pushBlock(blocks, source, paragraphStart, cursor);
      paragraphStart = -1;
    }
    cursor = nextLine;
  }
  if (paragraphStart >= 0) pushBlock(blocks, source, paragraphStart, source.length);
  return blocks;
}

function pushBlock(blocks: TextBlock[], source: string, start: number, end: number): void {
  const text = source.slice(start, end).replace(/[\r\n]+$/, "");
  if (text.trim() === "") return;
  const multiLine = text.includes("\n");
  const trimmed = text.trim();
  blocks.push({
    blockId: `txt-${start}`,
    kind: multiLine ? "preformatted" : isHeadingLine(trimmed) ? "heading" : "paragraph",
    start,
    end: start + text.length,
    text,
  });
}

/**
 * Find the block whose `[start, end)` range contains `offset`, or null.
 */
export function blockAtOffset(blocks: readonly TextBlock[], offset: number): TextBlock | null {
  for (const block of blocks) {
    if (offset >= block.start && offset < block.end) return block;
  }
  return blocks.length > 0 && offset === (blocks[blocks.length - 1]?.end ?? -1) ? (blocks[blocks.length - 1] ?? null) : null;
}
