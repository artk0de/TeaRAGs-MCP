import { describe, expect, it, vi } from "vitest";

import {
  fetchLlamaServerProps,
  parseLlamaServerProps,
} from "../../../../../src/core/adapters/embeddings/llama-server/props.js";

const URL_A = "http://gpu:8081";

describe("parseLlamaServerProps", () => {
  it("reads the per-slot context, slot count and model path", () => {
    // Shape measured on llama-server (homebrew, 2026-10): `-c 32768 -np 4`
    // reports default_generation_settings.n_ctx = 8192 — already per slot.
    const props = parseLlamaServerProps({
      default_generation_settings: { n_ctx: 8192 },
      total_slots: 4,
      model_path: "/models/jina-embeddings-v2-base-code@latest-33a8a1b6a1cb.gguf",
    });

    expect(props).toEqual({
      nCtx: 8192,
      totalSlots: 4,
      modelPath: "/models/jina-embeddings-v2-base-code@latest-33a8a1b6a1cb.gguf",
    });
  });

  it("divides a top-level total n_ctx by the slot count when no per-slot value is reported", () => {
    expect(parseLlamaServerProps({ n_ctx: 32768, total_slots: 4 })).toEqual({ nCtx: 8192, totalSlots: 4 });
  });

  it("tolerates missing and malformed fields", () => {
    expect(parseLlamaServerProps({})).toEqual({});
    expect(parseLlamaServerProps(null)).toEqual({});
    expect(parseLlamaServerProps({ total_slots: "4", model_path: 7, default_generation_settings: "x" })).toEqual({});
  });

  it("ignores non-positive numbers", () => {
    expect(parseLlamaServerProps({ total_slots: 0, default_generation_settings: { n_ctx: -1 } })).toEqual({});
  });
});

describe("fetchLlamaServerProps", () => {
  it("GETs <url>/props with the given headers and parses the body", async () => {
    const fetchFn = vi.fn(async () => Response.json({ total_slots: 2, default_generation_settings: { n_ctx: 4096 } }));

    const props = await fetchLlamaServerProps(URL_A, {
      fetch: fetchFn,
      headers: { Authorization: "Bearer k" },
    });

    expect(props).toEqual({ nCtx: 4096, totalSlots: 2 });
    expect(fetchFn).toHaveBeenCalledWith(
      `${URL_A}/props`,
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer k" } }),
    );
  });

  it("returns undefined on 404", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));
    expect(await fetchLlamaServerProps(URL_A, { fetch: fetchFn })).toBeUndefined();
  });

  it("returns undefined when the request fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchLlamaServerProps(URL_A, { fetch: fetchFn })).toBeUndefined();
  });

  it("returns undefined when the body is not JSON", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await fetchLlamaServerProps(URL_A, { fetch: fetchFn })).toBeUndefined();
  });
});
