import { useState } from "react";
import { LibraryScreen } from "./LibraryScreen.tsx";
import { ReviewScreen } from "./ReviewScreen.tsx";
import { VocabularyScreen } from "./VocabularyScreen.tsx";
import { ReaderScreen } from "./ReaderScreen.tsx";

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

  const openInReader = (file: File) => {
    setPendingDocument(file);
    setTab("reader");
  };

  return (
    <>
      <nav aria-label="Sections">
        <ul>
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "library" && <LibraryScreen onOpenDocument={openInReader} />}
      {tab === "reader" && <ReaderScreen pendingDocument={pendingDocument} />}
      {tab === "vocabulary" && <VocabularyScreen />}
      {tab === "review" && <ReviewScreen />}
    </>
  );
}
