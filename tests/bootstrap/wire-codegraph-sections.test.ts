/**
 * The config-derived sections `wireCodegraph` composes (bd tea-rags-mcp-0qaht.39):
 * where the per-collection DuckDB files live, and whether the temporal
 * co-change build rides the codegraph deps. Observed through the wired
 * context only — wiring is side-effect free, so nothing here spawns a daemon.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { wireCodegraph } from "../../src/bootstrap/factory.js";
import type { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";

// The pool creates `<rootDir>/codegraph/` on construction, so every root is a real temp dir.
let base: string;
let APP_DATA: string;
let DB_DIR: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wire-codegraph-sections-"));
  APP_DATA = join(base, "app-data");
  DB_DIR = join(base, "codegraph-root");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function wire(codegraph: Record<string, unknown>, trajectoryGit?: Record<string, unknown>) {
  const zodConfig = {
    core: { debug: false },
    codegraph: {
      enabled: true,
      dbMemoryLimit: "2GB",
      dbThreads: 2,
      customExcludePatterns: [],
      ambiguousResolveMode: "strict",
      ...codegraph,
    },
    ...(trajectoryGit ? { trajectoryGit, vcs: { adapter: "git" } } : {}),
  } as unknown as ReturnType<typeof getZodConfig>;
  const config = { paths: { appData: APP_DATA } } as unknown as AppConfig;
  const ctx = wireCodegraph(config, zodConfig, {} as CollectionRegistry);
  expect(ctx).toBeDefined();
  return ctx!;
}

function rootDirOf(ctx: ReturnType<typeof wire>): unknown {
  return (ctx.deps.workerDescriptor?.serializableConfig as { rootDir?: unknown } | undefined)?.rootDir;
}

describe("wireCodegraph — codegraph root dir", () => {
  it("defaults to the app data dir when no dbPath is configured", () => {
    expect(rootDirOf(wire({}))).toBe(APP_DATA);
  });

  it("honours a dbPath naming a directory as the root dir", () => {
    expect(rootDirOf(wire({ dbPath: DB_DIR }))).toBe(DB_DIR);
  });

  it("treats a dbPath naming a .duckdb file as its parent directory", () => {
    expect(rootDirOf(wire({ dbPath: join(DB_DIR, "legacy.duckdb") }))).toBe(DB_DIR);
  });
});

describe("wireCodegraph — temporal co-change config", () => {
  it("rides the deps and the worker config with the git trajectory's window when git history is on", () => {
    const ctx = wire({}, { enabled: true, chunkMaxAgeMonths: 7, chunkTimeoutMs: 1234 });
    const expected = { windowMonths: 7, vcsAdapter: "git", gitTimeoutMs: 1234 };
    expect(ctx.deps.temporal).toEqual(expected);
    expect((ctx.deps.workerDescriptor?.serializableConfig as { temporal?: unknown }).temporal).toEqual(expected);
    expect(ctx.deps.temporalSymbolCommits).toBeDefined();
  });

  it("is absent everywhere when git history is off", () => {
    const ctx = wire({}, { enabled: false, chunkMaxAgeMonths: 7, chunkTimeoutMs: 1234 });
    expect(ctx.deps.temporal).toBeUndefined();
    expect((ctx.deps.workerDescriptor?.serializableConfig as { temporal?: unknown }).temporal).toBeUndefined();
    expect(ctx.deps.temporalSymbolCommits).toBeUndefined();
  });
});
