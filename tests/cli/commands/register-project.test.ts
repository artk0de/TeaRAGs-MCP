import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerProjectCommand } from "../../../src/cli/commands/register-project.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI register-project", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rp-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a registry entry with the given name", async () => {
    await (registerProjectCommand.handler as (a: object) => Promise<void>)({
      path: repo,
      name: "alpha",
      _: [],
      $0: "",
    });
    const r = new CollectionRegistry(dir);
    expect(r.findByName("alpha")?.path).toBe(realpathSync(repo));
  });

  it("exits with code 1 when path does not exist", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as (code?: number) => never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        (registerProjectCommand.handler as (a: object) => Promise<void>)({
          path: join(dir, "missing"),
          name: "ghost",
          _: [],
          $0: "",
        }),
      ).rejects.toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("exits with code 1 when name does not match regex", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as (code?: number) => never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        (registerProjectCommand.handler as (a: object) => Promise<void>)({
          path: repo,
          name: "BAD NAME!",
          _: [],
          $0: "",
        }),
      ).rejects.toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
