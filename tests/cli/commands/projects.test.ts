import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectsCommand, runInfo, runList, runRegister, runUnregister } from "../../../src/cli/commands/projects.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI 'projects' command group", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-proj-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as (code?: number) => never);
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
        await runOrphans({ json: false }, fakeQdrant as never);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("code_orphan_1");
        expect(out).toContain("code_orphan_2");
        expect(out).not.toContain("code_known");
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
        await runOrphans({ json: false }, fakeQdrant as never);
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
        await runOrphans({ json: true }, fakeQdrant as never);
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
        await runOrphans({ json: false }, fakeQdrant as never);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/^code_broken\t0$/m);
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
        await runOrphans({ json: false }, fakeQdrant as never);

        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        // Aliased-to physical must be hidden.
        expect(out).not.toContain("code_aliased_v3");
        // Genuine orphan still listed.
        expect(out).toContain("code_truly_orphan");
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
        await runOrphans({ json: false }, fakeQdrant as never);
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
    it("--purge calls qdrant.deleteCollection on the removed entry", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_purgeme",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 99,
        });
        reg.setName("code_purgeme", "victim");
        const deleteCollection = vi.fn().mockResolvedValue(undefined);
        const countPoints = vi.fn().mockResolvedValue(99);
        const fakeQdrant = { deleteCollection, countPoints } as never;
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "victim", purge: true }, fakeQdrant);
        expect(deleteCollection).toHaveBeenCalledWith("code_purgeme");
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("Removed 'victim'");
        expect(out).toContain("code_purgeme");
        expect(out.toLowerCase()).toContain("deleted");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--purge still completes when qdrant.deleteCollection rejects", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const reg = new CollectionRegistry(dir);
        reg.record({
          collectionName: "code_qfail",
          path: repo,
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "http://q",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 5,
        });
        reg.setName("code_qfail", "qfail");
        const deleteCollection = vi.fn().mockRejectedValue(new Error("network down"));
        const countPoints = vi.fn().mockResolvedValue(5);
        const fakeQdrant = { deleteCollection, countPoints } as never;
        const { runUnregister } = await import("../../../src/cli/commands/projects.js");
        await runUnregister({ name: "qfail", purge: true }, fakeQdrant);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("Removed 'qfail' from registry");
        expect(out.toLowerCase()).toContain("failed to delete");
        expect(out).toContain("network down");
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
});
