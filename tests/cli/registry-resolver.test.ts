import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyProjectDefaults } from "../../src/cli/registry-resolver.js";
import { ProjectNotRegisteredError } from "../../src/core/api/errors.js";
import { CollectionRegistry } from "../../src/core/infra/registry/collection-registry.js";

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
    delete process.env.TEA_RAGS_DATA_DIR;
    expect(() => applyProjectDefaults({ project: "definitely-not-registered-xyz" })).toThrow(ProjectNotRegisteredError);
  });
});

describe("applyProjectDefaults typed-error refactor (audit #5 + #15)", () => {
  it("throws ProjectNotRegisteredError when the alias is unknown (not process.exit)", async () => {
    const { applyProjectDefaults } = await import("../../src/cli/registry-resolver.js");
    const { ProjectNotRegisteredError } = await import("../../src/core/api/errors.js");
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
    const { ProjectPathMissingError } = await import("../../src/core/api/errors.js");
    const { CollectionRegistry } = await import("../../src/core/infra/registry/collection-registry.js");
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
    const { CollectionRegistry } = await import("../../src/core/infra/registry/collection-registry.js");
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
    const { CollectionRegistry } = await import("../../src/core/infra/registry/collection-registry.js");
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
