import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadVerifiedGguf,
  parseOllamaModelReference,
  resolveOllamaRegistryGguf,
  type OllamaRegistryGgufSource,
} from "../../../../../src/core/adapters/embeddings/ollama-registry/gguf-source.js";

/** Real manifest of unclemusclez/jina-embeddings-v2-base-code:latest, captured 2026-10-03. */
const JINA_MANIFEST = {
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: {
    mediaType: "application/vnd.docker.container.image.v1+json",
    digest: "sha256:dce7553962dbaa36d9f4f9d713cf8fb0e9729323b8cd78c88320434836d86548",
    size: 279,
  },
  layers: [
    {
      mediaType: "application/vnd.ollama.image.model",
      digest: "sha256:33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986",
      size: 322997312,
    },
  ],
};

const JINA = "unclemusclez/jina-embeddings-v2-base-code:latest";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceFor(bytes: Buffer, overrides: Partial<OllamaRegistryGgufSource> = {}): OllamaRegistryGgufSource {
  const sha256 = sha256Hex(bytes);
  return {
    reference: "library/tiny:latest",
    blobUrl: `https://registry.ollama.ai/v2/library/tiny/blobs/sha256:${sha256}`,
    sha256,
    size: bytes.length,
    fileName: `tiny@latest-${sha256.slice(0, 12)}.gguf`,
    ...overrides,
  };
}

describe("parseOllamaModelReference", () => {
  it("splits a namespaced reference with a tag", () => {
    expect(parseOllamaModelReference(JINA)).toEqual({
      namespace: "unclemusclez",
      name: "jina-embeddings-v2-base-code",
      tag: "latest",
    });
  });

  it("maps a bare library name to namespace library and tag latest", () => {
    expect(parseOllamaModelReference("nomic-embed-text")).toEqual({
      namespace: "library",
      name: "nomic-embed-text",
      tag: "latest",
    });
  });

  it("keeps an explicit tag on a bare library name", () => {
    expect(parseOllamaModelReference("nomic-embed-text:v1.5")).toEqual({
      namespace: "library",
      name: "nomic-embed-text",
      tag: "v1.5",
    });
  });

  it("rejects an empty reference", () => {
    expect(() => parseOllamaModelReference("  ")).toThrow(/model reference/i);
  });
});

describe("resolveOllamaRegistryGguf", () => {
  it("resolves the model layer of the real jina manifest", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(JINA_MANIFEST), { status: 200 }));

    const source = await resolveOllamaRegistryGguf(JINA, { fetch: fetchImpl });

    expect(source).toEqual({
      reference: JINA,
      blobUrl:
        "https://registry.ollama.ai/v2/unclemusclez/jina-embeddings-v2-base-code/blobs/sha256:33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986",
      sha256: "33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986",
      size: 322997312,
      fileName: "jina-embeddings-v2-base-code@latest-33a8a1b6a1cb.gguf",
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://registry.ollama.ai/v2/unclemusclez/jina-embeddings-v2-base-code/manifests/latest");
    expect(new Headers(init.headers).get("Accept")).toBe("application/vnd.docker.distribution.manifest.v2+json");
  });

  it("addresses a bare library name under library/", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(JINA_MANIFEST), { status: 200 }));

    await resolveOllamaRegistryGguf("nomic-embed-text", { fetch: fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://registry.ollama.ai/v2/library/nomic-embed-text/manifests/latest");
  });

  it("throws naming the reference when the registry does not know it", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }));

    await expect(resolveOllamaRegistryGguf("nobody/nothing:latest", { fetch: fetchImpl })).rejects.toThrow(
      /nobody\/nothing:latest.*404/,
    );
  });

  it("throws when the manifest has no model layer", async () => {
    const manifest = { ...JINA_MANIFEST, layers: [] };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200 }));

    await expect(resolveOllamaRegistryGguf(JINA, { fetch: fetchImpl })).rejects.toThrow(
      /application\/vnd\.ollama\.image\.model/,
    );
  });
});

describe("downloadVerifiedGguf", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gguf-source-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams the blob, verifies its sha256 and stores it under the source file name", async () => {
    const bytes = Buffer.from("GGUF fake model bytes");
    const source = sourceFor(bytes);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const path = await downloadVerifiedGguf(source, dir, { fetch: fetchImpl });

    expect(path).toBe(join(dir, source.fileName));
    expect(readFileSync(path)).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledWith(source.blobUrl, expect.anything());
    expect(readdirSync(dir)).toEqual([source.fileName]);
  });

  it("throws on a digest mismatch and leaves no file behind", async () => {
    const source = sourceFor(Buffer.from("the expected bytes"));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(Buffer.from("tampered bytes"), { status: 200 }));

    await expect(downloadVerifiedGguf(source, dir, { fetch: fetchImpl })).rejects.toThrow(/sha256/i);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("is a no-op when a file with the matching digest is already present", async () => {
    const bytes = Buffer.from("already here");
    const source = sourceFor(bytes);
    writeFileSync(join(dir, source.fileName), bytes);
    const fetchImpl = vi.fn();

    const path = await downloadVerifiedGguf(source, dir, { fetch: fetchImpl });

    expect(path).toBe(join(dir, source.fileName));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-downloads over a present file whose digest does not match", async () => {
    const bytes = Buffer.from("good bytes");
    const source = sourceFor(bytes);
    writeFileSync(join(dir, source.fileName), "corrupt");
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const path = await downloadVerifiedGguf(source, dir, { fetch: fetchImpl });

    expect(readFileSync(path)).toEqual(bytes);
  });

  it("creates the destination directory when missing", async () => {
    const bytes = Buffer.from("nested");
    const source = sourceFor(bytes);
    const nested = join(dir, "models", "gguf");
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const path = await downloadVerifiedGguf(source, nested, { fetch: fetchImpl });

    expect(existsSync(path)).toBe(true);
  });

  it("throws when the blob request fails and leaves no partial file", async () => {
    const source = sourceFor(Buffer.from("x"));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("denied", { status: 403 }));

    await expect(downloadVerifiedGguf(source, dir, { fetch: fetchImpl })).rejects.toThrow(/403/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
