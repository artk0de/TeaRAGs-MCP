import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runUpdateCommand } from "../../../src/cli/commands/update.js";

function makeChild(): EventEmitter {
  return new EventEmitter();
}

describe("runUpdateCommand — spawn error branches", () => {
  it("reports a non-ENOENT spawn error and exits 1", async () => {
    const child = makeChild();
    const exit = vi.fn();
    const stderrWrites: string[] = [];
    const origStderr = process.stderr.write;
    process.stderr.write = ((m: string) => {
      stderrWrites.push(String(m));
      return true;
    }) as never;

    const service = {
      checkForUpdate: vi.fn().mockResolvedValue({
        kind: "available",
        current: "1.0.0",
        latest: "1.0.1",
      }),
    };
    const spawn = vi.fn(() => child) as never;

    const runPromise = runUpdateCommand({ service, spawn, exit });
    await Promise.resolve();
    child.emit("error", Object.assign(new Error("EPERM denied"), { code: "EPERM" }));
    await runPromise;
    process.stderr.write = origStderr;

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderrWrites.some((m) => m.includes("Failed to spawn npm"))).toBe(true);
  });
});
