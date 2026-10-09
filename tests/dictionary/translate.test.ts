import { expect, it, vi } from "vitest";
import { translateToIndonesian } from "../../src/features/dictionary/translate.ts";
it("translates only explicit text and handles service quotas", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: "buku" } })));
  expect(await translateToIndonesian("book", fetcher)).toBe("buku");
  expect(fetcher.mock.calls[0]?.[0].searchParams.get("langpair")).toBe("en|id");
  fetcher.mockResolvedValue(new Response(JSON.stringify({ responseStatus: 403, quotaFinished: true, responseDetails: "quota exceeded" })));
  await expect(translateToIndonesian("book", fetcher)).rejects.toThrow("quota exceeded");
  fetcher.mockClear();
  await expect(translateToIndonesian("é".repeat(251), fetcher)).rejects.toThrow("500 UTF-8 bytes");
  expect(fetcher).not.toHaveBeenCalled();
});
