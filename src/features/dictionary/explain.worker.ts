import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import { buildExplanationMessages, DEFAULT_LOCAL_MODEL, explanationSchema } from "./explain.ts";

let engine: MLCEngineInterface | null = null;
self.onmessage = async (event: MessageEvent<{ id: number; surface: string; context: string }>) => {
  const { id, surface, context } = event.data;
  try {
    const messages = buildExplanationMessages(surface, context);
    if (!engine) {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter();
      if (!adapter) throw new Error("No compatible WebGPU graphics adapter was found.");
      if (!adapter.features.has("shader-f16")) throw new Error("This model needs WebGPU shader-f16 support. Use a compatible browser and graphics adapter.");
      const { CreateMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
      const record = prebuiltAppConfig.model_list.find((model) => model.model_id === DEFAULT_LOCAL_MODEL);
      if (!record) throw new Error("The browser model is unavailable in this build.");
      engine = await CreateMLCEngine(DEFAULT_LOCAL_MODEL, {
        appConfig: {
          cacheBackend: "cache",
          model_list: [{
            ...record,
            model: "https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC/resolve/a5c9fab855e3ccbdfed2e7e69683d75f30332161/",
            model_lib: new URL("/models/qwen3-4b-webgpu.wasm", self.location.origin).href,
          }],
        },
        initProgressCallback: (progress) => self.postMessage({ id, kind: "progress", text: progress.text }),
      });
    }
    self.postMessage({ id, kind: "generating" });
    const result = await engine.chat.completions.create({
      messages, stream: false, temperature: 0.2, max_tokens: 1800,
      response_format: { type: "json_object", schema: JSON.stringify(explanationSchema) },
      extra_body: { enable_thinking: false },
    });
    const choice = result.choices[0];
    self.postMessage({ id, kind: "result", content: choice?.message.content, finishReason: choice?.finish_reason });
  } catch (error) {
    self.postMessage({ id, kind: "error", message: `The browser model could not load or run: ${error instanceof Error ? error.message.slice(0, 1500) : "Unknown error"}` });
  }
};
