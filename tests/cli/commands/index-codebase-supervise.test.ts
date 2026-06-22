/**
 * Exercises the real supervisor wiring of the index-codebase handler (NOT
 * mocking superviseIndexing), so the inline `out` / `now` callbacks the handler
 * passes are actually invoked. Only `node:child_process` fork is mocked — a fake
 * child emits a `status` message so default mode prints + resolves 0.
 */

import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { indexCodebaseCommand } from "../../../src/cli/commands/index-codebase.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

describe("indexCodebaseCommand handler — real supervisor (default mode)", () => {
  let dataDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cli-idx-"));
    originalDataDir = process.env.TEA_RAGS_DATA_DIR;
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const child = new EventEmitter() as EventEmitter & { disconnect: () => void };
    child.disconnect = vi.fn();
    vi.mocked(fork).mockReturnValue(child as never);
    // Emit a status message once the supervisor has attached its listener.
    setTimeout(() => {
      child.emit("message", {
        type: "status",
        status: { isIndexed: true, status: "indexed", collectionName: "code_x", chunksCount: 5 },
      });
    }, 0);
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.TEA_RAGS_DATA_DIR;
    else process.env.TEA_RAGS_DATA_DIR = originalDataDir;
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("prints the index status through the handler's out sink and exits 0", async () => {
    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
      path: "/repo",
      __worker: false,
      force: false,
      "wait-enrichments": false,
    });

    const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("indexed");
    expect(printed).toContain("code_x");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
