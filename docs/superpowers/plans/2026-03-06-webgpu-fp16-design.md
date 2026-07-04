# WebGPU + FP16 for ONNX Embeddings

**Date**: 2026-03-06 **Branch**: feat/onnx-embedding-provider

## Problem

ONNX embeddings on CPU with Q8 model achieve ~12 items/sec on 800-char chunks.
transformers.js v4 supports WebGPU (Metal on macOS) natively in Node.js.
Benchmark: FP16 + WebGPU = 31 items/sec on 800-char chunks — 2.5x faster.

## Design

### Changes

1. **Default model**: `jinaai/jina-embeddings-v2-base-code-q8` →
   `jinaai/jina-embeddings-v2-base-code-fp16`
2. **Device**: hardcode `webgpu` in worker, remove `EMBEDDING_DEVICE` config
3. **Dependencies**: `@huggingface/transformers@next` + `@huggingface/hub` as
   optional deps with clear install error message
4. **HF Hub downloader**: pre-download model via `@huggingface/hub` before
   pipeline init for faster first-run with progress logging
5. **Cleanup**: remove `device.ts`, `coreml.ts`, device field from
   schema/parse/factory

### Files affected

- `package.json` — remove transformers from deps, document install command
- `src/bootstrap/config/schemas.ts` — remove `device` field
- `src/bootstrap/config/parse.ts` — remove `EMBEDDING_DEVICE` env
- `src/core/adapters/embeddings/factory.ts` — remove device logic, remove
  `device.ts` import
- `src/core/adapters/embeddings/onnx.ts` — remove device param, add clear
  install error
- `src/core/adapters/embeddings/onnx/worker.ts` — simplify: webgpu + HF Hub
  download
- `src/core/adapters/embeddings/onnx/coreml.ts` — DELETE
- `src/core/adapters/embeddings/onnx/device.ts` — DELETE
- `src/core/adapters/embeddings/onnx/huggingface-transformers.d.ts` — update for
  v4 API

### Benchmark results

| Config            | 200 chars | 800 chars |
| ----------------- | --------- | --------- |
| Q8 CPU (current)  | 63/s      | 12.6/s    |
| FP16 WebGPU (new) | 114/s     | 31.5/s    |
| **Speedup**       | **1.8x**  | **2.5x**  |
