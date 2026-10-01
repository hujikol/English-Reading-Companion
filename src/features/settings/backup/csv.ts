import type { Vocabulary } from "../../../contracts/index.ts";
import type { Store } from "../../vocabulary/store.ts";

/** Cells a spreadsheet would evaluate as a formula. Leading whitespace or a
 * tab does not stop Excel/LibreOffice, so those are prefixed too. */
const FORMULA_LEAD = /^\s*[=+\-@\t\r]/;

/** OS-Excel CSV injection guard, not an RFC-4180 one. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return /["\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}

const HEAD = ["surface", "meaning", "lemma", "status", "note", "occurrences", "books", "createdAt", "updatedAt"];

/** UTF-8 CSV with a BOM so Excel opens non-ASCII Indonesian text correctly. */
export function exportVocabularyCsv(store: Store): Promise<string> {
  const rows = (async (): Promise<string[]> => {
    const words = (await store.vocabulary.toArray()) as Vocabulary[];
    const occurrences = (await store.occurrences.toArray()) as { vocabularyId?: string; titleSnapshot: string }[];
    const perWord = new Map<string, { count: number; books: Set<string> }>();
    for (const o of occurrences) {
      if (!o.vocabularyId) continue;
      const entry = perWord.get(o.vocabularyId) ?? { count: 0, books: new Set<string>() };
      entry.count += 1;
      if (o.titleSnapshot) entry.books.add(o.titleSnapshot);
      perWord.set(o.vocabularyId, entry);
    }

    const lines = [csvRow(HEAD)];
    for (const v of words.sort((a, b) => a.normalizedForm.localeCompare(b.normalizedForm))) {
      const agg = perWord.get(v.id);
      lines.push(csvRow([
        v.surface,
        v.meaning,
        v.lemma ?? "",
        v.status,
        v.note ?? "",
        agg?.count ?? 0,
        [...(agg?.books ?? [])].join(" | "),
        new Date(v.createdAt).toISOString(),
        new Date(v.updatedAt).toISOString(),
      ]));
    }
    return lines;
  })();

  return rows.then((lines) => `\uFEFF${lines.join("\r\n")}\r\n`);
}