import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { registerServiceWorker } from "./pwa/sw-registration.ts";
import { db } from "./db/index.ts";
import { DURABILITY } from "./contracts/durability.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// ponytail: render first, register after. Offline install must never delay or
// block the reading UI — a failed registration is a status, not an error.
// Registration is also a no-op outside a secure context, so dev over plain
// http://localhost stays quiet.
void registerServiceWorker({
  // Quota recovery may only ever evict `derived` tables. The list comes from
  // the durability contract, so a new table is covered by default.
  evictDerived: async (tables) => {
    for (const table of tables) {
      if (DURABILITY[table] !== "derived") continue;
      await db.table(table).clear();
    }
  },
}).catch((error: unknown) => {
  console.warn("service worker registration failed", error);
});
