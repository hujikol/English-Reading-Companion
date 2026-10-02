import { describe, expect, it } from "vitest";
import { mimeFor } from "../../../src/ui/library/reopen.ts";

describe("mimeFor", () => {
  it("maps each supported extension to a real MIME type", () => {
    expect(mimeFor("a.pdf")).toBe("application/pdf");
    expect(mimeFor("a.epub")).toBe("application/epub+zip");
    expect(mimeFor("a.txt")).toBe("text/plain");
    expect(mimeFor("a.md")).toBe("text/markdown");
    expect(mimeFor("a.markdown")).toBe("text/markdown");
  });

  it("is case-insensitive, because uploads are not consistent", () => {
    expect(mimeFor("BOOK.PDF")).toBe("application/pdf");
    expect(mimeFor("Book.Epub")).toBe("application/epub+zip");
  });

  it("falls back rather than guessing for an unknown extension", () => {
    expect(mimeFor("a.exe")).toBe("application/octet-stream");
    expect(mimeFor("noextension")).toBe("application/octet-stream");
  });

  it("uses the LAST dot, so 'my.book.v2.pdf' is a pdf", () => {
    expect(mimeFor("my.book.v2.pdf")).toBe("application/pdf");
  });
});
