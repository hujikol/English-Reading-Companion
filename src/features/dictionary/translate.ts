/** Explicit online translation; dictionary selection itself stays offline. */
export async function translateToIndonesian(text: string, request: typeof fetch = fetch): Promise<string> {
  const query = text.trim();
  if (!query) throw new Error("Select text to translate.");
  if (new TextEncoder().encode(query).length > 500) throw new Error("Select a shorter sentence (maximum 500 UTF-8 bytes).");
  const url = new URL("https://api.mymemory.translated.net/get");
  url.search = new URLSearchParams({ q: query, langpair: "en|id" }).toString();
  const response = await request(url, { signal: AbortSignal.timeout(15000), credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { responseStatus?: number; responseDetails?: string; quotaFinished?: boolean; responseData?: { translatedText?: unknown } };
  if (Number(data.responseStatus) !== 200 || data.quotaFinished) throw new Error(data.responseDetails || "Translation quota exceeded or service unavailable.");
  const result = data.responseData?.translatedText;
  if (typeof result !== "string" || !result.trim()) throw new Error("Translation service returned no text.");
  if (result.trim().toLowerCase() === query.toLowerCase()) throw new Error("The provider returned the original text. No reliable translation is available.");
  return result;
}
