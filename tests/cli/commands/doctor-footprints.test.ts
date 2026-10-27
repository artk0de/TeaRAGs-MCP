import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";

/**
 * The 2026-10-28 cleanup, in miniature: a live project with a stale generation
 * beside its alias target, a registration with no path, an alias nobody
 * registered, a codegraph database with nothing behind it and a stats file of a
 * collection long gone. Qdrant is an in-memory fake; the data dir is real.
 */
function fakeQdrant() {
  const live = new Set(["code_live_v1", "code_live_v2", "code_dead_v1", "code_stray_v1"]);
  const aliases = [
    { aliasName: "code_live", collectionName: "code_live_v2" },
    { aliasName: "code_dead", collectionName: "code_dead_v1" },
    { aliasName: "code_stray", collectionName: "code_stray_v1" },
  ];
  return {
    live,
    aliasList: aliases,
    listCollections: vi.fn(async () => [...live]),
    deleteCollection: vi.fn(async (name: string) => {
      live.delete(name);
    }),
    countPoints: vi.fn(async (name: string) => (name === "code_dead_v1" ? 120 : 7)),
    getPoint: vi.fn(async () => null),
    aliases: {
      listAliases: vi.fn(async () => [...aliases]),
      deleteAlias: vi.fn(async (name: string) => {
        const i = aliases.findIndex((a) => a.aliasName === name);
        if (i >= 0) aliases.splice(i, 1);
      }),
    },
  };
}

describe("doctor --footprints", () => {
  let dir: string;
  let repo: string;

  function record(collectionName: string, path: string): void {
    new CollectionRegistry(dir).record({
      collectionName,
      path,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "http://q",
      indexedAt: "",
      teaRagsVersion: "",
      chunksCount: 3,
    });
  }

  function file(...segments: string[]): string {
    const path = join(dir, ...segments);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x".repeat(10));
    return path;
  }

  async function run(args: { json?: boolean; fix?: boolean }, qdrant: ReturnType<typeof fakeQdrant>): Promise<string> {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { runFootprintDoctor } = await import("../../../src/cli/commands/doctor-footprints.js");
      await runFootprintDoctor(args, { qdrant: qdrant as never });
      return stdout.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stdout.mockRestore();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-doc-fp-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    process.env.TEA_RAGS_DATA_DIR = dir;
    vi.stubEnv("NO_COLOR", "1");
    record("code_live", repo);
    record("code_dead", "");
    file("codegraph", "code_live_v1.duckdb");
    file("codegraph", "code_live_v2.duckdb");
    file("codegraph", "code_ghost_v3.duckdb");
    file("snapshots", "code_live", "meta.json");
    file("snapshots", "code_old.stats.json");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every unused footprint as a table and removes nothing without --fix", async () => {
    const qdrant = fakeQdrant();

    const out = await run({}, qdrant);

    expect(out).toMatch(/class\s+physical\s+logical\s+chunks\s+size\s+reason/);
    expect(out).toMatch(/orphan-generation\s+code_live_v1\s+code_live\s+7\s/);
    expect(out).toMatch(/dead-registration\s+code_dead_v1\s+code_dead\s+120\s/);
    expect(out).toMatch(/unregistered-alias\s+code_stray_v1\s+code_stray\s/);
    expect(out).toMatch(/orphan-codegraph\s+code_ghost_v3\s+code_ghost\s+-\s/);
    expect(out).toMatch(/store-leftover\s+-\s+code_old\s+-\s/);
    expect(out).not.toMatch(/^\S+\s+code_live_v2\s/m);
    expect(out).toContain("Dry run — nothing removed. Re-run 'tea-rags doctor --footprints --fix'");
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "codegraph", "code_ghost_v3.duckdb"))).toBe(true);
    expect(existsSync(join(dir, "snapshots", "code_old.stats.json"))).toBe(true);
  });

  it("emits the findings as JSON", async () => {
    const parsed = JSON.parse(await run({ json: true }, fakeQdrant()));

    expect(parsed.fixed).toBe(false);
    expect(parsed.findings.map((f: { findingClass: string }) => f.findingClass).sort()).toEqual([
      "dead-registration",
      "orphan-codegraph",
      "orphan-generation",
      "store-leftover",
      "unregistered-alias",
    ]);
  });

  it("--fix purges every finding and the live project survives untouched", async () => {
    const qdrant = fakeQdrant();

    const out = await run({ fix: true }, qdrant);

    expect([...qdrant.live]).toEqual(["code_live_v2"]);
    expect(qdrant.aliasList).toEqual([{ aliasName: "code_live", collectionName: "code_live_v2" }]);
    expect(existsSync(join(dir, "codegraph", "code_live_v2.duckdb"))).toBe(true);
    expect(existsSync(join(dir, "snapshots", "code_live", "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "codegraph", "code_live_v1.duckdb"))).toBe(false);
    expect(existsSync(join(dir, "codegraph", "code_ghost_v3.duckdb"))).toBe(false);
    expect(existsSync(join(dir, "snapshots", "code_old.stats.json"))).toBe(false);
    expect(new CollectionRegistry(dir).list().map((e) => e.collectionName)).toEqual(["code_live"]);
    expect(out).toContain("Purged 5 · kept 0 · failed 0");
  });

  it("--fix leaves a finding whose collection is in use", async () => {
    mkdirSync(join(dir, "working-tree", "code_stray"), { recursive: true });
    const qdrant = fakeQdrant();

    const out = await run({ fix: true }, qdrant);

    expect(qdrant.live.has("code_stray_v1")).toBe(true);
    expect(out).toMatch(/unregistered-alias\s+code_stray_v1\s+code_stray\s.*kept — in use: working-tree overlay/);
    expect(out).toContain("Purged 4 · kept 1 · failed 0");
  });

  it("reads a store entry's logical name past dots inside the name", async () => {
    file("snapshots", "code.old.stats.json");
    file("snapshots", "code.dir", "meta.json");

    const parsed = JSON.parse(await run({ json: true }, fakeQdrant()));

    const leftovers = parsed.findings
      .filter((f: { findingClass: string }) => f.findingClass === "store-leftover")
      .map((f: { logicalName: string }) => f.logicalName)
      .sort();
    expect(leftovers).toEqual(["code.dir", "code.old", "code_old"]);
  });

  it("groups temp entries and the recovery marker under their collection", async () => {
    mkdirSync(join(dir, "snapshots", "code_old.tmp.1772810315425"));
    file("snapshots", "code_old.json.tmp.1772810315425.k3j2h1x");
    file("snapshots", "code_old.recovery-complete");

    const parsed = JSON.parse(await run({ json: true }, fakeQdrant()));

    const leftovers = parsed.findings
      .filter((f: { findingClass: string }) => f.findingClass === "store-leftover")
      .map((f: { logicalName: string }) => f.logicalName);
    expect(leftovers).toEqual(["code_old"]);
  });

  it("--fix clears every store file of a leftover, temp entries and recovery marker included", async () => {
    mkdirSync(join(dir, "snapshots", "code_old.tmp.1772810315425"));
    file("snapshots", "code_old.json.tmp.1772810315425.k3j2h1x");
    file("snapshots", "code_old.recovery-complete");

    const out = await run({ fix: true }, fakeQdrant());

    expect(readdirSync(join(dir, "snapshots")).filter((n) => n.startsWith("code_old"))).toEqual([]);
    expect(out).toMatch(/store-leftover\s+-\s+code_old\s.*purged/);
  });

  it("--fix does not call a row purged while a file of its collection remains", async () => {
    file("snapshots", "code_old.unknown-store");

    const out = await run({ fix: true }, fakeQdrant());

    expect(existsSync(join(dir, "snapshots", "code_old.unknown-store"))).toBe(true);
    expect(out).toMatch(/store-leftover\s+-\s+code_old\s.*failed — left 1 file\(s\): code_old\.unknown-store/);
    expect(out).toContain("Purged 4 · kept 0 · failed 1");
  });

  it("--fix clears store leftovers in one batch with a running count, not a Qdrant round-trip each", async () => {
    for (let i = 0; i < 1200; i++) writeFileSync(join(dir, "snapshots", `code_l${i}.json`), "{}");
    const qdrant = fakeQdrant();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let progress: string;
    try {
      const out = await run({ fix: true }, qdrant);
      progress = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("Purged 1205 · kept 0 · failed 0");
    } finally {
      stderr.mockRestore();
    }

    expect(existsSync(join(dir, "snapshots", "code_l0.json"))).toBe(false);
    expect(existsSync(join(dir, "snapshots", "code_l1199.json"))).toBe(false);
    expect(existsSync(join(dir, "snapshots", "code_live", "meta.json"))).toBe(true);
    expect(qdrant.listCollections.mock.calls.length).toBeLessThan(15);
    expect(progress).toContain("store leftovers: 1000/1201");
    expect(progress).toContain("store leftovers: 1201/1201");
    expect(progress.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("doctor command routing to --footprints", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/cli/commands/doctor-footprints.js");
    vi.resetModules();
  });

  it.each([
    [{ footprints: true }, { json: false, fix: false }],
    [
      { footprints: true, fix: true, json: true },
      { json: true, fix: true },
    ],
  ])("routes %o to runFootprintDoctor", async (flags, expected) => {
    const runFootprintDoctor = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("../../../src/cli/commands/doctor-footprints.js", () => ({ runFootprintDoctor }));
    const { doctorCommand } = await import("../../../src/cli/commands/doctor.js");

    await doctorCommand.handler({ json: false, ...flags, _: [], $0: "tea-rags" });

    expect(runFootprintDoctor).toHaveBeenCalledWith(expected);
  });

  it("declares --footprints and --fix as boolean options", async () => {
    const { doctorCommand } = await import("../../../src/cli/commands/doctor.js");
    const argv = await (doctorCommand.builder as (y: ReturnType<typeof yargs>) => ReturnType<typeof yargs>)(
      yargs(["--footprints", "--fix"]),
    ).parseAsync();

    expect(argv.footprints).toBe(true);
    expect(argv.fix).toBe(true);
  });
});

describe("doctor --footprints without injected deps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-doc-fp-default-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    vi.doUnmock("../../../src/bootstrap/config/index.js");
    vi.doUnmock("../../../src/core/adapters/qdrant/embedded/daemon.js");
    vi.doUnmock("../../../src/core/adapters/qdrant/client.js");
    vi.resetModules();
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds its Qdrant client from the app config", async () => {
    const { resolveRegistryEnvCodeDefaults } =
      await import("../../../src/bootstrap/config/registry-env-code-defaults.js");
    const constructed: string[] = [];
    vi.resetModules();
    vi.doMock("../../../src/bootstrap/config/index.js", () => ({
      parseAppConfig: () => ({ qdrantUrl: "http://stub", qdrantApiKey: undefined, paths: { appData: dir } }),
      resolveRegistryEnvCodeDefaults,
    }));
    vi.doMock("../../../src/core/adapters/qdrant/embedded/daemon.js", () => ({
      resolveQdrantUrl: async () => ({ mode: "external", url: "http://resolved" }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/client.js", () => ({
      QdrantManager: class {
        constructor(url: string) {
          constructed.push(url);
        }
        listCollections = vi.fn(async () => []);
        aliases = { listAliases: vi.fn(async () => []) };
        getPoint = vi.fn(async () => null);
        countPoints = vi.fn(async () => 0);
      },
    }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { runFootprintDoctor } = await import("../../../src/cli/commands/doctor-footprints.js");
      await runFootprintDoctor({});
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("(no unused collection footprints)");
    } finally {
      stdout.mockRestore();
    }
    expect(constructed).toEqual(["http://resolved"]);
  });
});
