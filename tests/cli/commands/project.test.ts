import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { projectCommand, runProjectExist } from "../../../src/cli/commands/project.js";

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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
    const result = projectCommand.handler({ _: [], $0: "tea-rags" } as unknown as Parameters<
      typeof projectCommand.handler
    >[0]);
    expect(result).toBeUndefined();
  });

  describe("yargs builder/handler wiring", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as (code?: number) => never);
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
