import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnDetachedClientUpdate } from "../../../src/cli/client-update/spawner.js";
import { clientUpdateLogPath } from "../../../src/cli/client-update/state-store.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fakeSpawn() {
  const unref = vi.fn();
  const impl = vi.fn(() => ({ unref }));
  return { impl: impl as never, spy: impl, unref };
}

describe("spawnDetachedClientUpdate", () => {
  it("launches the CLI `update --background` detached, with output on the client-update log, and unrefs it", () => {
    dir = mkdtempSync(join(tmpdir(), "cu-spawn-"));
    const { impl, spy, unref } = fakeSpawn();

    spawnDetachedClientUpdate({ dataDir: dir, spawnImpl: impl, cliEntryPath: "/x/cli/index.js" });

    expect(spy).toHaveBeenCalledWith(
      process.execPath,
      ["/x/cli/index.js", "update", "--background"],
      expect.objectContaining({ detached: true }),
    );
    expect(unref).toHaveBeenCalled();
    expect(existsSync(clientUpdateLogPath(dir))).toBe(true);
  });

  it("truncates a log past 5 MB instead of appending, and swallows spawn failures", () => {
    dir = mkdtempSync(join(tmpdir(), "cu-spawn-"));
    const logPath = clientUpdateLogPath(dir);
    spawnDetachedClientUpdate({ dataDir: dir, spawnImpl: fakeSpawn().impl, cliEntryPath: "/x" });
    writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024 + 10));

    const throwing = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    expect(() => {
      spawnDetachedClientUpdate({ dataDir: dir, spawnImpl: throwing, cliEntryPath: "/x" });
    }).not.toThrow();
    expect(statSync(logPath).size).toBe(0);
  });
});
