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
import { trackFStore } from "../features/vocabulary/store.ts";
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
  onOpenDocument?: (file: File) => void | Promise<void>;
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

    setRows(buildLibraryRows(documents, progress));
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
        await onOpenDocument?.(result.file);
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
        const file = await exportBackup(trackFStore);
        outcome = exportOutcomeOf(backupFileName(), JSON.stringify(file, null, 2));
        DOWNLOAD(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), outcome.kind === "exported" ? outcome.fileName : "backup.json");
      } else {
        const csv = await exportVocabularyCsv(trackFStore);
        outcome = exportOutcomeOf(csvFileName(), csv);
        DOWNLOAD(new Blob([csv], { type: "text/csv;charset=utf-8" }), outcome.kind === "exported" ? outcome.fileName : "vocabulary.csv");
      }
    } catch (e) {
      outcome = { kind: "failed", message: e instanceof Error ? e.message : "The export could not be produced." };
    }
    setNotice({ tone: outcome.kind === "exported" ? "ok" : "error", text: announceExport(outcome) });
  }, []);

  return (
    <section className="erc-screen" aria-labelledby={headingId}>
      <h1 id={headingId}>Library</h1>

      <div className="erc-toolbar">
        <button
          type="button"
          className="erc-btn erc-btn--primary"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          Open a file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.epub,.txt,.md,.markdown"
          className="erc-visually-hidden"
          aria-label="Choose a PDF, EPUB, TXT or Markdown file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onImport(file);
          }}
        />
        <button type="button" className="erc-btn" onClick={() => void runExport("backup")}>
          Export backup (JSON)
        </button>
        <button type="button" className="erc-btn" onClick={() => void runExport("csv")}>
          Export vocabulary (CSV)
        </button>
      </div>

      {/* programmatic confirmation: a transient visual badge is not announced */}
      <p role="status" aria-live="polite" className={notice?.tone === "error" ? "erc-notice erc-notice--error" : "erc-notice"}>
        {notice?.text ?? ""}
      </p>

      {rows.length === 0 ? (
        <p className="erc-empty">No documents yet. Open a PDF, EPUB, TXT or Markdown file to start reading.</p>
      ) : (
        <ul className="erc-library" aria-label="Imported documents">
          {rows.map((row) => (
            <li key={row.document.id} className="erc-library__row">
              <div>
                <h2 className="erc-library__title">{row.document.title}</h2>
                <p className="erc-library__meta">
                  {row.document.format.toUpperCase()} · {formatBytes(row.document.byteSize)} · {row.positionLabel} · {row.storageLabel}
                </p>
                {row.document.importState !== "ready" && <p className="erc-library__warn">This document is not saved on this device.</p>}
              </div>
              <button
                type="button"
                className="erc-btn"
                onClick={() => void onOpen(row.document.id)}
                disabled={onOpenDocument === undefined || row.document.importState !== "ready"}
                aria-label={`Open ${row.document.title}${row.positionLabel === "" ? "" : `, ${row.positionLabel}`}`}
              >
                {row.positionLabel === "" ? "Open" : `Open ${row.positionLabel}`}
              </button>
              <button type="button" className="erc-btn erc-btn--quiet" onClick={() => void onRemove(row.document.id)} aria-label={`Remove ${row.document.title}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}