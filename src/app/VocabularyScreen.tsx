/**
 * Vocabulary screen: the saved words, their meanings, where they were seen, and
 * the original explanation kept visibly separate from the user's meaning.
 *
 * Reads and writes go through `ui/vocab/vocabularyPage.ts`, which calls Track F's
 * `listVocabulary` / `occurrencesOf` / `editMeaning`. No write result is
 * displayed before the write resolved.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { db } from "../db/index.ts";
import { trackFStore } from "../features/vocabulary/store.ts";
import {
  announceEdit,
  loadVocabulary,
  saveMeaning,
  type VocabularyPage,
  type VocabularyRow,
} from "../ui/vocab/vocabularyPage.ts";

export function VocabularyScreen() {
  const [page, setPage] = useState<VocabularyPage | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "learning" | "known">("all");
  const [announcement, setAnnouncement] = useState("");
  const headingId = useId();

  const refresh = useCallback(
    async (q: string, s: "all" | "learning" | "known") => {
      const titles = new Set((await db.documents.toArray()).map((d) => d.id));
      setPage(await loadVocabulary(trackFStore, { query: q, status: s }, titles));
    },
    [],
  );

  useEffect(() => {
    void refresh(query, status);
  }, [refresh, query, status]);

  const onSave = useCallback(
    async (row: VocabularyRow, meaning: string) => {
      const outcome = await saveMeaning(trackFStore, row.vocabulary.id, meaning);
      setAnnouncement(announceEdit(row.vocabulary.surface, outcome));
      await refresh(query, status);
    },
    [query, refresh, status],
  );

  return (
    <section className="erc-screen" aria-labelledby={headingId}>
      <h1 id={headingId}>Vocabulary</h1>

      <div className="erc-toolbar">
        <label className="erc-field erc-field--inline">
          <span>Search saved words</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="word or meaning" />
        </label>
        <label className="erc-field erc-field--inline">
          <span>Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as "all" | "learning" | "known")}>
            <option value="all">All</option>
            <option value="learning">Learning</option>
            <option value="known">Known</option>
          </select>
        </label>
      </div>

      <p role="status" aria-live="polite" className="erc-notice">
        {announcement}
      </p>
      <p className="erc-count" aria-live="polite">
        {page === null ? "" : `${page.filtered} of ${page.total} saved words`}
      </p>

      {page !== null && page.rows.length === 0 && <p className="erc-empty">Nothing saved yet. Select a word while reading and choose “Save to vocabulary”.</p>}

      <ul className="erc-vocab" aria-label="Saved words">
        {(page?.rows ?? []).map((row) => (
          <li key={row.vocabulary.id} className="erc-vocab__row">
            <VocabularyRowView row={row} onSave={onSave} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function VocabularyRowView({ row, onSave }: { row: VocabularyRow; onSave: (row: VocabularyRow, meaning: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.vocabulary.meaning);
  const inputId = useId();

  return (
    <article className="erc-vocab__card">
      <h2 className="erc-vocab__surface">
        {row.vocabulary.surface}
        {row.vocabulary.lemma !== undefined && row.vocabulary.lemma !== row.vocabulary.surface && (
          <span className="erc-vocab__lemma">of {row.vocabulary.lemma}</span>
        )}
        <span className={`erc-badge erc-badge--${row.vocabulary.status}`}>{row.vocabulary.status}</span>
      </h2>

      <div className="erc-vocab__meaning">
        <span className="erc-label">Your meaning</span>
        {editing ? (
          <>
            <label className="erc-visually-hidden" htmlFor={inputId}>
              Meaning for {row.vocabulary.surface}
            </label>
            <textarea id={inputId} value={draft} rows={2} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="erc-actions">
              <button
                type="button"
                className="erc-btn erc-btn--primary"
                onClick={() => {
                  setEditing(false);
                  void onSave(row, draft);
                }}
              >
                Save meaning
              </button>
              <button type="button" className="erc-btn" onClick={() => { setDraft(row.vocabulary.meaning); setEditing(false); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p>{row.vocabulary.meaning}</p>
            <button type="button" className="erc-btn erc-btn--quiet" onClick={() => setEditing(true)} aria-label={`Edit the meaning of ${row.vocabulary.surface}`}>
              Edit meaning
            </button>
          </>
        )}
      </div>

      {/*
        The generated explanation is user data of its own. Editing the meaning
        above must never change it, so it gets its own labelled block.
      */}
      {row.originalExplanation !== null && (
        <div className="erc-vocab__explanation">
          <span className="erc-label">
            Original explanation{row.meaningEdited ? " (you edited your meaning above)" : ""}
          </span>
          <p>{row.originalExplanation}</p>
        </div>
      )}

      {row.vocabulary.note !== undefined && row.vocabulary.note !== "" && (
        <p className="erc-vocab__note">
          <span className="erc-label">Note</span> {row.vocabulary.note}
        </p>
      )}

      <details className="erc-vocab__occurrences">
        <summary>
          Seen {row.occurrences.length === 0 ? "nowhere yet" : `${row.occurrences.length} time${row.occurrences.length === 1 ? "" : "s"}`}
        </summary>
        <ul>
          {row.occurrences.map((o) => (
            <li key={o.id}>
              <span className="erc-vocab__source">
                {o.titleSnapshot}
                {o.anchor.locator.kind === "pdf" && ` · page ${o.anchor.locator.pageIndex + 1}`}
                {row.sourcesUnavailable && <span className="erc-badge erc-badge--known">source unavailable</span>}
              </span>
              {o.sentence !== "" && <q className="erc-vocab__sentence">{o.sentence}</q>}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}