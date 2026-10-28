import { afterEach, describe, expect, it, vi } from "vitest";

import { isPidAlive } from "../../../../src/core/adapters/process-tree/pid-liveness.js";

function killFailingWith(code: string): void {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });
}

describe("isPidAlive (bd tea-rags-mcp-hdl65)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true for a process that accepts signal 0", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false once the pid no longer exists (ESRCH)", () => {
    killFailingWith("ESRCH");
    expect(isPidAlive(4242)).toBe(false);
  });

  it("is true when signalling is denied (EPERM) — the process exists under another user or outside a sandbox", () => {
    killFailingWith("EPERM");
    expect(isPidAlive(4242)).toBe(true);
  });

  it("is false for a pid that cannot name a process", () => {
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});
