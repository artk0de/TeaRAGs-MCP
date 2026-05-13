import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyProjectDefaults } from "../../src/cli/registry-resolver.js";
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

  it("unknown project name → exit code 1 (mocked)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    expect(() => applyProjectDefaults({ project: "ghost" })).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("unknown project + no other named entries → '(none)' fallback in stderr", () => {
    // Wipe the seed entry so there are zero registered names — exercises the
    // `names.join(", ") || "(none)"` branch.
    const emptyDir = mkdtempSync(join(tmpdir(), "cli-rr-empty-"));
    process.env.TEA_RAGS_DATA_DIR = emptyDir;
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((m: string) => {
      stderr.push(String(m));
      return true;
    }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    try {
      expect(() => applyProjectDefaults({ project: "ghost" })).toThrow("exit");
      expect(stderr.join("")).toMatch(/Available: \(none\)/);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.tea-rags when TEA_RAGS_DATA_DIR is unset", () => {
    // When env var is unset and project is requested, the resolver must look
    // up the home directory. We don't have a registry at ~/.tea-rags/registry.json
    // in tests, so the project is "unknown" and the function exits — but the
    // path through resolveDataDir's homedir() branch is exercised.
    delete process.env.TEA_RAGS_DATA_DIR;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    try {
      expect(() => applyProjectDefaults({ project: "definitely-not-registered-xyz" })).toThrow("exit");
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
