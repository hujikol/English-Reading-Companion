/**
 * Library model: import, list, backup, CSV.
 *
 * Section 4 library surface: open file, recent documents, progress, format,
 * storage status, remove document. Plus Section 11's JSON backup and CSV export.
 *
 * The import path uses Track A's `validatePdfImport` and `identity` modules as-is.
 * Nothing here re-implements validation or hashing.
 */

import type { Format } from "../../contracts/index.ts";
import type { DocumentRecord, ProgressRecord } from "../../db/index.ts";
import { newDocumentId, reconcileDuplicate, sha256, type Sha256 } from "../../features/library/identity.ts";
import { validatePdfImport, type DeviceTier, type ImportError, type ImportNotice, type ImportValidation } from "../../features/library/validate.ts";

export const SUPPORTED_EXTENSIONS = [".pdf", ".epub", ".txt", ".md", ".markdown"] as const;

export type ImportSource = { name: string; type: string; size: number; head: Uint8Array; bytes: Uint8Array };

/** Filename is untrusted text: it decides only which adapter runs, never whether bytes are trusted. */
export const extensionOf = (name: string): string => {
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
};

export const formatOf = (name: string): Format | null => {
  switch (extensionOf(name)) {
    case ".pdf":
      return "pdf";
    case ".epub":
      return "epub";
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "md";
    default:
      return null;
  }
};

export type ImportPlan =
  | { kind: "rejected"; errors: ImportError[] }
  | {
      kind: "accepted";
      format: Format;
      documentId: string;
      /** byte signature result, with the notices that do not block the open */
      validation: ImportValidation;
      notices: ImportNotice[];
      title: string;
    };

/** Title shown in the library: the filename without its extension, never parsed as a format. */
export const titleFromName = (name: string): string => {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf(".");
  return (at > 0 ? trimmed.slice(0, at) : trimmed) || "Untitled";
};

/**
 * Validate before anything is written. PDF goes through the Track A validator;
 * the other formats are checked for extension and size here and left to their
 * adapters (Track D owns EPUB/TXT/MD parsing).
 */
export function planImport(source: ImportSource, tier: DeviceTier = "desktop"): ImportPlan {
  const format = formatOf(source.name);
  if (format === null)
    return {
      kind: "rejected",
      errors: [
        {
          code: "unsupported-extension",
          message: `"${source.name}" is not a supported file type.`,
          action: "Choose a PDF, EPUB, TXT or Markdown file.",
        },
      ],
    };

  if (format !== "pdf") {
    if (source.size === 0)
      return {
        kind: "rejected",
        errors: [{ code: "empty", message: "This file is empty (0 bytes).", action: "Choose the file again." }],
      };
    const limit = 25 * 1024 * 1024;
    if (source.size > limit)
      return {
        kind: "rejected",
        errors: [
          {
            code: "oversized",
            message: `This file is ${(source.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${limit / 1024 / 1024} MiB.`,
            action: "Split the file or choose a smaller one.",
          },
        ],
      };
    return {
      kind: "accepted",
      format,
      documentId: newDocumentId(),
      validation: { ok: true, state: "validating", passwordRequired: false, renderOnly: false, semantic: true, notices: [] },
      notices: [],
      title: titleFromName(source.name),
    };
  }

  const validation = validatePdfImport({
    name: source.name,
    mimeType: source.type,
    byteSize: source.size,
    tier,
    head: source.head,
  });
  if (!validation.ok) return { kind: "rejected", errors: validation.errors };

  return {
    kind: "accepted",
    format,
    documentId: newDocumentId(),
    validation,
    notices: validation.notices,
    title: titleFromName(source.name),
  };
}

export type ImportOutcome =
  | { kind: "imported"; document: DocumentRecord; reused: false }
  /** exact bytes already stored: reuse it, never overwrite saved vocabulary or progress */
  | { kind: "reused"; document: DocumentRecord; reused: true }
  | { kind: "rejected"; errors: ImportError[] }
  /** display may continue; persistence did not happen, so state says `temporary` */
  | { kind: "temporary"; document: DocumentRecord; message: string };

export type Persist = (document: DocumentRecord, blob: Blob) => Promise<void>;
export type FindByHash = (hash: Sha256) => Promise<DocumentRecord | undefined>;

/**
 * Hash in the background, then decide. Until the hash lands the document id is
 * real but the record is `temporary`: "saved locally" is only claimed after the
 * write resolved (section 4, "Never imply persistence before a write succeeds").
 */
export async function importDocument(
  source: ImportSource,
  deps: { persist: Persist; findByHash: FindByHash; now?: number },
  tier: DeviceTier = "desktop",
): Promise<ImportOutcome> {
  const plan = planImport(source, tier);
  if (plan.kind === "rejected") return { kind: "rejected", errors: plan.errors };

  const now = deps.now ?? Date.now();
  // exact bytes only (section 5). reconcileDuplicate is the single decision point.
  const contentHash = await sha256(source.bytes);
  const existing = await deps.findByHash(contentHash);
  const decision = reconcileDuplicate(
    contentHash,
    existing === undefined ? new Map() : new Map([[contentHash, existing.id]]),
    plan.documentId,
  );
  if (decision.kind === "duplicate" && existing !== undefined) return { kind: "reused", document: existing, reused: true };

  // persist() writes the document row and its bytes together. So the row must be
  // persisted in the state it will actually be in afterwards: writing "saving"
  // and returning a "ready" copy left every stored document permanently marked
  // "saving", which disabled the library's Open button for good.
  const document: DocumentRecord = {
    id: plan.documentId,
    contentHash,
    title: plan.title,
    originalName: source.name,
    format: plan.format,
    byteSize: source.size,
    importedAt: now,
    lastOpenedAt: now,
    importState: "ready",
  };

  try {
    await deps.persist(document, new Blob([source.bytes.slice().buffer], { type: source.type || "application/octet-stream" }));
  } catch (e) {
    // Truthful failure: nothing was persisted, so the row (if any) is not
    // claimable. The file still reads for this session.
    return {
      kind: "temporary",
      document: { ...document, importState: "temporary" },
      message: e instanceof Error ? e.message : "The file could not be saved on this device.",
    };
  }

  return { kind: "imported", document, reused: false };
}

// ------------------------------------------------------------------ listing

export type LibraryRow = {
  document: DocumentRecord;
  /** 0..1, undefined when nothing has been written yet */
  progression: number | undefined;
  positionLabel: string;
  storageLabel: string;
  /** false while a write is outstanding or failed: never show Saved before it succeeded */
  savedLocally: boolean;
};

export const positionLabelOf = (progress: ProgressRecord | undefined): string => {
  const locator = progress?.locator;
  if (!locator) return "Not started";
  if (locator.kind === "pdf") return `Page ${locator.pageIndex + 1}`;
  if (locator.kind === "epub") return locator.spineHref;
  return `Block ${locator.blockId}`;
};

/**
 * The library's stable order is recency: most recently opened first. It never
 * renumbers anything and never claims a page number for a format without pages.
 */
export const buildLibraryRows = (
  documents: readonly DocumentRecord[],
  progress: readonly ProgressRecord[],
): LibraryRow[] => {
  const byId = new Map(progress.map((p) => [p.documentId, p]));
  return [...documents]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.id.localeCompare(b.id))
    .map((document) => {
      const row = byId.get(document.id);
      // "Saved locally" is a claim about the DOCUMENT record, not about progress:
      // a row whose write failed must read as unsaved, and `temporary` never saved at all.
      const savedLocally = document.importState === "ready";
      const storageLabel =
        document.importState === "ready"
          ? row === undefined
            ? "Saved on this device — no position yet"
            : `Saved on this device — ${positionLabelOf(row)}`
          : document.importState === "saving"
            ? "Saving…"
            : document.importState === "temporary"
              ? "Temporary session only"
              : "Save failed";
      return {
        document,
        progression: row?.progression,
        positionLabel: positionLabelOf(row),
        storageLabel,
        savedLocally,
      };
    });
};

// ------------------------------------------------------------------ exports

export const backupFileName = (now: number = Date.now()): string =>
  `erc-backup-${new Date(now).toISOString().slice(0, 10)}.json`;

export const csvFileName = (now: number = Date.now()): string =>
  `erc-vocabulary-${new Date(now).toISOString().slice(0, 10)}.csv`;

export type ExportOutcome =
  | { kind: "exported"; fileName: string; byteSize: number }
  | { kind: "failed"; message: string };

/** Bytes are produced first; only a real blob reports exported. */
export const exportOutcomeOf = (fileName: string, text: string): ExportOutcome => ({
  kind: "exported",
  fileName,
  byteSize: new TextEncoder().encode(text).byteLength,
});

export const announceExport = (o: ExportOutcome): string =>
  o.kind === "exported" ? `Exported ${o.fileName}.` : `Export failed: ${o.message}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}