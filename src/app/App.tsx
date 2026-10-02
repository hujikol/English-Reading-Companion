import { useState } from "react";
import { LibraryScreen } from "./LibraryScreen.tsx";
import { ReviewScreen } from "./ReviewScreen.tsx";
import { VocabularyScreen } from "./VocabularyScreen.tsx";
import { ReaderShell } from "../ui/reader/ReaderShell.tsx";

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
      {tab === "library" && <LibraryScreen />}
      {tab === "reader" && <ReaderShell />}
      {tab === "vocabulary" && <VocabularyScreen />}
      {tab === "review" && <ReviewScreen />}
    </>
  );
}
