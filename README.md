# English Reading Companion

A local-first reading companion for Indonesian learners reading English novels, textbooks, articles, and professional material.

> Keep the book, rather than the translation interface, at the center of the experience.

## Status

In development. The reader, dictionary lookup, vocabulary and review flows work;
see [known limitations](docs/known-limitations.md) for the remaining gaps.

## What it does

- Open a **local** file — PDF, EPUB, TXT, Markdown. Nothing is uploaded.
- Parse readable text lazily, then load nearby pages as you scroll.
- Look up a **selected** word against an **offline** English–Indonesian dictionary. A dictionary miss never silently starts a network request.
- Optionally run a browser-local model for a contextual explanation — only on explicit request, never on selection.
- Save vocabulary with its source context, then review it. Everything works with AI disabled.

## Reader behavior and limits

All supported formats open as selectable text, with Paged and Scroll modes. Scroll parses nearby pages automatically and keeps the toolbar visible. The library preserves each document's last page and reuses repeated imports. Saved highlights can be opened from the reader sidebar.

The bundled Wiktionary/Kaikki English–Indonesian dictionary works locally. Contextual explanations run locally in the browser using WebGPU and Qwen3 4B, downloaded on first request. Basic online translation remains available through MyMemory. See [dictionary options](docs/dictionary-options.md).

PDF text extraction depends on the document's embedded text. Scanned pages need OCR; complex columns and poor embedded OCR can still affect reading order. Text mode does not reproduce images or print layouts.

## Contextual explanations

Select a word, check the full **Sentence context**, and choose **Explain in context**. The explanation includes the sentence meaning in Indonesian, a natural translation, the word's meaning in that sentence, alternate meanings, grammar notes, and bilingual examples. Choose **Use this meaning** before saving it to vocabulary; saved AI results retain their source and context.

Use a browser with WebGPU and `shader-f16` support and enough GPU memory (the model advertises about 3.4 GB). The first explanation downloads about **2.3 GB** of model weights into browser storage; later requests reuse that cache. No Ollama installation or API key is needed. Generation stays on the device. Clearing browser storage requires another download. The separate **Basic online translation** action sends the chosen text to MyMemory.

Explanation history preserves separate saved results, including repeated requests. Learning backups use format version 2; export a fresh backup before using an older build.

## Running it

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # typecheck (node + app scopes) then vite build, then the offline inventory
npm test           # vitest; run the build first (offline tests inspect dist/)
npm run offline:smoke # verify built offline assets and size budgets
```

Node 24. If `node -v` reports v16, `/usr/local/bin/node` is shadowing nvm — run `source ~/.nvm/nvm.sh && nvm use 24` first. The same trap breaks `npm test` with `crypto.getRandomValues is not a function`.

CI runs on Ubuntu 24.04 with Node 24. Tests use the tracked dictionary in `public/dictionary/`; ignored local `packs/` files are not required.

## Product rules

- Preserve the original English alongside any explanation. Never replace the reading text with a translation.
- Label dictionary senses and AI explanations with distinct sources.
- No accounts, no cloud sync, no DRM circumvention, no whole-book translation.
- Selected PDFs must keep working when semantic extraction fails.

## Stack

React · TypeScript · Tailwind CSS · Vite · PDF.js · Dexie · WebLLM (WebGPU). The optional inspector WASM is bundled; Tauri desktop delivery remains planned.

One repository, one web application. No monorepo, no dependency-injection container, no provider marketplace.

## Roadmap

Tracked in `IDEA.md` §22 as parallel workstreams, gated on evidence rather than dates: foundations, then the reader, dictionary, formats, semantic extraction, vocabulary/review and offline delivery, then hardening.

## License

Not yet chosen. Add a `LICENSE` file before the first public release.

Third-party notices land with the first vendored dependency. The vendored PDF.js CMaps and standard fonts, and the inspector WASM, carry their own upstream licenses; `public/README.md` records them.
