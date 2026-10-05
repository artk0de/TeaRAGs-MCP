import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs, { type Arguments } from "yargs";

import { assertRegistryEnvValueParses } from "../../../src/bootstrap/config/parse.js";
import { resolveRegistryEnvCodeDefaults } from "../../../src/bootstrap/config/registry-env-code-defaults.js";
import { projectsCommand } from "../../../src/cli/commands/projects.js";

/**
 * These tests exercise the yargs `builder` closures and the top-level
 * `handler` of `projectsCommand` end-to-end via `parseAsync`. They cover
 * the subcommand arrow-functions (register/unregister/list/info/$0) which
 * are not reachable when calling the exported `run*` helpers directly.
 */
describe("projectsCommand yargs builder/handler wiring", () => {
  let dir: string;
  let repo: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-proj-builder-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;

    // Replace process.exit with a throwing stub so any unexpected exit
    // (yargs error path, unknown subcommand, validation failure) surfaces
    // as a test failure instead of killing the vitest worker.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Assertions read plain text: force color off regardless of the terminal.
    vi.stubEnv("NO_COLOR", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a fresh yargs instance wired with `projectsCommand` for each parse,
   * because yargs caches parsed state and re-using one instance across
   * different argv tails causes flaky parses.
   */
  function makeCli(): ReturnType<typeof yargs> {
    return yargs([])
      .command(projectsCommand)
      .exitProcess(false)
      .fail((msg, err) => {
        // Surface failures as exceptions so tests see them.
        throw err ?? new Error(msg);
      });
  }

  it("top-level handler is a no-op and returns undefined", () => {
    expect(typeof projectsCommand.handler).toBe("function");
    const stubArgs = { _: [], $0: "tea-rags" } as unknown as Arguments;
    // Should not throw and should not return a value.
    const result = projectsCommand.handler(stubArgs);
    expect(result).toBeUndefined();
  });

  it("register subcommand closure invokes runRegister", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/Registered 'alpha' -> code_/);
  });

  it("unregister subcommand closure invokes runUnregister", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "unregister", "--name", "alpha"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/Removed 'alpha'/);
  });

  it("unregister --path removes the entry the path registered (bd tea-rags-mcp-usbb5)", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "unregister", "--path", repo]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/Removed 'alpha'/);
  });

  // The `.fail` handler throws synchronously out of parseAsync, so the call is
  // wrapped in an async thunk to surface it as a rejection.
  it("unregister rejects --name together with --path", async () => {
    await expect(async () =>
      makeCli().parseAsync(["projects", "unregister", "--name", "alpha", "--path", repo]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("unregister rejects a call with neither --name nor --path", async () => {
    await expect(async () => makeCli().parseAsync(["projects", "unregister"])).rejects.toThrow(/--name or --path/);
  });

  it("unregister --collection removes the entry holding that collection", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    const registered = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    const collection = /-> (code_\w+)/.exec(registered)![1];
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "unregister", "--collection", collection]);
    expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toMatch(/Removed 'alpha'/);
  });

  it("unregister rejects --collection together with --name", async () => {
    await expect(async () =>
      makeCli().parseAsync(["projects", "unregister", "--name", "alpha", "--collection", "code_x"]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("list subcommand closure invokes runList", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "list"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/NAME/);
    expect(out).toContain("alpha");
  });

  it("info subcommand closure invokes runInfo", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "info", "--name", "alpha"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/^name: +alpha$/m);
    expect(out).toMatch(/^collectionName: +code_/m);
  });

  it("$0 default subcommand closure invokes runList when no subcommand given", async () => {
    // No subcommand after `projects` -> default $0 handler should run list.
    await makeCli().parseAsync(["projects"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/no projects registered/);
  });

  it("prune subcommand closure invokes runPrune, dry run by default", async () => {
    // No --purge: the sweep must not reach for Qdrant at all, so the closure
    // runs against the real (empty) registry without any stubbing.
    await makeCli().parseAsync(["projects", "prune"]);
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toMatch(/no stale registry entries/);
  });

  it("orphans subcommand closure invokes runOrphans via real defaultQdrant path", async () => {
    // Mock the modules dynamically imported inside defaultQdrant so the
    // yargs handler closure exercises the production wiring (parseAppConfig
    // + resolveQdrantUrl + new QdrantManager) without touching the network.
    vi.doMock("../../../src/bootstrap/config/index.js", () => ({
      parseAppConfig: () => ({ qdrantUrl: "http://stub", qdrantApiKey: undefined, paths: { appData: "/tmp/x" } }),
      assertRegistryEnvValueParses,
      resolveRegistryEnvCodeDefaults,
    }));
    vi.doMock("../../../src/core/adapters/qdrant/embedded/daemon.js", () => ({
      resolveQdrantUrl: async () => ({ mode: "external", url: "http://stub" }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/client.js", () => ({
      QdrantManager: class {
        listCollections = vi.fn().mockResolvedValue(["code_floating"]);
        countPoints = vi.fn().mockResolvedValue(7);
      },
    }));
    try {
      vi.resetModules();
      const { projectsCommand: fresh } = await import("../../../src/cli/commands/projects.js");
      const cli = yargs([])
        .command(fresh)
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg);
        });
      await cli.parseAsync(["projects", "orphans"]);
      const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(out).toContain("code_floating");
    } finally {
      vi.doUnmock("../../../src/bootstrap/config/index.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/embedded/daemon.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/client.js");
      vi.resetModules();
    }
  });
});
