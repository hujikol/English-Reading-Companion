/**
 * Writes the reader fixture PDF to dist/ so a browser can open it from disk
 * during manual testing. Run with: npx vite-node tests/ui/reader/writeFixture.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { makeSamplePdf } from "./samplePdf.ts";

const target = process.argv[2] ?? "dist/sample-reader-fixture.pdf";
mkdirSync(target.split("/").slice(0, -1).join("/") || ".", { recursive: true });
const bytes = makeSamplePdf();
writeFileSync(target, bytes);
console.log(`wrote ${target} (${bytes.length} bytes)`);
