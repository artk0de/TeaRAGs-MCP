import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { indexCodebaseCommand } from "../../../src/cli/commands/index-codebase.js";
import { createCli } from "../../../src/cli/create-cli.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

// Worker fork + supervisor are stubbed so no real child process spawns.
// Partial mock: keep the rest of node:child_process (execFile etc. are used
// transitively by the git client) and override only fork.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fork: vi.fn(() => ({})) };
});
vi.mock("../../../src/cli/index-progress/supervisor.js", () => ({
  superviseIndexing: vi.fn(async () => 0),
}));

class ExitError extends Error {
  constructor(public readonly code?: number) {
    super(`process.exit(${code})`);
  }
}

type Handler = (argv: Record<string, unknown>) => Promise<void>;
const runHandler: Handler = async (argv) =>
  (indexCodebaseCommand.handler as Handler)({
    force: false,
    json: false,
    "wait-enrichments": false,
    ...argv,
  });

describe("index-codebase --name", () => {
  let dataDir: string;
  let projPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "name-flag-data-"));
    projPath = mkdtempSync(join(tmpdir(), "name-flag-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new ExitError(c);
    }) as never);
    vi.mocked(fork).mockImplementation((() => ({})) as never);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projPath, { recursive: true, force: true });
    delete process.env.TEA_RAGS_DATA_DIR;
    vi.restoreAllMocks();
    vi.mocked(fork).mockReset();
  });

  it("registers the alias in the registry BEFORE forking the worker", async () => {
    let nameAtForkTime: string | null = null;
    vi.mocked(fork).mockImplementation((() => {
      nameAtForkTime = new CollectionRegistry(dataDir).findByName("alpha")?.name ?? null;
      return {};
    }) as never);

    await expect(runHandler({ name: "alpha", path: projPath })).rejects.toBeInstanceOf(ExitError);

    expect(nameAtForkTime).toBe("alpha"); // registered before fork ran
    expect(vi.mocked(fork)).toHaveBeenCalledOnce();
    expect(new CollectionRegistry(dataDir).findByName("alpha")?.path).toBe(realpathSync(projPath));
  });

  it("re-running --name on the same indexed path succeeds and still indexes", async () => {
    await expect(runHandler({ name: "alpha", path: projPath })).rejects.toBeInstanceOf(ExitError);
    vi.mocked(fork).mockClear();
    await expect(runHandler({ name: "alpha", path: projPath })).rejects.toBeInstanceOf(ExitError);
    expect(vi.mocked(fork)).toHaveBeenCalledOnce();
    expect(new CollectionRegistry(dataDir).findByName("alpha")).not.toBeNull();
  });

  it("rejects --name together with --project (mutually exclusive)", () => {
    // .conflicts validation is synchronous; a throwing .fail propagates out of
    // .parse before the async command handler is scheduled, so the handler
    // never runs (no unhandled rejection from an unregistered --project).
    expect(() => {
      // Throwing .fail fires synchronously during evaluation (before parse can
      // return a promise); void marks the otherwise-floating parse result.
      void createCli([])
        .exitProcess(false)
        .fail((msg: string) => {
          throw new Error(msg);
        })
        .parse(`index-codebase ${projPath} --name a --project b`);
    }).toThrow(/mutually exclusive/i);
  });

  it("aborts before forking when the alias is invalid (exit 1, no worker)", async () => {
    const err = await runHandler({ name: "Bad Name", path: projPath }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(vi.mocked(fork)).not.toHaveBeenCalled();
  });

  it("emits a parseable {error} object in --json mode on register failure", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      out.push(String(s));
      return true;
    }) as never);

    await runHandler({ name: "Bad Name", path: projPath, json: true }).catch(() => undefined);

    const parsed = JSON.parse(out.join("")) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("INPUT_PROJECT_NAME_INVALID");
    expect(parsed.error.message).toMatch(/invalid/i);
    expect(vi.mocked(fork)).not.toHaveBeenCalled();
  });
});
