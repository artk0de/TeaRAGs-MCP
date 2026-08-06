import { describe, expect, it, vi } from "vitest";

import { spawnDetachedUpdater } from "../../../src/bootstrap/auto-update/spawner.js";

describe("spawnDetachedUpdater", () => {
  it("spawns a detached node process with the auto-update run argv and unrefs it", () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    spawnDetachedUpdater({
      project: "tea-rags",
      logFd: 7,
      spawnImpl: spawnImpl as never,
      cliEntryPath: "/opt/tea-rags/build/cli/index.js",
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(argv[0]).toBe("/opt/tea-rags/build/cli/index.js");
    expect(argv.slice(-4)).toEqual(["auto-update", "run", "--project", "tea-rags"]);
    expect(opts).toMatchObject({ detached: true, stdio: ["ignore", 7, 7] });
    expect(child.unref).toHaveBeenCalled();
  });

  it("resolves the CLI entry from its own install root when not overridden", () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    spawnDetachedUpdater({ project: "p", logFd: 3, spawnImpl: spawnImpl as never });
    const argv = (spawnImpl.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv[0]).toMatch(/cli\/index\.js$/);
  });

  it("spawn failures do not propagate (fire-and-forget contract)", () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("EPERM");
    });
    expect(() => {
      spawnDetachedUpdater({ project: "p", logFd: 3, spawnImpl: spawnImpl as never });
    }).not.toThrow();
  });
});
