import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { projectCommand, runProjectExist, type ProjectExistArgs } from "../../../src/cli/commands/project.js";
import {
  createGitWorkingTreeFixture,
  prebuildGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../core/__helpers__/git-working-tree-fixture.js";

describe("CLI 'project exist' command", () => {
  let dataDir: string;
  let projectPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tr-data-"));
    projectPath = mkdtempSync(join(tmpdir(), "tr-proj-"));
    writeFileSync(
      join(dataDir, "registry.json"),
      JSON.stringify({
        version: 1,
        collections: {
          code_abc123: {
            collectionName: "code_abc123",
            path: projectPath,
            name: "demo",
            embeddingModel: "m",
            embeddingDimensions: 768,
            qdrantUrl: "http://h",
            indexedAt: "t",
            teaRagsVersion: "1",
            chunksCount: 0,
          },
        },
      }),
    );
    process.env.TEA_RAGS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  describe("--path lookup", () => {
    it("exits 0 for a registered path", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      try {
        expect(() => {
          runProjectExist({ path: projectPath });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        exit.mockRestore();
      }
    });

    it("exits 1 for an unregistered path", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      try {
        expect(() => {
          runProjectExist({ path: "/no/such/path" });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    });

    it("prints the alias with --print-name on match", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(() => {
          runProjectExist({ path: projectPath, printName: true });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(0);
        expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toBe("demo\n");
      } finally {
        exit.mockRestore();
        stdout.mockRestore();
      }
    });

    it("prints nothing and exits 1 with --print-name on no match", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(() => {
          runProjectExist({ path: "/no/such/path", printName: true });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(1);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        stdout.mockRestore();
      }
    });
  });

  describe("--name lookup", () => {
    it("exits 0 for a registered name", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      try {
        expect(() => {
          runProjectExist({ name: "demo" });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        exit.mockRestore();
      }
    });

    it("exits 1 for an unregistered name", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      try {
        expect(() => {
          runProjectExist({ name: "ghost" });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    });
  });

  it("projectCommand top-level handler is a no-op", () => {
    const result = projectCommand.handler({ _: [], $0: "tea-rags" });
    expect(result).toBeUndefined();
  });

  describe("yargs builder/handler wiring", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    function makeCli(): ReturnType<typeof yargs> {
      return yargs([]).command(projectCommand).exitProcess(false);
    }

    it("exist subcommand builder+handler invokes runProjectExist on registered path", async () => {
      let caught: unknown;
      try {
        await makeCli().parseAsync(["project", "exist", "--path", projectPath]);
      } catch (e) {
        caught = e;
      }
      // handler calls process.exit(0) which throws via our stub
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(caught).toBeDefined();
    });

    it("exist subcommand builder+handler exits 1 for unregistered path", async () => {
      let caught: unknown;
      try {
        await makeCli().parseAsync(["project", "exist", "--path", "/no/such/path"]);
      } catch (e) {
        caught = e;
      }
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(caught).toBeDefined();
    });

    it("exist subcommand .check() throws when neither --path nor --name provided", async () => {
      let caught: unknown;
      try {
        await makeCli().parseAsync(["project", "exist"]);
      } catch (e) {
        caught = e;
      }
      // yargs validation error from .check() — either caught or process.exit(1) called
      const checkFailed = caught !== undefined || exitSpy.mock.calls.length > 0;
      expect(checkFailed).toBe(true);
    });
  });

  describe("--json output", () => {
    it("emits {exists:true,name:'demo'} on match", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(() => {
          runProjectExist({ path: projectPath, json: true });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(0);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(JSON.parse(out)).toEqual({ exists: true, name: "demo" });
      } finally {
        exit.mockRestore();
        stdout.mockRestore();
      }
    });

    it("emits {exists:false,name:null} on no match", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(() => {
          runProjectExist({ path: "/no/such/path", json: true });
        }).toThrow("process.exit called");
        expect(exit).toHaveBeenCalledWith(1);
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(JSON.parse(out)).toEqual({ exists: false, name: null });
      } finally {
        exit.mockRestore();
        stdout.mockRestore();
      }
    });
  });
});

/**
 * `project exist --repository` (bd tea-rags-mcp-4nqf5): the server's
 * path-only rule — any registered entry of the same git repository answers,
 * so a subdirectory or a linked worktree learns the repository's alias.
 */
describe("CLI 'project exist --repository'", { timeout: 60_000 }, () => {
  const SEED = [
    { commit: { "src/keep.ts": "export const keep = 1;\n" }, message: "A" },
    { addWorktree: "feature" },
  ] satisfies readonly GitWorkingTreeSeedStep[];

  let fixture: GitWorkingTreeFixture;
  let dataDir: string;

  const register = (entries: Record<string, { path: string; name: string }>): void => {
    const collections = Object.fromEntries(
      Object.entries(entries).map(([collectionName, { path, name }]) => [
        collectionName,
        {
          collectionName,
          path,
          name,
          embeddingModel: "m",
          embeddingDimensions: 768,
          qdrantUrl: "http://h",
          indexedAt: "t",
          teaRagsVersion: "1",
          chunksCount: 0,
        },
      ]),
    );
    writeFileSync(join(dataDir, "registry.json"), JSON.stringify({ version: 1, collections }));
  };

  const run = (args: ProjectExistArgs): { code: unknown; out: string } => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(() => {
        runProjectExist(args);
      }).toThrow("process.exit called");
      return { code: exit.mock.calls[0]?.[0], out: stdout.mock.calls.map((c) => String(c[0])).join("") };
    } finally {
      exit.mockRestore();
      stdout.mockRestore();
    }
  };

  beforeAll(() => {
    prebuildGitWorkingTreeFixture(SEED);
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture(SEED);
    dataDir = mkdtempSync(join(tmpdir(), "tr-data-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    register({ code_repo: { path: fixture.mainRoot, name: "repo" } });
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    fixture.cleanup();
  });

  it("prints the repository's alias for a subdirectory of the registered checkout", () => {
    const sub = join(fixture.mainRoot, "src");
    mkdirSync(sub, { recursive: true });

    expect(run({ path: sub, repository: true, printName: true })).toEqual({ code: 0, out: "repo\n" });
  });

  it("prints the base repository's alias for a linked worktree", () => {
    const tree = fixture.seeded.worktrees.feature;

    expect(run({ path: tree, repository: true, printName: true })).toEqual({ code: 0, out: "repo\n" });
  });

  it("wires --repository through the yargs command", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const argv = ["project", "exist", "--path", fixture.seeded.worktrees.feature, "--repository", "--print-name"];
      let caught: unknown;
      try {
        await yargs([]).command(projectCommand).exitProcess(false).parseAsync(argv);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(exit).toHaveBeenCalledWith(0);
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toBe("repo\n");
    } finally {
      exit.mockRestore();
      stdout.mockRestore();
    }
  });

  it("keeps the exact-path match without --repository", () => {
    const tree = fixture.seeded.worktrees.feature;

    expect(run({ path: tree, printName: true })).toEqual({ code: 1, out: "" });
  });

  it("prints nothing and exits 1 for a path outside any registered repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "tr-outside-"));
    try {
      expect(run({ path: outside, repository: true, printName: true })).toEqual({ code: 1, out: "" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("prints nothing and exits 1 when the repository is indexed under several projects", () => {
    register({
      code_repo: { path: fixture.mainRoot, name: "repo" },
      code_twin: { path: fixture.mainRoot, name: "twin" },
    });

    expect(run({ path: fixture.seeded.worktrees.feature, repository: true, printName: true })).toEqual({
      code: 1,
      out: "",
    });
  });
});
