import { useEffect, useMemo, useState } from "react";
import { createBrowserExplanationProvider } from "../features/dictionary/explain.ts";
import { LibraryScreen } from "./LibraryScreen.tsx";
import { ReviewScreen } from "./ReviewScreen.tsx";
import { VocabularyScreen } from "./VocabularyScreen.tsx";
import { ReaderScreen } from "./ReaderScreen.tsx";
import { loadDictionary } from "../features/dictionary/loadPack.ts";
import type { LoadState } from "../features/dictionary/loadPack.ts";
import type { DocumentRecord } from "../db/index.ts";

type Tab = "library" | "reader" | "vocabulary" | "review";

const TABS: { id: Tab; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "reader", label: "Reader" },
  { id: "vocabulary", label: "Vocabulary" },
  { id: "review", label: "Review" },
];

// ponytail: four tabs, useState, no router. Add one when there is a URL worth
// keeping in sync — a tab that cannot be linked to does not need a router.
export function App() {
  const [localProgress, setLocalProgress] = useState("");
  const ai = useMemo(() => ({ configured: true as const, provider: createBrowserExplanationProvider(setLocalProgress) }), []);
  const [tab, setTab] = useState<Tab>("library");
  // The library hands a stored document to the reader. Holding the File here
  // means switching tabs does not lose it, and re-rendering the reader does not
  // reopen the document over the learner's place.
  const [pendingDocument, setPendingDocument] = useState<File | undefined>(undefined);
  // The stored record the file came from. Without it the reader mints a new
  // document id, so reopening duplicates the library entry and loses progress.
  const [pendingRecord, setPendingRecord] = useState<DocumentRecord | undefined>(undefined);
  // Pre-load the dictionary at startup so the first lookup is instant, and a
  // broken pack is reported in the header instead of inside the popover card.
  const [dictState, setDictState] = useState<LoadState>({ kind: "busy" });

  useEffect(() => {
    let live = true;
    loadDictionary().then((state) => {
      if (live) setDictState(state);
    });
    return () => {
      live = false;
    };
  }, []);

  const dictLoading = dictState.kind === "busy";
  const packAttribution = dictState.kind === "ready"
    ? { source: dictState.attribution.source, license: dictState.attribution.license, packVersion: dictState.packVersion }
    : null;

  const openInReader = (file: File, document?: DocumentRecord) => {
    setPendingDocument(file);
    setPendingRecord(document);
    setTab("reader");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Sections" className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
        <ul className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-2">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
                className={
                  tab === t.id
                    ? "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-shell hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                }
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
        {dictState.kind === "busy" && (
          <div className="mx-auto max-w-6xl px-4 py-1 text-xs text-ink-soft">
            Loading dictionary…
          </div>
        )}
        {dictState.kind === "absent" && (
          <div className="mx-auto max-w-6xl px-4 py-1 text-xs text-danger">
            Dictionary not ready: {dictState.reason}
          </div>
        )}
      </nav>
      {/* Keep the reader mounted across tabs to preserve its active document.
          ONE visible panel at a time. Rendering all four and hiding three with `flex-1`
          left the invisible ones claiming height, which is why the header
          whitespace grew from Reader to Vocabulary to Review. */}
      <main className={tab === "reader" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>
        {tab === "library" && <LibraryScreen onOpenDocument={openInReader} />}
        <div className={tab === "reader" ? "h-full min-h-0" : "hidden"} aria-hidden={tab !== "reader"}>
          <ReaderScreen pendingDocument={pendingDocument} pendingRecord={pendingRecord} packAttribution={packAttribution} dictLoading={dictLoading} ai={ai} localProgress={localProgress} />
        </div>
        {tab === "vocabulary" && <VocabularyScreen />}
        {tab === "review" && <ReviewScreen />}
      </main>
    </div>
  );
}
