# Dictionary and translation choices

Reviewed 8 October 2026.

The app keeps its existing Wiktionary/Kaikki English–Indonesian pack: 13,270 headwords, 19,546 senses, 264,047 compressed bytes. It installs locally in IndexedDB. Word selection performs only local lookup. Unknown words and ambiguous inflections remain explicit misses/candidates.

- [FreeDict](https://freedict.org/downloads/) offers English–Indonesian with 15,262 headwords. It is a candidate for a future coverage comparison, not proof of better definitions. Import its source data into the existing pack format rather than add another runtime library. Preserve the source's attribution and license.
- [open-language/id-en-dictionary](https://github.com/open-language/id-en-dictionary) uses both Indonesian and English WordNet and reports about four seconds to initialize. That architecture is less suitable for this lightweight browser reader than the indexed local pack.
- [LibreTranslate](https://docs.libretranslate.com/guides/supported_languages/) lists English–Indonesian and Indonesian–English models at 65 MB each. It is the self-hosted translation option; model files belong on the server. The public hosted service may require an API key. Check the instance's `/languages` response before using it.
- [MyMemory](https://mymemory.translated.net/) is the implemented online translation option. Explicit buttons send the selected word/phrase or its displayed sentence, never the uploaded document. Requests are limited to 500 UTF-8 bytes and 15 seconds. Service errors, quotas, and unchanged output are reported. No provider credentials are embedded. Translation is not an AI grammar explanation.

The primary **Explain in context** action now uses [WebLLM](https://webllm.mlc.ai/docs/) with a quantized Qwen3 4B model directly in the browser. It explains the whole sentence in Indonesian, describes the highlighted word's role and contextual meaning, offers other distinct meanings with bilingual examples, and gives a simpler English restatement. The model downloads only on an explicit request (about 2.3 GB) and uses approximately 3.4 GB of GPU memory. The model is cached by the browser; cache eviction can trigger another download. Reading and local dictionary lookup remain available when model loading fails.

No sentence is sent to an AI service. Hugging Face serves the initial model files. MyMemory remains under **Basic online translation**, which is explicitly separate from the contextual explanation. Generated explanations are labeled as AI suggestions; the learner chooses which meaning to save. Saved vocabulary retains the full explanation and exact submitted sentence.

Browser support, memory and model quality must be checked on the target device. The selected model may misinterpret ambiguous or poorly extracted text. The editable context preserves full sentences and rejects input beyond 2,000 characters rather than silently cropping it.
