/**
 * `tea-rags call` replays the TARGET project's registry env before the
 * in-process server is built (bd tea-rags-mcp-nxwsq) — the same seam
 * `index-codebase` and the auto-update runner use (`resolveRegistryEnv`).
 *
 * Without it `call` read only the shell: a project indexed with codegraph on
 * lost its graph tools (`Unknown tool`) unless CODEGRAPH_ENABLED=true was
 * exported, and `get_index_status` reported a false CODEGRAPH_ENABLED drift.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCallProjectEnv, resolveCallProjectEntry } from "../../../src/cli/call/project-env.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

describe("resolveCallProjectEntry", () => {
  let dataDir: string;
  let alphaDir: string;
  let bravoDir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "call-env-data-"));
    alphaDir = mkdtempSync(join(tmpdir(), "call-env-alpha-"));
    bravoDir = mkdtempSync(join(tmpdir(), "call-env-bravo-"));
    registry = new CollectionRegistry(dataDir);
    for (const [collectionName, path, name] of [
      ["code_alpha", alphaDir, "alpha"],
      ["code_bravo", bravoDir, "bravo"],
    ] as const) {
      registry.record({
        collectionName,
        path,
        embeddingModel: "m",
        embeddingDimensions: 384,
        qdrantUrl: "http://q:6333",
        indexedAt: "2026-09-01T00:00:00.000Z",
        teaRagsVersion: "1.0.0",
        chunksCount: 1,
      });
      registry.setName(collectionName, name);
    }
  });

  afterEach(() => {
    for (const dir of [dataDir, alphaDir, bravoDir]) rmSync(dir, { recursive: true, force: true });
  });

  it("addresses the project named by the `project` param", async () => {
    const entry = await resolveCallProjectEntry(registry, { project: "bravo" }, alphaDir);
    expect(entry?.collectionName).toBe("code_bravo");
  });

  it("addresses the entry of the `collection` param", async () => {
    const entry = await resolveCallProjectEntry(registry, { collection: "code_bravo" }, alphaDir);
    expect(entry?.collectionName).toBe("code_bravo");
  });

  it("addresses the entry that claims the `path` param", async () => {
    const entry = await resolveCallProjectEntry(registry, { path: bravoDir }, alphaDir);
    expect(entry?.collectionName).toBe("code_bravo");
  });

  it("falls back to the cwd's project when the params name none", async () => {
    const entry = await resolveCallProjectEntry(registry, { symbol: "Foo#bar" }, alphaDir);
    expect(entry?.collectionName).toBe("code_alpha");
  });

  it("is null for an unregistered project, collection or path — never borrows another project's env", async () => {
    expect(await resolveCallProjectEntry(registry, { project: "nope" }, alphaDir)).toBeNull();
    expect(await resolveCallProjectEntry(registry, { collection: "code_nope" }, alphaDir)).toBeNull();
    expect(await resolveCallProjectEntry(registry, { path: tmpdir() }, alphaDir)).toBeNull();
    expect(
      await resolveCallProjectEntry(registry, { path: join(tmpdir(), "does-not-exist-xyz") }, alphaDir),
    ).toBeNull();
  });
});

describe("applyCallProjectEnv", () => {
  const entry = {
    collectionName: "code_alpha",
    path: "/repo",
    embeddingModel: "jina",
    embeddingDimensions: 768,
    embeddingBaseUrl: "http://gpu:11434",
    qdrantUrl: "http://q:6333",
    indexedAt: "2026-09-01T00:00:00.000Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 1,
    codegraphEnabled: true,
    env: { TRAJECTORY_GIT_ENABLED: "true" },
  };

  it("seeds the project's codegraph flag, endpoints and env snapshot into an unset shell", () => {
    const env: NodeJS.ProcessEnv = {};

    applyCallProjectEnv(entry, env);

    expect(env.CODEGRAPH_ENABLED).toBe("true");
    expect(env.EMBEDDING_BASE_URL).toBe("http://gpu:11434");
    expect(env.QDRANT_URL).toBe("http://q:6333");
    expect(env.TRAJECTORY_GIT_ENABLED).toBe("true");
  });

  it("keeps an explicit shell value over the registry's", () => {
    const env: NodeJS.ProcessEnv = { CODEGRAPH_ENABLED: "false" };

    applyCallProjectEnv(entry, env);

    expect(env.CODEGRAPH_ENABLED).toBe("false");
  });

  it("leaves the env untouched when no project was resolved", () => {
    const env: NodeJS.ProcessEnv = { FOO: "1" };

    applyCallProjectEnv(null, env);

    expect(env).toEqual({ FOO: "1" });
  });
});
