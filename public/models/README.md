# Browser explanation runtime

`qwen3-4b-webgpu.wasm` is the official Qwen3 4B WebGPU runtime compatible with `@mlc-ai/web-llm` 0.2.85.

- Producer: [MLC AI](https://github.com/mlc-ai/binary-mlc-llm-libs)
- Source: https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm
- SHA-256: `a986a53c92579714eb7ec36856004f5fb75272c9f69091f14eb6b2086eea4440`
- License: [MLC LLM Apache-2.0](https://github.com/mlc-ai/mlc-llm/blob/main/LICENSE) (see LICENSE)
- Size: 5,847,049 bytes

Model weights are downloaded only when the learner clicks Explain in context. They use [MLC AI's quantized Qwen3 4B](https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC), pinned to revision `a5c9fab855e3ccbdfed2e7e69683d75f30332161`. Weight shards total 2,262,920,192 bytes, with tokenizer and configuration files in addition. Model license: [Qwen3 Apache-2.0](https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE).

The runtime is self-hosted and inventoried as optional AI. Weights live in WebLLM's browser cache rather than the app's default offline installation. Model loading can fail if WebGPU, sufficient memory, storage, or download access is unavailable. Browser eviction can require a new download. No uploaded book or sentence is sent to the model host.
