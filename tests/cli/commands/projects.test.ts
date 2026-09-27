import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectsCommand, runInfo, runList, runRegister, runUnregister } from "../../../src/cli/commands/projects.js";
import { createColorizer } from "../../../src/cli/infra/color.js";
import { SERVICE_POINT_TYPES } from "../../../src/core/adapters/qdrant/service-points.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";
import { resolveCollectionName } from "../../../src/core/infra/collection-name.js";

describe("CLI 'projects' command group", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-proj-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
    // Layout assertions read plain text: force color off regardless of the
    // developer's terminal (FORCE_COLOR in the shell would otherwise leak in).
    vi.stubEnv("NO_COLOR", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("colored status lines", () => {
    const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });

    beforeEach(() => {
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", "1");
      vi.stubEnv("COLORFGBG", undefined);
    });

    function captureStdout(): { out: () => string; restore: () => void } {
      const calls: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        calls.push(String(chunk));
        return true;
      });
      return {
        out: () => calls.join(""),
        restore: () => {
          spy.mockRestore();
        },
      };
    }

    it("paints a successful registration as ok", async () => {
      const cap = captureStdout();
      try {
        await runRegister({ path: repo, name: "alpha" });
        expect(cap.out()).toContain(colored.ok("Registered 'alpha'"));
      } finally {
        cap.restore();
      }
    });

    it("paints an unknown name on unregister as a warning", async () => {
      const cap = captureStdout();
      try {
        await runUnregister({ name: "ghost" });
        expect(cap.out()).toBe(`${colored.warn("'ghost' was not registered")}\n`);
      } finally {
        cap.restore();
      }
    });

    it("paints the removal as ok and the leftover-collection note as a warning", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const cap = captureStdout();
      try {
        await runUnregister({ name: "alpha" });
        expect(cap.out()).toContain(colored.ok("Removed 'alpha' from registry."));
        // The note runs to the end of the line, so match the warn escape's opening half.
        const warnOpen = colored.warn("").replace("\x1b[0m", "");
        expect(cap.out()).toContain(`${warnOpen}Note: Qdrant collection`);
      } finally {
        cap.restore();
      }
    });

    it("renders info through the colored key: value block", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const cap = captureStdout();
      try {
        runInfo({ name: "alpha" });
        expect(cap.out()).toContain(colored.bold(colored.brand("alpha")));
        expect(cap.out()).toContain(colored.dim("collectionName:     "));
      } finally {
        cap.restore();
      }
    });
  });

  describe("register", () => {
    it("writes a registry entry with the given name", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runRegister({ path: repo, name: "alpha" });
        const r = new CollectionRegistry(dir);
        expect(r.findByName("alpha")?.path).toBe(realpathSync(repo));
        expect(stdout).toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
      }
    });

    it("exits with code 1 when path does not exist", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(runRegister({ path: join(dir, "missing"), name: "ghost" })).rejects.toThrow("exit");
        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr).toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
    });

    it("exits with code 1 when name violates regex", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(runRegister({ path: repo, name: "BAD NAME!" })).rejects.toThrow("exit");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
    });
  });

  describe("list", () => {
    it("prints '(no projects registered)' when registry empty", () => {
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runList({});
        expect(calls.join("")).toMatch(/no projects registered/);
      } finally {
        stdout.mockRestore();
      }
    });

    it("prints an aligned table with a header and the entry name", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runList({});
        const out = calls.join("");
        expect(out).toMatch(/NAME/);
        expect(out).toMatch(/CHUNKS/);
        expect(out).toMatch(/QDRANT/);
        expect(out).toContain("alpha");
      } finally {
        stdout.mockRestore();
      }
    });

    it("emits no ANSI escape codes when NO_COLOR is set", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const savedNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runList({});
        expect(calls.join("")).not.toContain("\x1b");
      } finally {
        stdout.mockRestore();
        if (savedNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = savedNoColor;
      }
    });

    it("emits JSON array when --json", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runList({ json: true });
        const parsed = JSON.parse(calls.join("")) as { name: string }[];
        expect(parsed).toHaveLength(1);
        expect(parsed[0].name).toBe("alpha");
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe("unregister", () => {
    it("removes a registered project by name", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runUnregister({ name: "alpha" });
        const r = new CollectionRegistry(dir);
        expect(r.findByName("alpha")).toBeNull();
      } finally {
        stdout.mockRestore();
      }
    });

    it("reports 'was not registered' for unknown name (no error)", async () => {
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        await runUnregister({ name: "ghost" });
        expect(calls.join("")).toMatch(/'ghost' was not registered/);
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe("info", () => {
    it("prints full entry details by name", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runInfo({ name: "alpha" });
        const out = calls.join("");
        expect(out).toMatch(/^name: +alpha$/m);
        expect(out).toMatch(/^collectionName: +code_/m);
        expect(out).toContain(realpathSync(repo));
      } finally {
        stdout.mockRestore();
      }
    });

    it("emits full JSON when --json", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runInfo({ name: "alpha", json: true });
        const parsed = JSON.parse(calls.join("")) as { name: string; collectionName: string };
        expect(parsed.name).toBe("alpha");
        expect(parsed.collectionName).toMatch(/^code_/);
      } finally {
        stdout.mockRestore();
      }
    });

    it("exits with code 1 for unknown name", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(() => {
          runInfo({ name: "ghost" });
        }).toThrow("exit");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
    });
  });

  describe("command shape", () => {
    it("declares command 'projects'", () => {
      expect(projectsCommand.command).toBe("projects");
    });

    it("describe text mentions subcommand names", () => {
      expect(String(projectsCommand.describe)).toMatch(/register/i);
      expect(String(projectsCommand.describe)).toMatch(/list/i);
      expect(String(projectsCommand.describe)).toMatch(/unregister/i);
      expect(String(projectsCommand.describe)).toMatch(/info/i);
    });
  });

  describe("orphans (audit #8 listing half)", () => {
    it("lists Qdrant collections not present in the registry", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_known",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_known", "code_orphan_1", "code_orphan_2"]),
          countPoints: vi.fn().mockResolvedValue(123),
        };
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: false }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("code_orphan_1");
        expect(out).toContain("code_orphan_2");
        expect(out).not.toContain("code_known");
        expect(out).toMatch(/^COLLECTION +CHUNKS$/m);
        expect(out).toMatch(/^code_orphan_1 +123$/m);
      } finally {
        stdout.mockRestore();
      }
    });

    it("prints '(no orphan collections)' when registry matches Qdrant", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_known",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_known"]),
          countPoints: vi.fn().mockResolvedValue(0),
        };
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: false }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("(no orphan collections)");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--json emits a structured array", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
          countPoints: vi.fn().mockResolvedValue(99),
        };
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: true }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        const parsed = JSON.parse(out.trim());
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.map((e: { collectionName: string }) => e.collectionName).sort()).toEqual(["code_a", "code_b"]);
      } finally {
        stdout.mockRestore();
      }
    });

    it("reports 0 chunks when countPoints throws (safeCount catch branch)", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_broken"]),
          countPoints: vi.fn().mockRejectedValue(new Error("boom")),
        };
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: false }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/^code_broken +0$/m);
      } finally {
        stdout.mockRestore();
      }
    });

    it("excludes aliased physical collections from the orphan list", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        // Registry has the alias name.
        reg.record({
          collectionName: "code_aliased",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_aliased", "live-project");

        const fakeQdrant = {
          // Qdrant returns the physical name + a truly orphan one.
          listCollections: vi.fn().mockResolvedValue([
            "code_aliased_v3", // physical backing of the alias
            "code_truly_orphan", // genuine orphan
          ]),
          // The alias mapping says code_aliased points at code_aliased_v3.
          aliases: {
            listAliases: vi.fn().mockResolvedValue([{ aliasName: "code_aliased", collectionName: "code_aliased_v3" }]),
          },
          countPoints: vi.fn().mockResolvedValue(100),
        };

        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: false }, fakeQdrant);

        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        // Aliased-to physical must be hidden.
        expect(out).not.toContain("code_aliased_v3");
        // Genuine orphan still listed.
        expect(out).toContain("code_truly_orphan");
      } finally {
        stdout.mockRestore();
      }
    });

    // bd tea-rags-mcp-9ovlp — during the taxdome --force run code_27622aef_v14 was
    // listed as an orphan; acting on that mid-run deletes the build. The same
    // lease cleanupOrphanedVersions honours (nrylk) decides here.
    it("hides a collection an in-flight force run is building and still lists a dead build", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const now = new Date().toISOString();
        const long = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const markers: Record<string, Record<string, unknown>> = {
          code_x_v14: { indexingComplete: false, startedAt: now, lastHeartbeat: now },
          code_dead_v3: { indexingComplete: false, startedAt: long, lastHeartbeat: long },
        };
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_x_v14", "code_dead_v3"]),
          aliases: { listAliases: vi.fn().mockResolvedValue([]) },
          countPoints: vi.fn().mockResolvedValue(7),
          getPoint: vi.fn(async (collection: string) =>
            Promise.resolve(markers[collection] ? { payload: markers[collection] } : null),
          ),
        };

        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: true }, fakeQdrant as never);

        const parsed = JSON.parse(
          stdout.mock.calls
            .map((c) => String(c[0]))
            .join("")
            .trim(),
        ) as {
          collectionName: string;
        }[];
        expect(parsed.map((row) => row.collectionName)).toEqual(["code_dead_v3"]);
      } finally {
        stdout.mockRestore();
      }
    });

    it("falls back gracefully when listAliases is missing or throws", async () => {
      // Defensive — if the Qdrant client doesn't expose aliases (e.g. older
      // server), orphans should still work, just including all physical names.
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const fakeQdrant = {
          listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
          aliases: {
            listAliases: vi.fn().mockRejectedValue(new Error("not supported")),
          },
          countPoints: vi.fn().mockResolvedValue(0),
        };
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: false }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        // Without alias info, both appear (best-effort fallback).
        expect(out).toContain("code_a");
        expect(out).toContain("code_b");
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe("unregister --purge (audit #8 purge half) + verbose hint (audit #12)", () => {
    /**
     * `--purge` now removes the WHOLE per-collection footprint, so the fake has
     * to answer the enumeration the purge runs: which physical generations
     * exist, and what the alias resolves to.
     */
    function purgeQdrant(collections: string[], aliases: { aliasName: string; collectionName: string }[] = []) {
      const live = new Set(collections);
      const aliasList = [...aliases];
      return {
        live,
        listCollections: vi.fn(async () => [...live]),
        deleteCollection: vi.fn(async (name: string) => {
          live.delete(name);
        }),
        countPoints: vi.fn(async () => 99),
        aliases: {
          listAliases: vi.fn(async () => [...aliasList]),
          deleteAlias: vi.fn(async (name: string) => {
            const i = aliasList.findIndex((a) => a.aliasName === name);
            if (i >= 0) aliasList.splice(i, 1);
          }),
        },
      };
    }

    function record(collectionName: string, alias: string, chunksCount = 99): CollectionRegistry {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName,
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount,
      });
      reg.setName(collectionName, alias);
      return reg;
    }

    it("--purge calls qdrant.deleteCollection on the removed entry", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_purgeme", "victim");
        const fakeQdrant = purgeQdrant(["code_purgeme"]);
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "victim", purge: true }, fakeQdrant as never);
        expect(fakeQdrant.deleteCollection).toHaveBeenCalledWith("code_purgeme");
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("Removed 'victim'");
        expect(out).toContain("code_purgeme");
        expect(out.toLowerCase()).toContain("deleted");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge deletes every _vN generation, not just the alias name", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_gen", "gen");
        const fakeQdrant = purgeQdrant(
          ["code_gen_v1", "code_gen_v2", "code_other_v1"],
          [{ aliasName: "code_gen", collectionName: "code_gen_v2" }],
        );
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "gen", purge: true }, fakeQdrant as never);
        expect([...fakeQdrant.live]).toEqual(["code_other_v1"]);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("code_gen_v1");
        expect(out).toContain("code_gen_v2");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge removes the stats cache and snapshot that live outside Qdrant", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_files", "files");
        const snapshots = join(dir, "snapshots");
        mkdirSync(snapshots, { recursive: true });
        const statsFile = join(snapshots, "code_files.stats.json");
        writeFileSync(statsFile, '{"version":6,"collectionName":"code_files"}');
        const quarantineFile = join(snapshots, "code_files.quarantine.json");
        writeFileSync(quarantineFile, '{"version":1,"updatedAt":"2026-01-01","files":{}}');

        const fakeQdrant = purgeQdrant(["code_files"]);
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "files", purge: true }, fakeQdrant as never);

        expect(existsSync(statsFile)).toBe(false);
        expect(existsSync(quarantineFile)).toBe(false);
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge removes the codegraph DuckDB generations and their WAL sidecars", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_cg", "cg");
        const codegraphDir = join(dir, "codegraph");
        mkdirSync(codegraphDir, { recursive: true });
        for (const name of ["code_cg", "code_cg_v1", "code_cg_v2"]) {
          writeFileSync(join(codegraphDir, `${name}.duckdb`), "db");
          writeFileSync(join(codegraphDir, `${name}.duckdb.wal`), "wal");
        }
        writeFileSync(join(codegraphDir, "code_other_v1.duckdb"), "db");

        const fakeQdrant = purgeQdrant(["code_cg_v2"], [{ aliasName: "code_cg", collectionName: "code_cg_v2" }]);
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "cg", purge: true }, fakeQdrant as never);

        expect(readdirSync(codegraphDir).sort()).toEqual(["code_other_v1.duckdb"]);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("codegraph");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge still completes when qdrant.deleteCollection rejects", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_qfail", "qfail", 5);
        const fakeQdrant = purgeQdrant(["code_qfail"]);
        fakeQdrant.deleteCollection.mockRejectedValue(new Error("network down"));
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "qfail", purge: true }, fakeQdrant as never);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("Removed 'qfail' from registry");
        expect(out.toLowerCase()).toContain("failed to delete");
        expect(out).toContain("network down");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge clears the on-disk stores even when Qdrant is unreachable", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_down", "down");
        const snapshots = join(dir, "snapshots");
        mkdirSync(snapshots, { recursive: true });
        const statsFile = join(snapshots, "code_down.stats.json");
        writeFileSync(statsFile, '{"version":6,"collectionName":"code_down"}');

        const fakeQdrant = purgeQdrant(["code_down"]);
        fakeQdrant.listCollections.mockRejectedValue(new Error("ECONNREFUSED"));
        fakeQdrant.deleteCollection.mockRejectedValue(new Error("ECONNREFUSED"));
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "down", purge: true }, fakeQdrant as never);

        expect(existsSync(statsFile)).toBe(false);
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge names the project directory it leaves alone", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        record("code_kept", "kept");
        const fakeQdrant = purgeQdrant(["code_kept"]);
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "kept", purge: true }, fakeQdrant as never);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out.toLowerCase()).toContain("kept");
        expect(out).toContain(repo);
        expect(existsSync(repo)).toBe(true);
      } finally {
        stdout.mockRestore();
      }
    });

    it("without --purge prints a hint that the Qdrant collection is still present", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_keep",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 5,
        });
        reg.setName("code_keep", "ghost");
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "ghost", purge: false });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("Removed 'ghost'");
        expect(out).toContain("code_keep");
        expect(out.toLowerCase()).toContain("still present");
        expect(out).toContain("--purge");
      } finally {
        stdout.mockRestore();
      }
    });

    it("unregister of a missing name reports it without trying to delete", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const deleteCollection = vi.fn();
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "ghost-missing", purge: true }, { deleteCollection } as never);
        expect(deleteCollection).not.toHaveBeenCalled();
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("was not registered");
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe("unregister --path (bd tea-rags-mcp-usbb5)", () => {
    /** What `index-codebase <path>` leaves behind: an entry with a path and no alias. */
    function recordNameless(collectionName: string): string {
      const canonical = realpathSync(repo);
      new CollectionRegistry(dir).record({
        collectionName,
        path: canonical,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 7,
      });
      return canonical;
    }

    function captureStdout(): { out: () => string; restore: () => void } {
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      return {
        out: () => spy.mock.calls.map((c) => String(c[0])).join(""),
        restore: () => {
          spy.mockRestore();
        },
      };
    }

    it("removes a nameless entry and names it by its path, never 'undefined'", async () => {
      const canonical = recordNameless("code_nameless");
      const io = captureStdout();
      try {
        await runUnregister({ path: repo });
        expect(new CollectionRegistry(dir).get("code_nameless")).toBeNull();
        const out = io.out();
        expect(out).toContain(`Removed '${canonical}'`);
        expect(out).not.toContain("undefined");
        // Invariant changed (usbb5 follow-up): this fixture's collection is not
        // the one its path hashes to, so a `--path` hint would purge the wrong
        // (absent) collection. The hint must name what actually reaches it.
        expect(out).toContain("tea-rags projects unregister --collection code_nameless --purge");
        expect(out).not.toContain("--name");
      } finally {
        io.restore();
      }
    });

    // Invariant changed (usbb5 follow-up): the hint used to print `--name alpha
    // --purge`, which can never work — the name is gone once the entry is. The
    // hint now carries the path, which still derives the collection.
    it("hints a purge addressed by path for a named entry, since the name is gone", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const io = captureStdout();
      try {
        await runUnregister({ path: repo });
        const out = io.out();
        expect(out).toContain("Removed 'alpha'");
        expect(out).toContain(`tea-rags projects unregister --path ${realpathSync(repo)} --purge`);
        expect(out).not.toContain("--name alpha");
      } finally {
        io.restore();
      }
    });

    it("--purge tears down the footprint of a nameless entry", async () => {
      const canonical = recordNameless("code_nameless");
      const live = new Set(["code_nameless", "code_other"]);
      const fakeQdrant = {
        listCollections: vi.fn(async () => [...live]),
        deleteCollection: vi.fn(async (name: string) => {
          live.delete(name);
        }),
        countPoints: vi.fn(async () => 7),
        aliases: { listAliases: vi.fn(async () => []), deleteAlias: vi.fn(async () => {}) },
      };
      const io = captureStdout();
      try {
        await runUnregister({ path: repo, purge: true }, fakeQdrant as never);
        expect(fakeQdrant.deleteCollection).toHaveBeenCalledWith("code_nameless");
        expect([...live]).toEqual(["code_other"]);
        const out = io.out();
        expect(out).toContain(`Removed '${canonical}' from registry; deleted Qdrant collection 'code_nameless'`);
        expect(out).not.toContain("undefined");
      } finally {
        io.restore();
      }
    });

    it("exits 1 with the typed error when called with both name and path", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(runUnregister({ name: "alpha", path: repo })).rejects.toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(
          /projects unregister failed: .*mutually exclusive/,
        );
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
    });

    it("reports an unclaimed path as not registered", async () => {
      const io = captureStdout();
      try {
        const nowhere = join(dir, "nowhere");
        await runUnregister({ path: nowhere });
        expect(io.out()).toContain(`'${nowhere}' was not registered`);
      } finally {
        io.restore();
      }
    });
  });

  describe("unregister hint → follow it with --purge (bd tea-rags-mcp-usbb5 follow-up)", () => {
    /** Qdrant fake answering the purge's enumeration; `live` shows what survived. */
    function purgeQdrant(collections: string[]) {
      const live = new Set(collections);
      return {
        live,
        listCollections: vi.fn(async () => [...live]),
        deleteCollection: vi.fn(async (name: string) => {
          live.delete(name);
        }),
        countPoints: vi.fn(async () => 4),
        aliases: { listAliases: vi.fn(async () => []), deleteAlias: vi.fn(async () => {}) },
      };
    }

    function seedCodegraph(collectionName: string): string {
      const codegraphDir = join(dir, "codegraph");
      mkdirSync(codegraphDir, { recursive: true });
      writeFileSync(join(codegraphDir, `${collectionName}_v1.duckdb`), "db");
      writeFileSync(join(codegraphDir, `${collectionName}_v1.duckdb.wal`), "wal");
      return codegraphDir;
    }

    function recordEntry(collectionName: string, name?: string): void {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName,
        path: realpathSync(repo),
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 4,
      });
      if (name) reg.setName(collectionName, name);
    }

    async function runRegisterQuiet(name: string): Promise<void> {
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runRegister({ path: repo, name });
      } finally {
        spy.mockRestore();
      }
    }

    /** The address the leftover-collection hint tells the user to purge by. */
    function hintedAddress(out: string): Record<string, string> {
      const match = /Run 'tea-rags projects unregister --(path|name|collection) (\S+) --purge'/.exec(out);
      expect(match, `no purge hint in: ${out}`).not.toBeNull();
      return { [match![1]]: match![2] };
    }

    async function unregisterThenFollowHint(
      first: { name?: string; path?: string },
      fake: ReturnType<typeof purgeQdrant>,
    ): Promise<string> {
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runUnregister(first);
        const hint = hintedAddress(spy.mock.calls.map((c) => String(c[0])).join(""));
        spy.mockClear();
        await runUnregister({ ...hint, purge: true }, fake as never);
        return spy.mock.calls.map((c) => String(c[0])).join("");
      } finally {
        spy.mockRestore();
      }
    }

    it("--path: following the hint removes the collection and the codegraph DBs", async () => {
      const collectionName = resolveCollectionName(realpathSync(repo));
      recordEntry(collectionName);
      const codegraphDir = seedCodegraph(collectionName);
      const fake = purgeQdrant([`${collectionName}_v1`, "code_other_v1"]);

      const out = await unregisterThenFollowHint({ path: repo }, fake);

      expect([...fake.live]).toEqual(["code_other_v1"]);
      expect(readdirSync(codegraphDir)).toEqual([]);
      expect(out).not.toContain("was not registered");
      expect(out).toContain(collectionName);
    });

    it("--name: following the hint removes the collection and the codegraph DBs", async () => {
      await runRegisterQuiet("alpha");
      const { collectionName } = new CollectionRegistry(dir).findByName("alpha")!;
      const codegraphDir = seedCodegraph(collectionName);
      const fake = purgeQdrant([`${collectionName}_v1`]);

      const out = await unregisterThenFollowHint({ name: "alpha" }, fake);

      expect([...fake.live]).toEqual([]);
      expect(readdirSync(codegraphDir)).toEqual([]);
      expect(out).not.toContain("was not registered");
    });

    it("an entry whose collection the path no longer derives is hinted by collection name", async () => {
      // A re-pointed alias keeps the collection it was indexed under.
      recordEntry("code_moved", "moved");
      const codegraphDir = seedCodegraph("code_moved");
      const fake = purgeQdrant(["code_moved_v1"]);

      const out = await unregisterThenFollowHint({ name: "moved" }, fake);

      expect([...fake.live]).toEqual([]);
      expect(readdirSync(codegraphDir)).toEqual([]);
      expect(out).toContain("code_moved");
    });

    it("--purge on an unregistered path with no footprint still answers 'was not registered'", async () => {
      const fake = purgeQdrant(["code_other_v1"]);
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runUnregister({ path: repo, purge: true }, fake as never);
        expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("was not registered");
        expect(fake.deleteCollection).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("never purges a generation of a collection that is still registered", async () => {
      recordEntry("code_live", "live");
      const fake = purgeQdrant(["code_live_v2"]);
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runUnregister({ collection: "code_live_v2", purge: true }, fake as never);
        expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("was not registered");
        expect(fake.deleteCollection).not.toHaveBeenCalled();
        expect(new CollectionRegistry(dir).findByName("live")).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("info — symlink/realpath mismatch (audit #13)", () => {
    it("text mode adds a realpath line + hint when path diverges from realpathSync", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const realDir = join(dir, "real");
        const linkDir = join(dir, "link");
        mkdirSync(realDir);
        writeFileSync(join(realDir, ".keep"), "");
        symlinkSync(realDir, linkDir);

        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_link",
          path: linkDir,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_link", "linky");
        runInfo({ name: "linky" });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain(`path:                ${linkDir}`);
        expect(out).toContain(`realpath:`);
        expect(out).toContain(realDir);
        expect(out.toLowerCase()).toContain("symlink");
      } finally {
        stdout.mockRestore();
      }
    });

    it("text mode omits the realpath line when stored path already equals realpathSync", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_direct",
          path: realpathSync(repo),
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_direct", "direct");
        runInfo({ name: "direct" });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).not.toContain("realpath:");
      } finally {
        stdout.mockRestore();
      }
    });

    it("text mode reports '(missing on disk)' when realpathSync throws", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_gone",
          path: join(dir, "nonexistent-subdir"),
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_gone", "gone");
        runInfo({ name: "gone" });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out.toLowerCase()).toContain("missing on disk");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--json includes realpath only when it differs from stored path", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const realDir = join(dir, "real-json");
        const linkDir = join(dir, "link-json");
        mkdirSync(realDir);
        writeFileSync(join(realDir, ".keep"), "");
        symlinkSync(realDir, linkDir);

        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_jsonlink",
          path: linkDir,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_jsonlink", "jsonlink");
        runInfo({ name: "jsonlink", json: true });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        const parsed = JSON.parse(out.trim());
        expect(parsed.path).toBe(linkDir);
        expect(parsed.realpath).toBe(realpathSync(linkDir));
      } finally {
        stdout.mockRestore();
      }
    });

    it("--json omits realpath when path already equals realpathSync", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_direct_json",
          path: realpathSync(repo),
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_direct_json", "directjson");
        runInfo({ name: "directjson", json: true });
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        const parsed = JSON.parse(out.trim());
        expect(parsed.realpath).toBeUndefined();
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe("chunk counts leave out service points (bd tea-rags-mcp-39xca.16)", () => {
    const CHUNK_POINTS = 5;

    /**
     * A collection holding CHUNK_POINTS chunks plus one point per service
     * `_type`. `countPoints` honors `must_not` `_type` matches the way Qdrant
     * does, so the reported number depends only on the filter the CLI passes.
     */
    function collectionWithServicePoints(collections: string[]) {
      const payloads: Record<string, unknown>[] = [
        ...SERVICE_POINT_TYPES.map((type) => ({ _type: type })),
        ...Array.from({ length: CHUNK_POINTS }, (_, i) => ({ relativePath: `src/f${i}.ts` })),
      ];
      const live = new Set(collections);
      return {
        listCollections: vi.fn(async () => [...live]),
        deleteCollection: vi.fn(async (name: string) => {
          live.delete(name);
        }),
        countPoints: vi.fn(async (_name: string, filter?: Record<string, unknown>) => {
          const mustNot = (filter?.must_not ?? []) as { key: string; match: { value: unknown } }[];
          return payloads.filter((p) => !mustNot.some((c) => p[c.key] === c.match.value)).length;
        }),
        aliases: { listAliases: vi.fn(async () => []), deleteAlias: vi.fn(async () => undefined) },
      };
    }

    it("orphans reports the chunk count, not the point count", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const { runOrphans } = await import("../../../src/cli/commands/projects.js");
        await runOrphans({ json: true }, collectionWithServicePoints(["code_orphan"]));
        const rows = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join("")) as {
          chunksCount: number;
        }[];
        expect(rows).toEqual([{ collectionName: "code_orphan", chunksCount: CHUNK_POINTS }]);
      } finally {
        stdout.mockRestore();
      }
    });

    it("unregister --purge reports the chunk count of the deleted collection", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_counted",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: CHUNK_POINTS,
        });
        reg.setName("code_counted", "counted");
        await runUnregister({ name: "counted", purge: true }, collectionWithServicePoints(["code_counted"]) as never);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain(`(${CHUNK_POINTS} chunks)`);
      } finally {
        stdout.mockRestore();
      }
    });
  });
});
