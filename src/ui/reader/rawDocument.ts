import { dictDb, activePack } from "../../features/dictionary/db.ts";
import { normalizeForm } from "../../features/dictionary/pack.ts";
import type { Locator } from "../../contracts/index.ts";
import { formatOf, planImport } from "../library/libraryModel.ts";
import { decodeAuto } from "../../features/reader/text/decode.ts";
import { chunkText } from "../../features/reader/text/chunk.ts";
import { markdownToHtml } from "../../features/reader/text/markdown.ts";
import { EpubRenderer, sanitizedText } from "../../features/reader/epub/renderer.tsx";
import { pdfjsAdapter } from "./pdfEngine.ts";

export type ReadingUnit = { text: string; label: string; locator: Locator };
export type RawDocument = { count: number; read(index: number): Promise<ReadingUnit>; close(): Promise<void>; indexOf(locator?: Locator): number };

/** Preserve paragraph boundaries before stripping sanitized markup. */
export const plainText = (html: string): string => sanitizedText(html.replace(/<\/(?:p|div|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/gi, "\n")).trim();
export const pageFromInput = (raw: string, count: number): number | undefined => {
  if (!/^\d+$/.test(raw.trim()) || count < 1) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? Math.max(0, Math.min(count - 1, n - 1)) : undefined;
};
export const sameUnit = (a: Locator, b: Locator): boolean => a.kind === "pdf" && b.kind === "pdf" ? a.pageIndex === b.pageIndex
  : a.kind === "epub" && b.kind === "epub" ? a.spineHref === b.spineHref
  : a.kind === "text" && b.kind === "text" && a.blockId === b.blockId;

export async function openRawDocument(file: File, password?: string): Promise<RawDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const plan = planImport({ name: file.name, type: file.type, size: file.size, bytes, head: bytes.subarray(0, 1024) });
  if (plan.kind === "rejected") throw new Error(plan.errors.map(e => `${e.message} ${e.action}`).join(" "));
  if (formatOf(file.name) === "pdf") {
    const pdf = await pdfjsAdapter.open(bytes, password);
    const cache = new Map<number, ReadingUnit>();
    const pack = await activePack(dictDb).catch(() => null);
    const words = new Map<string, boolean>();
    const isWord = async (word: string): Promise<boolean> => {
      if (!pack) return false;
      const key = normalizeForm(word);
      const cached = words.get(key);
      if (cached !== undefined) return cached;
      const found = await dictDb.entries.where("[packVersion+normalizedHeadword+senseId]").between([pack.packVersion, key, -Infinity], [pack.packVersion, key, Infinity]).count() > 0;
      if (words.size >= 2000) words.clear();
      words.set(key, found); return found;
    };
    return {
      count: pdf.capabilities.pageCount,
      async read(index) {
        const cached = cache.get(index);
        if (cached) return cached;
        const page = await pdf.page(index);
        try {
          const unit: ReadingUnit = { text: page.readingText ? await page.readingText(isWord) : await page.text(), label: `Page ${index + 1}`, locator: { kind: "pdf", pageIndex: index, pageFraction: 0 } };
          // Bound extracted-text memory while retaining pages parsed ahead of scrolling.
          if (cache.size >= 8) cache.delete(cache.keys().next().value!);
          cache.set(index, unit);
          return unit;
        } finally { await page.release(); }
      },
      close: () => pdf.destroy(),
      indexOf: locator => locator?.kind === "pdf" ? Math.max(0, Math.min(pdf.capabilities.pageCount - 1, locator.pageIndex)) : 0,
    };
  }
  if (plan.format === "epub") {
    const epub = new EpubRenderer();
    const result = await epub.open(bytes);
    if (!result.ok) { epub.close(); throw new Error(result.detail); }
    return {
      count: epub.chapters.length,
      async read(index) {
        const chapter = epub.renderIndex(index);
        if (!chapter.ok) throw new Error(chapter.detail);
        return { text: plainText(chapter.sanitizedHtml), label: epub.chapters[index]?.title ?? `Chapter ${index + 1}`, locator: { kind: "epub", spineHref: chapter.chapter.spineHref } };
      },
      async close() { epub.close(); },
      indexOf: locator => locator?.kind === "epub" ? Math.max(0, epub.chapters.findIndex(c => c.spineHref === locator.spineHref)) : 0,
    };
  }
  const decoded = decodeAuto(bytes);
  if (!decoded.ok) throw new Error(decoded.detail);
  let text = decoded.text;
  if (plan.format === "md") {
    const markdown = markdownToHtml(text);
    if (!markdown.ok) throw new Error(markdown.detail);
    text = plainText(markdown.html);
  }
  const blocks = chunkText(text);
  if (blocks.length === 0) throw new Error("This document contains no readable text.");
  return {
    count: blocks.length,
    async read(index) {
      const block = blocks[index];
      if (!block) throw new Error("Section is outside this document.");
      return { text: block.text, label: `Section ${index + 1}`, locator: { kind: "text", blockId: block.blockId, start: block.start, end: block.end } };
    },
    async close() {},
    indexOf: locator => locator?.kind === "text" ? Math.max(0, blocks.findIndex(b => b.blockId === locator.blockId)) : 0,
  };
}
