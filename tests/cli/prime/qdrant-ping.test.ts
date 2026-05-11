import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pingQdrant } from "../../../src/cli/prime/qdrant-ping.js";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("pingQdrant", () => {
  it("returns true when fetch responds with ok=true", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await pingQdrant("http://127.0.0.1:6333")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:6333/readyz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when fetch responds with ok=false", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    expect(await pingQdrant("http://127.0.0.1:6333")).toBe(false);
  });

  it("returns false when fetch throws (network error / abort)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await pingQdrant("http://127.0.0.1:6333")).toBe(false);
  });

  it("uses /readyz endpoint suffix", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await pingQdrant("http://example.com:9999");
    expect(fetchMock.mock.calls[0][0]).toBe("http://example.com:9999/readyz");
  });
});
