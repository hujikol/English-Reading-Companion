# English Reading Companion

A local-first reading companion for Indonesian learners reading English novels, textbooks, articles, and professional material.

> Keep the book, rather than the translation interface, at the center of the experience.

## Status

In development. The reader, dictionary lookup, vocabulary and review flows work;
see **Known gaps** below for what does not.

`IDEA.md` holds the full implementation plan (scope, architecture, performance budgets, phases, risks). It is git-ignored as a personal working document — it lives in your local checkout, not in the repository.

## What it does

- Open a **local** file — PDF, EPUB, TXT, Markdown. Nothing is uploaded.
- Render the document first; classification, hashing, dictionary setup, and semantic extraction never block reading.
- Look up a **selected** word against an **offline** English–Indonesian dictionary. A dictionary miss never silently starts a network request.
- Optionally ask an AI provider for a contextual explanation — only on explicit request, never on selection.
- Save vocabulary with its source context, then review it. Everything works with AI disabled.

## Known gaps

- **No dictionary pack is installed.** Every lookup honestly reports `no-active-pack`; the card offers to save the word with your own meaning instead. Choosing and licensing a source is the open decision.
- **Rendering is verified by build, not by eye.** The PDF pipeline is exercised in tests against real PDF bytes and the real WASM, but canvas rasterization, text-layer geometry and mark painting have not been observed in a browser.
- **No AI provider is configured**, so the explain action is disabled by construction.
- **EPUB/TXT/Markdown reading is not wired into the UI yet**; the format logic is tested but only the PDF path is reachable from the reader.

## Running it

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # typecheck (node + app scopes) then vite build, then the offline inventory
npm test           # vitest
```

Node 24. If `node -v` reports v16, `/usr/local/bin/node` is shadowing nvm — run `source ~/.nvm/nvm.sh && nvm use 24` first. The same trap breaks `npm test` with `crypto.getRandomValues is not a function`.

## Product rules

- Preserve the original English alongside any explanation. Never replace the reading text with a translation.
- Label dictionary senses and AI explanations with distinct sources.
- No accounts, no cloud sync, no DRM circumvention, no whole-book translation.
- Selected PDFs must keep working when semantic extraction fails.

## Planned stack

React · TypeScript · Vite · `pdfjs-dist` · `@firecrawl/pdf-inspector-wasm` · Dexie · Tauri (desktop, optional, added later)

One repository, one web application. No monorepo, no dependency-injection container, no provider marketplace.

## Roadmap

Tracked in `IDEA.md` §22 as parallel workstreams, gated on evidence rather than dates: foundations, then the reader, dictionary, formats, semantic extraction, vocabulary/review and offline delivery, then hardening.

## License

Not yet chosen. Add a `LICENSE` file before the first public release.

Third-party notices land with the first vendored dependency. The vendored PDF.js CMaps and standard fonts, and the inspector WASM, carry their own upstream licenses; `public/README.md` records them.
