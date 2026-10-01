# English Reading Companion

A local-first reading companion for Indonesian learners reading English novels, textbooks, articles, and professional material.

> Keep the book, rather than the translation interface, at the center of the experience.

## Status

Planning. No application code exists yet.

`IDEA.md` holds the full implementation plan (scope, architecture, performance budgets, phases, risks). It is git-ignored as a personal working document — it lives in your local checkout, not in the repository.

## What it will do

- Open a **local** file — PDF, EPUB, TXT, Markdown. Nothing is uploaded.
- Render the document first; classification, hashing, dictionary setup, and semantic extraction never block reading.
- Look up words on hover/tap against an **offline** English–Indonesian dictionary. A dictionary miss never silently starts a network request.
- Optionally ask an AI provider for a contextual explanation — only on explicit request, never on hover.
- Save vocabulary with its source context, then review it. Everything works with AI disabled.

## Product rules

- Preserve the original English alongside any explanation. Never replace the reading text with a translation.
- Label dictionary senses and AI explanations with distinct sources.
- No accounts, no cloud sync, no DRM circumvention, no whole-book translation.
- Selected PDFs must keep working when semantic extraction fails.

## Planned stack

React · TypeScript · Vite · `pdfjs-dist` · `@firecrawl/pdf-inspector-wasm` · Dexie · Tauri (desktop, optional, added later)

One repository, one web application. No monorepo, no dependency-injection container, no provider marketplace.

## Roadmap

Ten phases, gated on evidence rather than dates. Phase 0 (feasibility spikes and baselines) must confirm six gates — package, browser, alignment, scheduling, dictionary, AI — before any of it is treated as real.

Core v0.1 estimate: roughly 24–39 working days for one experienced developer, revised after Phase 0.

## License

Not yet chosen. Add a `LICENSE` file before the first public release.

Third-party notices land with the first vendored dependency.
