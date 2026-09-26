/**
 * `tea-rags projects` env surface (bd tea-rags-mcp-5uk75): `register --env
 * KEY=VALUE` (repeatable), `set-env --name <alias> KEY=VALUE...`,
 * `unset-env --name <alias> KEY...`, and `info` showing the result.
 *
 * Driven through the real yargs wiring against a temp TEA_RAGS_DATA_DIR; the
 * result is read back through a fresh CollectionRegistry, i.e. from disk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { parseEnvAssignments, projectsCommand } from "../../../src/cli/commands/projects.js";
import { InvalidParameterError } from "../../../src/core/api/errors.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";

describe("parseEnvAssignments", () => {
  it("splits KEY=VALUE on the first '=' so values may contain '='", () => {
    expect(parseEnvAssignments(["GIT_ADAPTER=git", "CODE_TEST_PATHS=a=b"])).toEqual({
      GIT_ADAPTER: "git",
      CODE_TEST_PATHS: "a=b",
    });
  });

  it("rejects a token that is not KEY=VALUE with a typed error", () => {
    expect(() => parseEnvAssignments(["GIT_ADAPTER"])).toThrow(InvalidParameterError);
    expect(() => parseEnvAssignments(["=cli"])).toThrow(InvalidParameterError);
  });
});

describe("projects env subcommands", () => {
  let dir: string;
  let repo: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-proj-env-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

  function makeCli(): ReturnType<typeof yargs> {
    return yargs([])
      .command(projectsCommand)
      .exitProcess(false)
      .fail((msg, err) => {
        throw err ?? new Error(msg);
      });
  }

  const stdout = (): string => stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
  const stderr = (): string => stderrSpy.mock.calls.map((c) => String(c[0])).join("");
  const onDisk = () => new CollectionRegistry(dir).findByName("alpha");

  it("register --env (repeatable) persists the env with the alias", async () => {
    await makeCli().parseAsync([
      "projects",
      "register",
      "--path",
      repo,
      "--name",
      "alpha",
      "--env",
      "CODE_CHUNK_SIZE=2500",
      "--env",
      "CODEGRAPH_ENABLED=true",
    ]);
    expect(onDisk()?.env).toEqual({ INGEST_CHUNK_SIZE: "2500" });
    expect(onDisk()?.codegraphEnabled).toBe(true);
  });

  it("register --env with an unknown key fails and registers nothing", async () => {
    await expect(
      makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha", "--env", "NOPE=1"]),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderr()).toMatch(/NOPE/);
    expect(onDisk()).toBeNull();
  });

  it("set-env sets keys on an existing project; unset-env removes them", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    await makeCli().parseAsync(["projects", "set-env", "--name", "alpha", "GIT_ADAPTER=git", "INGEST_CHUNK_SIZE=2000"]);
    expect(onDisk()?.env).toEqual({ GIT_ADAPTER: "git", INGEST_CHUNK_SIZE: "2000" });
    expect(stdout()).toMatch(/alpha/);

    await makeCli().parseAsync(["projects", "unset-env", "--name", "alpha", "CODE_CHUNK_SIZE"]);
    expect(onDisk()?.env).toEqual({ GIT_ADAPTER: "git" });
  });

  it("set-env rejects a value the config schema refuses", async () => {
    await makeCli().parseAsync(["projects", "register", "--path", repo, "--name", "alpha"]);
    await expect(async () =>
      makeCli().parseAsync(["projects", "set-env", "--name", "alpha", "INGEST_CHUNK_SIZE=abc"]),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderr()).toMatch(/INGEST_CHUNK_SIZE/);
    expect(onDisk()?.env).toBeUndefined();
  });

  it("set-env on an unknown alias fails", async () => {
    await expect(async () =>
      makeCli().parseAsync(["projects", "set-env", "--name", "ghost", "GIT_ADAPTER=git"]),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderr()).toMatch(/ghost/);
  });

  it("set-env demands at least one assignment", async () => {
    await expect(async () => makeCli().parseAsync(["projects", "set-env", "--name", "alpha"])).rejects.toThrow(
      /at least 1/,
    );
  });

  it("info shows the project env and the dedicated fields", async () => {
    await makeCli().parseAsync([
      "projects",
      "register",
      "--path",
      repo,
      "--name",
      "alpha",
      "--env",
      "GIT_ADAPTER=git",
      "--env",
      "CODEGRAPH_ENABLED=true",
      "--env",
      "EMBEDDING_BASE_URL=http://gpu:11434",
    ]);
    stdoutSpy.mockClear();
    await makeCli().parseAsync(["projects", "info", "--name", "alpha"]);
    const out = stdout();
    expect(out).toMatch(/^embeddingBaseUrl: +http:\/\/gpu:11434$/m);
    expect(out).toMatch(/^codegraphEnabled: +true$/m);
    expect(out).toMatch(/^env:/m);
    expect(out).toMatch(/^ +GIT_ADAPTER=git$/m);
  });
});
