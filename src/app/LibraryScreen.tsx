/**
 * Library screen: open file, imported documents with progress and storage state,
 * remove, plus JSON backup and UTF-8 CSV export.
 *
 * Persistence claims are made from the real record state, and every export
 * announces only after bytes exist (section 4, section 11).
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { db, deleteSource, type DocumentRecord, type ProgressRecord } from "../db/index.ts";
import { exportBackup } from "../features/settings/backup/backup.ts";
import { exportVocabularyCsv } from "../features/settings/backup/csv.ts";
import { reopenDocument } from "../ui/library/reopen.ts";
import {
  announceExport,
  backupFileName,
  buildLibraryRows,
  csvFileName,
  exportOutcomeOf,
  formatBytes,
  importDocument,
  type ExportOutcome,
  type ImportOutcome,
  type ImportSource,
  type LibraryRow,
} from "../ui/library/libraryModel.ts";

type Notice = { tone: "ok" | "error"; text: string };

/*
 * Buttons. Tailwind v4 composes these from the `@theme` tokens in app.css; the
 * focus ring is `outline-*` rather than `ring-*` so it never changes layout,
 * and it is on `focus-visible` so a mouse click does not leave a halo behind.
 */
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BTN =
  `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50`;
/** The one action a card is for. Text on `accent` is 5:1 — AA at any size. */
const BTN_PRIMARY = `${BTN} bg-accent text-paper hover:bg-accent/90`;
const BTN_SECONDARY = `${BTN} border border-line bg-paper text-ink hover:border-ink/30 hover:bg-shell`;
/** Destructive-adjacent but recoverable: text-only until hovered or focused. */
const BTN_QUIET = `${BTN} px-3 text-ink-soft hover:bg-shell hover:text-ink`;

const DOWNLOAD = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

export type LibraryScreenProps = {
  /** Hand a stored document to the reader. Omitted renders the list only. */
  onOpenDocument?: (file: File, document: DocumentRecord) => void | Promise<void>;
};

export function LibraryScreen({ onOpenDocument }: LibraryScreenProps = {}) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    const [documents, progress, assets] = await Promise.all([
      db.documents.toArray() as Promise<DocumentRecord[]>,
      db.progress.toArray() as Promise<ProgressRecord[]>,
      db.assets.toArray(),
    ]);

    // Self-heal: rows written before the importState fix are stuck on "saving"
    // even though their bytes are stored, which disabled Open forever. Readiness
    // is a fact about whether the bytes exist, so derive it and repair the row.
    const stored = new Set(assets.filter((a) => a.blob !== undefined && a.blob.size > 0).map((a) => a.documentId));
    const stale = documents.filter((d) => d.importState !== "ready" && stored.has(d.id));
    if (stale.length > 0) {
      await db.documents.bulkPut(stale.map((d) => ({ ...d, importState: "ready" as const })));
      for (const d of stale) d.importState = "ready";
    }

    // Reopening used to mint a new document id, so the same book was saved
    // again and again under fresh ids. Collapse those back to one entry,
    // keeping the most recently opened and re-pointing its progress.
    const byHash = new Map<string, DocumentRecord>();
    const duplicates: string[] = [];
    for (const d of [...documents].sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)) {
      const key = d.contentHash;
      if (key === undefined || key === "") continue;
      const winner = byHash.get(key);
      if (winner === undefined) {
        byHash.set(key, d);
        continue;
      }
      duplicates.push(d.id);
      // Later rows hold the more recent reading position; move it to the
      // survivor before the duplicate is deleted, or the position is lost.
      const loserProgress = await db.progress.get(d.id);
      if (loserProgress !== undefined) await db.progress.put({ ...loserProgress, documentId: winner.id });
    }
    if (duplicates.length > 0) await db.documents.bulkDelete(duplicates);

    const surviving = documents.filter((d) => !duplicates.includes(d.id));
    setRows(buildLibraryRows(surviving, progress));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onImport = useCallback(
    async (file: File) => {
      setBusy(true);
      setNotice(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const source: ImportSource = {
          name: file.name,
          type: file.type,
          size: file.size,
          head: bytes.subarray(0, Math.min(bytes.byteLength, 1024)),
          bytes,
        };
        const outcome: ImportOutcome = await importDocument(
          source,
          {
            persist: async (document, blob) => {
              await db.transaction("rw", [db.documents, db.assets], async () => {
                await db.documents.put(document);
                await db.assets.put({ documentId: document.id, blob, mime: blob.type, byteSize: document.byteSize, checksum: document.contentHash ?? "" });
              });
            },
            findByHash: async (hash) => db.documents.where("contentHash").equals(hash).first() as Promise<DocumentRecord | undefined>,
          },
          "desktop",
        );
        if (outcome.kind === "rejected") setNotice({ tone: "error", text: outcome.errors.map((e) => `${e.message} ${e.action}`).join(" ") });
        else if (outcome.kind === "temporary") setNotice({ tone: "error", text: `Not saved on this device: ${outcome.message}. The file is open for this session only.` });
        else if (outcome.kind === "reused") setNotice({ tone: "ok", text: `“${outcome.document.title}” is already in your library; its saved words and progress were kept.` });
        else setNotice({ tone: "ok", text: `Imported “${outcome.document.title}”.` });
      } catch (e) {
        setNotice({ tone: "error", text: `Import failed: ${e instanceof Error ? e.message : "unknown error"}` });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const onOpen = useCallback(
    async (documentId: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await reopenDocument(documentId);
        if (!result.ok) {
          setNotice({
            tone: "error",
            text:
              result.reason === "no-stored-bytes"
                ? "The original file is no longer on this device. Import it again to read it."
                : "That document could not be found.",
          });
          return;
        }
        await onOpenDocument?.(result.file, result.document);
      } finally {
        setBusy(false);
      }
    },
    [onOpenDocument],
  );

  const onRemove = useCallback(
    async (documentId: string) => {
      try {
        await deleteSource(documentId);
        setNotice({ tone: "ok", text: "Document removed. Your saved words and marks were kept." });
      } catch (e) {
        setNotice({ tone: "error", text: `Could not remove the document: ${e instanceof Error ? e.message : "unknown error"}` });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const runExport = useCallback(async (kind: "backup" | "csv") => {
    setNotice(null);
    let outcome: ExportOutcome;
    try {
      if (kind === "backup") {
        const file = await exportBackup(db);
        outcome = exportOutcomeOf(backupFileName(), JSON.stringify(file, null, 2));
        DOWNLOAD(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), outcome.kind === "exported" ? outcome.fileName : "backup.json");
      } else {
        const csv = await exportVocabularyCsv(db);
        outcome = exportOutcomeOf(csvFileName(), csv);
        DOWNLOAD(new Blob([csv], { type: "text/csv;charset=utf-8" }), outcome.kind === "exported" ? outcome.fileName : "vocabulary.csv");
      }
    } catch (e) {
      outcome = { kind: "failed", message: e instanceof Error ? e.message : "The export could not be produced." };
    }
    setNotice({ tone: outcome.kind === "exported" ? "ok" : "error", text: announceExport(outcome) });
  }, []);

  // The live region must stay mounted while it is empty or nothing is announced,
  // so an empty notice is kept out of the layout with `sr-only` instead of being
  // unmounted.
  const noticeClass =
    notice === null
      ? "sr-only"
      : `mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
          notice.tone === "error"
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-accent/40 bg-accent-soft text-ink"
        }`;

  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
      <header>
        <h1 id={headingId} className="text-2xl font-semibold tracking-tight text-ink">
          Library
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Books saved on this device. Opening one returns you to the position you left off at.
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={() => fileInput.current?.click()} disabled={busy}>
          Open a file
        </button>
        {/*
          Driven by the button above, so it is `hidden` rather than `sr-only`: a
          visually hidden but focusable file input is a tab stop with no visible
          focus ring. `click()` on a hidden input still opens the picker.
        */}
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.epub,.txt,.md,.markdown"
          className="hidden"
          aria-label="Choose a PDF, EPUB, TXT or Markdown file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onImport(file);
          }}
        />
        <button type="button" className={BTN_SECONDARY} onClick={() => void runExport("backup")}>
          Export backup (JSON)
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={() => void runExport("csv")}>
          Export vocabulary (CSV)
        </button>
      </div>

      {/* programmatic confirmation: a transient visual badge is not announced */}
      <p role="status" aria-live="polite" className={noticeClass}>
        {notice?.text ?? ""}
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line bg-paper px-6 py-10 text-center text-sm text-ink-soft">
          No documents yet. Open a PDF, EPUB, TXT or Markdown file to start reading.
        </p>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="Imported documents">
          {rows.map((row) => (
            <li key={row.document.id} className="flex flex-col rounded-xl border border-line bg-paper p-4 shadow-sm">
              <h2 className="font-read text-lg font-semibold leading-snug text-ink">{row.document.title}</h2>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-line bg-shell px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  {row.document.format.toUpperCase()}
                </span>
                <span className="text-xs text-ink-soft">{formatBytes(row.document.byteSize)}</span>
              </div>

              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-ink-soft">Position</dt>
                  <dd className="font-medium text-ink">{row.positionLabel}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-ink-soft">Storage</dt>
                  <dd className="text-ink-soft">{row.storageLabel}</dd>
                </div>
              </dl>

              {row.document.importState !== "ready" && (
                <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-xs font-medium text-danger">
                  This document is not saved on this device.
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2 sm:mt-auto sm:pt-4">
                {/* Never disabled on importState alone. A row whose bytes are
                    stored is openable, and a row whose bytes are NOT stored
                    cannot be fixed by hiding the control — it needs a sentence
                    the learner can act on. `canOpen` is derived from the asset
                    table, the same fact reopenDocument checks. */}
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => void onOpen(row.document.id)}
                  aria-label={`Open ${row.document.title}${row.progression !== undefined ? ` at ${row.positionLabel}` : ""}`}
                >
                  {row.progression === undefined ? "Open" : `Open at ${row.positionLabel}`}
                </button>
                <button type="button" className={BTN_QUIET} onClick={() => void onRemove(row.document.id)} aria-label={`Remove ${row.document.title}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}