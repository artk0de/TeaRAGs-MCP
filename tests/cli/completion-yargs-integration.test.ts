import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli/create-cli.js";
import { CollectionRegistry } from "../../src/core/infra/registry/collection-registry.js";

/**
 * End-to-end completion tests that drive the real yargs `.completion(...)`
 * callback (4-param fallback form) via the `--get-yargs-completions` protocol.
 *
 * Captures stdout writes and asserts on the emitted completion lines.
 */
describe("createCli — yargs --get-yargs-completions integration", () => {
  let dir: string;
  let originalDataDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  function seedAlias(name: string): void {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".keep"), "");
    const reg = new CollectionRegistry(dir);
    const collectionName = `code_${name}`;
    reg.record({
      collectionName,
      path: repo,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "",
      indexedAt: "",
      teaRagsVersion: "",
      chunksCount: 0,
    });
    reg.setName(collectionName, name);
  }

  /**
   * Drive createCli through a completion-protocol parse and return emitted
   * completion lines. yargs's internal logger goes through `console.log` —
   * we spy that. After emitting, yargs calls `process.exit(0)`; we suppress
   * it with `exitProcess(false)`. Returned values have any `:description`
   * suffix stripped so tests can assert on bare completion tokens.
   */
  async function runCompletion(argv: string[]): Promise<string[]> {
    const lines: string[] = [];
    logSpy.mockImplementation(((...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    }) as never);

    const cli = createCli(argv);
    cli.exitProcess(false);
    try {
      await cli.parseAsync();
    } catch {
      // yargs may throw after emitting completions when exitProcess is disabled.
    }

    return (
      lines
        .flatMap((line) => line.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // yargs emits `value:description` for built-in completions; bare values
        // for our custom (project alias) matches.
        .map((line) => {
          const colon = line.indexOf(":");
          return colon === -1 ? line : line.slice(0, colon);
        })
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-comp-int-"));
    originalDataDir = process.env.TEA_RAGS_DATA_DIR;
    process.env.TEA_RAGS_DATA_DIR = dir;

    // yargs emits completions via its internal logger -> console.log.
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Mock process.exit so it raises instead of killing vitest. yargs falls
    // back to `this.exit(0)` after emitting completions; `exitProcess(false)`
    // in `runCompletion` keeps yargs from actually invoking process.exit, but
    // we belt-and-suspenders here.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${String(code)}) called unexpectedly`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    if (originalDataDir === undefined) {
      delete process.env.TEA_RAGS_DATA_DIR;
    } else {
      process.env.TEA_RAGS_DATA_DIR = originalDataDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits top-level commands at root completion", async () => {
    const lines = await runCompletion(["--get-yargs-completions", "tea-rags", ""]);

    // yargs defaultCompletions emits each command on its own line. Allow extra
    // commands but require the known ones.
    expect(lines).toEqual(expect.arrayContaining(["server", "tune", "prime", "update", "projects", "completion"]));
  });

  it("emits projects subcommands when completing under `projects`", async () => {
    const lines = await runCompletion(["--get-yargs-completions", "tea-rags", "projects", ""]);

    expect(lines).toEqual(expect.arrayContaining(["register", "unregister", "list", "info"]));
  });

  it("completes --project flag with registered alias names (tune)", async () => {
    seedAlias("alpha");
    seedAlias("bravo");

    const lines = await runCompletion(["--get-yargs-completions", "tea-rags", "tune", "--project", ""]);

    expect(lines.sort()).toEqual(["alpha", "bravo"]);
  });

  it("completes --name for `projects info` with registered alias names", async () => {
    seedAlias("alpha");

    const lines = await runCompletion(["--get-yargs-completions", "tea-rags", "projects", "info", "--name", ""]);

    expect(lines).toEqual(["alpha"]);
  });

  it("does NOT inject alias names into --name for `projects register` (falls back to yargs defaults)", async () => {
    seedAlias("alpha");

    const lines = await runCompletion(["--get-yargs-completions", "tea-rags", "projects", "register", "--name", ""]);

    // Alias must NOT appear — register is for inventing brand-new names.
    expect(lines).not.toContain("alpha");
  });
});
