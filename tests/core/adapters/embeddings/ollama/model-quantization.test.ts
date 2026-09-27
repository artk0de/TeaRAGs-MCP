import { describe, expect, it, vi } from "vitest";

import {
  provisionQuantizedOllamaModel,
  quantizedOllamaModelTag,
  resolveOllamaQuantizationLevel,
} from "../../../../../src/core/adapters/embeddings/ollama/model-quantization.js";

const BASE = "unclemusclez/jina-embeddings-v2-base-code:latest";

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

function ndjsonStream(lines: unknown[]) {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  return { ok: true, text: async () => text };
}

describe("resolveOllamaQuantizationLevel", () => {
  it("maps turbo to the most aggressive gguf level", () => {
    expect(resolveOllamaQuantizationLevel("turbo")).toBe("q4_K_M");
  });

  it("passes concrete gguf levels through", () => {
    expect(resolveOllamaQuantizationLevel("q5_K_M")).toBe("q5_K_M");
    expect(resolveOllamaQuantizationLevel("q8_0")).toBe("q8_0");
  });

  it("treats off, unset and unknown values as off", () => {
    expect(resolveOllamaQuantizationLevel("off")).toBe("off");
    expect(resolveOllamaQuantizationLevel(undefined)).toBe("off");
    expect(resolveOllamaQuantizationLevel("q3_K_S")).toBe("off");
  });
});

describe("quantizedOllamaModelTag", () => {
  it("suffixed onto an existing tag", () => {
    expect(quantizedOllamaModelTag(BASE, "q4_K_M")).toBe("unclemusclez/jina-embeddings-v2-base-code:latest-q4_K_M");
  });

  it("becomes the tag when the base model has none", () => {
    expect(quantizedOllamaModelTag("mymodel", "q4_K_M")).toBe("mymodel:q4_K_M");
  });
});

describe("provisionQuantizedOllamaModel", () => {
  it("is a no-op for the off level", async () => {
    const fetchImpl = vi.fn();
    const result = await provisionQuantizedOllamaModel({
      baseUrl: "http://box:11434",
      baseModel: BASE,
      level: "off",
      fetchImpl,
    });
    expect(result).toEqual({ effectiveModel: BASE, quantized: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses a quantized tag the server already has", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ model_info: {} }));
    const result = await provisionQuantizedOllamaModel({
      baseUrl: "http://box:11434",
      baseModel: BASE,
      level: "q4_K_M",
      fetchImpl,
    });
    expect(result).toEqual({
      effectiveModel: `${BASE}-q4_K_M`,
      quantized: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://box:11434/api/show", expect.objectContaining({ method: "POST" }));
  });

  it("creates the quantized tag when the server does not have it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(ndjsonStream([{ status: "success" }]));
    const result = await provisionQuantizedOllamaModel({
      baseUrl: "http://box:11434",
      baseModel: BASE,
      level: "q4_K_M",
      fetchImpl,
    });
    expect(result).toEqual({
      effectiveModel: `${BASE}-q4_K_M`,
      quantized: true,
    });
    const [, createInit] = fetchImpl.mock.calls[1];
    expect(createInit).toMatchObject({
      method: "POST",
      body: JSON.stringify({ model: `${BASE}-q4_K_M`, from: BASE, quantize: "q4_K_M" }),
    });
  });

  it("warns and keeps the base model when the server cannot quantize", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await provisionQuantizedOllamaModel({
      baseUrl: "http://box:11434",
      baseModel: BASE,
      level: "q4_K_M",
      fetchImpl,
    });
    expect(result.quantized).toBe(false);
    expect(result.effectiveModel).toBe(BASE);
    expect(result.warning).toContain("q4_K_M");
  });
});
