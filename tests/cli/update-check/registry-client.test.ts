import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NpmRegistryClient } from "../../../src/cli/update-check/registry-client.js";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NpmRegistryClient.fetchLatestVersion", () => {
  it("returns the version string on a 200 with a well-formed payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => Promise.resolve({ version: "1.24.0" }),
    });
    const client = new NpmRegistryClient();
    const v = await client.fetchLatestVersion("tea-rags");
    expect(v).toBe("1.24.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/tea-rags/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null on a non-OK HTTP status (4xx/5xx)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => Promise.resolve({ version: "1.24.0" }),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when the response body is malformed JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => Promise.reject(new Error("invalid json")),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when the `version` field is missing", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => Promise.resolve({}) });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when `version` is not a valid semver", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => Promise.resolve({ version: "not-semver" }),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null on network/abort error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("passes an AbortController signal when timeoutMs is set", async () => {
    fetchMock.mockImplementation(async (_url, init: { signal: AbortSignal }) => {
      return new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => {
          rej(new Error("aborted"));
        });
      });
    });
    const client = new NpmRegistryClient();
    const result = await client.fetchLatestVersion("tea-rags", { timeoutMs: 10 });
    expect(result).toBeNull();
  });
});
