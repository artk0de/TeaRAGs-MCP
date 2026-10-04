import { mkdtempSync, rmSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyProjectDefaults } from "../../src/cli/registry-resolver.js";
import { ProjectNotRegisteredError } from "../../src/core/api/public/errors.js";
import { RegistryQdrantBackendUnresolvedError } from "../../src/core/api/public/index.js";
import { CollectionRegistry } from "../../src/core/domains/maintenance/registry/collection-registry.js";

// The resolver falls back to `~/.tea-rags` when TEA_RAGS_DATA_DIR is unset, and
// opening a registry there may WRITE it (the one-time env-pin migration, bd
// tea-rags-mcp-h4l6k). Point the home directory at a scratch dir so no test in
// this file can ever touch the developer's real registry.
const scratchHome = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => scratchHome.dir || join(actual.tmpdir(), "cli-rr-scratch-home") };
});

describe("applyProjectDefaults", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rr-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    const r = new CollectionRegistry(dir);
    r.record({
      collectionName: "code_abc",
      path: "/repo/a",
      embeddingModel: "model-y",
      embeddingDimensions: 512,
      qdrantUrl: "http://qdrant:6333",
      indexedAt: "2026-05-12T00:00:00Z",
      teaRagsVersion: "0.1",
      chunksCount: 10,
    });
    r.setName("code_abc", "alpha");
  });
  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("no project → returns argv unchanged", () => {
    const out = applyProjectDefaults({ path: "/explicit", model: "m" });
    expect(out.path).toBe("/explicit");
    expect(out.model).toBe("m");
  });

  it("project → fills missing fields from registry", () => {
    const out = applyProjectDefaults({ project: "alpha" });
    expect(out.path).toBe("/repo/a");
    expect(out["qdrant-url"]).toBe("http://qdrant:6333");
    expect(out.model).toBe("model-y");
  });

  it("project + explicit path → explicit wins", () => {
    const out = applyProjectDefaults({ project: "alpha", path: "/override" });
    expect(out.path).toBe("/override");
    expect(out["qdrant-url"]).toBe("http://qdrant:6333");
  });

  it("unknown project name → throws ProjectNotRegisteredError", () => {
    expect(() => applyProjectDefaults({ project: "ghost" })).toThrow(ProjectNotRegisteredError);
  });

  it("unknown project + no other named entries → '(none)' fallback in error message", () => {
    // Wipe the seed entry so there are zero registered names — exercises the
    // `available.length > 0 ? ... : "(none)"` branch inside the error class.
    const emptyDir = mkdtempSync(join(tmpdir(), "cli-rr-empty-"));
    process.env.TEA_RAGS_DATA_DIR = emptyDir;
    try {
      expect(() => applyProjectDefaults({ project: "ghost" })).toThrow(/Available: \(none\)/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.tea-rags when TEA_RAGS_DATA_DIR is unset", () => {
    // When env var is unset and project is requested, the resolver must look
    // up the home directory. We don't have a registry at ~/.tea-rags/registry.json
    // in tests, so the project is "unknown" and the function throws — but the
    // path through resolveDataDir's homedir() branch is exercised.
    scratchHome.dir = mkdtempSync(join(tmpdir(), "cli-rr-home-"));
    try {
      delete process.env.TEA_RAGS_DATA_DIR;
      expect(() => applyProjectDefaults({ project: "definitely-not-registered-xyz" })).toThrow(
        ProjectNotRegisteredError,
      );
    } finally {
      rmSync(scratchHome.dir, { recursive: true, force: true });
      scratchHome.dir = "";
    }
  });
});

describe("applyProjectDefaults embedding endpoints (tea-rags-mcp-5jstr)", () => {
  // `tune --project X` reaches its embedding backend ONLY through the args
  // applyProjectDefaults returns — unlike `index-codebase`, it never calls
  // resolveRegistryEnv, and the identity endpoints live in dedicated
  // CollectionEntry fields rather than `entry.env`. Leaving them unresolved
  // silently calibrated every remote-ollama project against localhost:11434.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rr-embed-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    const r = new CollectionRegistry(dir);
    r.record({
      collectionName: "code_remote",
      path: "/repo/remote",
      embeddingModel: "jina",
      embeddingDimensions: 768,
      embeddingBaseUrl: "http://192.168.1.71:11434",
      embeddingFallbackUrl: "http://127.0.0.1:11434",
      qdrantUrl: "http://qdrant:6333",
      indexedAt: "2026-08-01T00:00:00Z",
      teaRagsVersion: "1.38.1",
      chunksCount: 42,
    });
    r.setName("code_remote", "remote");
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the embedding endpoint from the registry entry, not the localhost default", () => {
    const out = applyProjectDefaults({ project: "remote" });
    expect(out["embedding-url"]).toBe("http://192.168.1.71:11434");
  });

  it("resolves the embedding fallback endpoint from the registry entry", () => {
    const out = applyProjectDefaults({ project: "remote" });
    expect(out["embedding-fallback-url"]).toBe("http://127.0.0.1:11434");
  });

  it("explicit --embedding-url wins over the registry endpoint", () => {
    const out = applyProjectDefaults({ project: "remote", "embedding-url": "http://explicit:11434" });
    expect(out["embedding-url"]).toBe("http://explicit:11434");
    expect(out["embedding-fallback-url"]).toBe("http://127.0.0.1:11434");
  });

  it("leaves both endpoints undefined when the entry stores none (no '' poisoning)", () => {
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName: "code_bare",
      path: "/repo/bare",
      embeddingModel: "jina",
      embeddingDimensions: 768,
      embeddingBaseUrl: "",
      qdrantUrl: "",
      indexedAt: "",
      teaRagsVersion: "",
      chunksCount: 0,
    });
    reg.setName("code_bare", "bare");
    const out = applyProjectDefaults({ project: "bare" });
    expect(out["embedding-url"]).toBeUndefined();
    expect(out["embedding-fallback-url"]).toBeUndefined();
  });
});

describe("applyProjectDefaults qdrant backend (bd tea-rags-mcp-lzynm)", () => {
  // `tune --project X` hands `qdrant-url` to its benchmark child as an
  // explicit address. The entry's backend is resolveRegistryQdrantBackend's
  // call: a pre-sentinel entry pinning the embedded daemon's frozen ephemeral
  // port must come back as the `embedded` marker (re-resolved against the
  // live daemon), never as the dead port.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rr-qdrant-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  function register(fields: { qdrantUrl: string; teaRagsVersion: string; qdrantEmbedded?: boolean }): void {
    const r = new CollectionRegistry(dir);
    r.record({
      collectionName: "code_market",
      path: "/repo/market",
      embeddingModel: "jina",
      embeddingDimensions: 768,
      indexedAt: "2026-05-26T19:08:57.669Z",
      chunksCount: 306,
      ...fields,
    });
    r.setName("code_market", "market");
  }

  it("maps a frozen embedded-daemon port on a pre-sentinel entry to the embedded marker", () => {
    register({ qdrantUrl: "http://127.0.0.1:58372", teaRagsVersion: "1.28.0" });
    expect(applyProjectDefaults({ project: "market" })["qdrant-url"]).toBe("embedded");
  });

  it("keeps the embedded sentinel as the embedded marker", () => {
    register({ qdrantUrl: "embedded", qdrantEmbedded: true, teaRagsVersion: "1.44.2" });
    expect(applyProjectDefaults({ project: "market" })["qdrant-url"]).toBe("embedded");
  });

  it("keeps an external Qdrant's address", () => {
    register({ qdrantUrl: "http://qdrant.internal:6333", teaRagsVersion: "1.28.0" });
    expect(applyProjectDefaults({ project: "market" })["qdrant-url"]).toBe("http://qdrant.internal:6333");
  });

  it("explicit --qdrant-url wins over the registry backend", () => {
    register({ qdrantUrl: "http://127.0.0.1:58372", teaRagsVersion: "1.28.0" });
    const out = applyProjectDefaults({ project: "market", "qdrant-url": "http://explicit:6333" });
    expect(out["qdrant-url"]).toBe("http://explicit:6333");
  });

  it("throws the typed unresolved-backend error when the entry contradicts itself", () => {
    register({ qdrantUrl: "http://qdrant.internal:6333", qdrantEmbedded: true, teaRagsVersion: "1.33.0" });
    expect(() => applyProjectDefaults({ project: "market" })).toThrow(RegistryQdrantBackendUnresolvedError);
  });
});

describe("applyProjectDefaults typed-error refactor (audit #5 + #15)", () => {
  it("throws ProjectNotRegisteredError when the alias is unknown (not process.exit)", async () => {
    const { applyProjectDefaults } = await import("../../src/cli/registry-resolver.js");
    const { ProjectNotRegisteredError } = await import("../../src/core/api/public/errors.js");
    process.env.TEA_RAGS_DATA_DIR = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    try {
      expect(() => applyProjectDefaults({ project: "ghost" })).toThrow(ProjectNotRegisteredError);
    } finally {
      rmSync(process.env.TEA_RAGS_DATA_DIR, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("throws ProjectPathMissingError when entry.path is empty (audit #6/#7 + #15)", async () => {
    const { applyProjectDefaults } = await import("../../src/cli/registry-resolver.js");
    const { ProjectPathMissingError } = await import("../../src/core/api/public/errors.js");
    const { CollectionRegistry } = await import("../../src/core/domains/maintenance/registry/collection-registry.js");
    process.env.TEA_RAGS_DATA_DIR = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    try {
      const reg = new CollectionRegistry(process.env.TEA_RAGS_DATA_DIR);
      reg.record({
        collectionName: "code_recovered",
        path: "",
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_recovered", "rec");
      expect(() => applyProjectDefaults({ project: "rec" })).toThrow(ProjectPathMissingError);
    } finally {
      rmSync(process.env.TEA_RAGS_DATA_DIR, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("returns undefined (not empty string) for missing embeddingModel and qdrantUrl (audit #5)", async () => {
    const { applyProjectDefaults } = await import("../../src/cli/registry-resolver.js");
    const { CollectionRegistry } = await import("../../src/core/domains/maintenance/registry/collection-registry.js");
    const dir = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_stub",
        path: "/repo/known",
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_stub", "stub");
      const resolved = applyProjectDefaults({ project: "stub" });
      expect(resolved.model).toBeUndefined();
      expect(resolved["qdrant-url"]).toBeUndefined();
      expect(resolved.path).toBe("/repo/known");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("preserves caller-provided argv values (does not overwrite explicit args)", async () => {
    const { applyProjectDefaults } = await import("../../src/cli/registry-resolver.js");
    const { CollectionRegistry } = await import("../../src/core/domains/maintenance/registry/collection-registry.js");
    const dir = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_full",
        path: "/registry/path",
        embeddingModel: "registry-model",
        embeddingDimensions: 384,
        qdrantUrl: "http://registry-q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_full", "full");
      const resolved = applyProjectDefaults({
        project: "full",
        path: "/explicit/path",
        model: "explicit-model",
      });
      expect(resolved.path).toBe("/explicit/path");
      expect(resolved.model).toBe("explicit-model");
      expect(resolved["qdrant-url"]).toBe("http://registry-q");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });
});
