import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkExternalQdrantVersion } from "../../src/bootstrap/config/qdrant-compat.js";
import { QdrantVersionTooOldError } from "../../src/core/adapters/qdrant/errors.js";

const URL = "http://qdrant.example.test:6333";

function mockFetchJson(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
    }),
  );
}

function mockFetchReject(err: Error): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
}

describe("checkExternalQdrantVersion", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes when server version equals minimum", async () => {
    mockFetchJson({ title: "qdrant", version: "1.17.0" });
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("passes when server version exceeds minimum", async () => {
    mockFetchJson({ title: "qdrant", version: "1.20.3" });
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("throws QdrantVersionTooOldError when server version is below minimum", async () => {
    mockFetchJson({ title: "qdrant", version: "1.10.0" });
    await expect(checkExternalQdrantVersion(URL)).rejects.toBeInstanceOf(QdrantVersionTooOldError);
  });

  it("includes server url, server version and min version in the error", async () => {
    mockFetchJson({ title: "qdrant", version: "1.9.5" });
    await expect(checkExternalQdrantVersion(URL)).rejects.toMatchObject({
      message: expect.stringContaining(URL),
    });
    await expect(checkExternalQdrantVersion(URL)).rejects.toMatchObject({
      message: expect.stringContaining("1.9.5"),
    });
    await expect(checkExternalQdrantVersion(URL)).rejects.toMatchObject({
      message: expect.stringContaining("1.17.0"),
    });
  });

  it("skips silently when fetch fails (connection error) — defers to QdrantManager health handling", async () => {
    mockFetchReject(new Error("ECONNREFUSED"));
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("skips silently when endpoint does not return a version field (proxy / older server)", async () => {
    mockFetchJson({ title: "qdrant" });
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("skips silently when endpoint returns non-OK HTTP status", async () => {
    mockFetchJson({}, false, 401);
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("skips silently when version field is not a semver string", async () => {
    mockFetchJson({ title: "qdrant", version: "not-semver" });
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("accepts version string with leading 'v' prefix", async () => {
    mockFetchJson({ title: "qdrant", version: "v1.17.0" });
    await expect(checkExternalQdrantVersion(URL)).resolves.toBeUndefined();
  });

  it("supports apiKey header for authenticated Qdrant instances", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: "1.17.0" }),
    });
    vi.stubGlobal("fetch", spy);
    await checkExternalQdrantVersion(URL, "secret-key");
    const call = spy.mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("secret-key");
  });
});
