/**
 * Minimal app shell so the reader can actually be exercised: `npm run dev` shows
 * a working PDF reader, nothing more. The library, vocabulary and review
 * surfaces belong to other tracks; this exists so the reader has somewhere to
 * live in the entry graph.
 *
 * The reader brings its own file input, so the shell only adds a frame.
 */

import { ReaderScreen } from "../../app/ReaderScreen.tsx";

export function ReaderShell() {
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        margin: 0,
        background: "#0f1114",
        color: "#e8eaed",
        font: "14px/1.4 system-ui, sans-serif",
      }}
    >
      <ReaderScreen />
    </main>
  );
}
