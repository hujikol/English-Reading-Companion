import { useState } from "react";
import { LibraryScreen } from "./LibraryScreen.tsx";
import { ReviewScreen } from "./ReviewScreen.tsx";
import { VocabularyScreen } from "./VocabularyScreen.tsx";
import { ReaderScreen } from "./ReaderScreen.tsx";
import { EpubScreen } from "./EpubScreen.tsx";
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
  const [tab, setTab] = useState<Tab>("library");
  // The library hands a stored document to the reader. Holding the File here
  // means switching tabs does not lose it, and re-rendering the reader does not
  // reopen the document over the learner's place.
  const [pendingDocument, setPendingDocument] = useState<File | undefined>(undefined);
  // The stored record the file came from. Without it the reader mints a new
  // document id, so reopening duplicates the library entry and loses progress.
  const [pendingRecord, setPendingRecord] = useState<DocumentRecord | undefined>(undefined);
  // EPUB bytes, read once when the library hands over an EPUB. The PDF reader
  // takes a File; the EPUB renderer takes bytes, so both are kept in step here
  // rather than making each screen re-read the blob.
  const [pendingEpub, setPendingEpub] = useState<{ bytes: Uint8Array; name: string } | undefined>(undefined);

  const openInReader = (file: File, document?: DocumentRecord) => {
    const isEpub = /\.epub$/i.test(file.name);
    if (isEpub) {
      void file.arrayBuffer().then((buf) => {
        setPendingEpub({ bytes: new Uint8Array(buf), name: file.name });
        setPendingDocument(undefined);
        setPendingRecord(undefined);
        setTab("reader");
      });
      return;
    }
    setPendingEpub(undefined);
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
      </nav>
      {/* ONE panel at a time. Rendering all four and hiding three with `flex-1`
          left the invisible ones claiming height, which is why the header
          whitespace grew from Reader to Vocabulary to Review. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === "library" && <LibraryScreen onOpenDocument={openInReader} />}
        {tab === "reader" &&
          (pendingEpub === undefined ? (
            <ReaderScreen pendingDocument={pendingDocument} pendingRecord={pendingRecord} />
          ) : (
            <EpubScreen key={pendingEpub.name} bytes={pendingEpub.bytes} fileName={pendingEpub.name} />
          ))}
        {tab === "vocabulary" && <VocabularyScreen />}
        {tab === "review" && <ReviewScreen />}
      </main>
    </div>
  );
}
