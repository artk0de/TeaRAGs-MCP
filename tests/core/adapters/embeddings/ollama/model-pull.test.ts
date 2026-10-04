import { describe, expect, it, vi } from "vitest";

import { OllamaModelPullFailedError } from "../../../../../src/core/adapters/embeddings/ollama/errors.js";
import { ensureOllamaModelPresent } from "../../../../../src/core/adapters/embeddings/ollama/model-pull.js";

const BASE_URL = "http://box:11434";
const MODEL = "unclemusclez/jina-embeddings-v2-base-code:latest";

function ndjsonResponse(lines: unknown[]): Response {
  return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { status: 200 });
}

function progress(completed: number, total = 1000) {
  return { status: "pulling 33a8a1b6a1cb", digest: "sha256:33a8a1b6a1cb", total, completed };
}

describe("ensureOllamaModelPresent", () => {
  it("reports present without pulling when /api/show knows the model", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const log = vi.fn();

    await expect(ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log })).resolves.toBe("present");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/show`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ model: MODEL });
  });

  it("pulls the model when /api/show answers 404 and reports pulled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"model not found"}', { status: 404 }))
      .mockResolvedValueOnce(
        ndjsonResponse([{ status: "pulling manifest" }, progress(500), progress(1000), { status: "success" }]),
      );
    const log = vi.fn();

    await expect(ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log })).resolves.toBe("pulled");

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/pull`);
    expect(JSON.parse(init.body as string)).toEqual({ model: MODEL, stream: true });
  });

  it("logs pull progress at most once per 10%", async () => {
    const steps = Array.from({ length: 101 }, (_, i) => progress(i * 10));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(ndjsonResponse([...steps, { status: "success" }]));
    const log = vi.fn();

    await ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log });

    const progressLines = log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("%"));
    expect(progressLines.length).toBeGreaterThan(0);
    expect(progressLines.length).toBeLessThanOrEqual(11);
    expect(progressLines.at(-1)).toContain("100%");
  });

  it("throws naming `ollama pull <model>` when the pull stream reports an error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(ndjsonResponse([{ status: "pulling manifest" }, { error: "pull model manifest: 412" }]));

    const pending = ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log: vi.fn() });

    await expect(pending).rejects.toBeInstanceOf(OllamaModelPullFailedError);
    await expect(pending).rejects.toThrow(/pull model manifest: 412/);
    await expect(pending).rejects.toMatchObject({ hint: expect.stringContaining(`ollama pull ${MODEL}`) });
  });

  it("throws when /api/pull itself answers non-ok", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response('{"error":"pull model manifest: file does not exist"}', { status: 500 }));

    await expect(ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log: vi.fn() })).rejects.toThrow(
      /file does not exist/,
    );
  });

  it("throws when the pull stream ends without success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(ndjsonResponse([{ status: "pulling manifest" }, progress(300)]));

    await expect(ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log: vi.fn() })).rejects.toBeInstanceOf(
      OllamaModelPullFailedError,
    );
  });

  it("leaves an unreachable server to the embed path (no pull, reports present)", async () => {
    // A transport failure says nothing about whether the model exists; the
    // embed path owns unavailability (recovery wait, failover).
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(ensureOllamaModelPresent(BASE_URL, MODEL, { fetch: fetchImpl, log: vi.fn() })).resolves.toBe(
      "present",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
