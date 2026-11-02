import { beforeEach, describe, expect, it, vi } from "vitest";

const discover = vi.fn();
const hostDeps = vi.fn(() => ({ discover }));

vi.mock("../../../../src/core/adapters/rustc-driver/callsite-runner.js", () => ({
  defaultRustcCallSiteRunnerDeps: hostDeps,
}));

const { createRustcDriverPresenceProbe } = await import("../../../../src/core/adapters/rustc-driver/presence-probe.js");

describe("createRustcDriverPresenceProbe (bd tea-rags-mcp-hjbow.9)", () => {
  beforeEach(() => {
    discover.mockReset();
    hostDeps.mockClear();
  });

  it("answers whether discovery finds a driver, re-running discovery on every probe", () => {
    const probe = createRustcDriverPresenceProbe({});
    discover.mockReturnValueOnce(null).mockReturnValueOnce({ kind: "binary", path: "/x" });
    expect(probe()).toBe(false);
    expect(probe()).toBe(true);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("binds the host once, on the first probe, not at construction", () => {
    const probe = createRustcDriverPresenceProbe({});
    expect(hostDeps).not.toHaveBeenCalled();
    discover.mockReturnValue(null);
    probe();
    probe();
    expect(hostDeps).toHaveBeenCalledTimes(1);
  });

  it("reads a discovery that throws as not found", () => {
    discover.mockImplementation(() => {
      throw new Error("unreadable dir");
    });
    expect(createRustcDriverPresenceProbe({})()).toBe(false);
  });
});
