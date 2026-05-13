import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

    it("prints tab-separated name/collection/path when entries exist", async () => {
      await runRegister({ path: repo, name: "alpha" });
      const calls: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        calls.push(String(c));
        return true;
      });
      try {
        runList({});
        const out = calls.join("");
        expect(out).toMatch(/^alpha\t/m);
        expect(out).toContain(realpathSync(repo));
      } finally {
        stdout.mockRestore();
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
});
