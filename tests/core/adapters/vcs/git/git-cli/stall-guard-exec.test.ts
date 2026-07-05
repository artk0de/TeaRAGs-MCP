/**
 * execWithStallGuard — streaming spawn with an output-INACTIVITY watchdog
 * (tea-rags-mcp-w2dlu follow-through).
 *
 * The CLI git timeouts exist to reap HUNG spawns, but execFile's `timeout`
 * caps TOTAL duration — a full-history `git log HEAD --numstat` on the
 * taxdome monolith streams 104MB over 122.9s and got SIGTERM'd at the 60s
 * budget, failing the whole git enrichment. The guard resets on every stdout
 * chunk: long-but-alive output completes; silence beyond the window kills.
 */

import { describe, expect, it } from "vitest";

import { execWithStallGuard } from "../../../../../../src/core/adapters/vcs/git/git-cli/stall-guard-exec.js";

describe("execWithStallGuard", () => {
  it("completes a command whose TOTAL duration exceeds the window while output keeps flowing", async () => {
    // Emits a line every 50ms for ~1.5s with a 900ms stall window: total
    // duration exceeds the window, but no single gap comes near it (wide
    // margin — scheduling jitter under a loaded suite must not flake this).
    const script = "let i=0; const t=setInterval(()=>{console.log('line '+i); if(++i>=30){clearInterval(t);}},50);";
    const stdout = await execWithStallGuard(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      stallTimeoutMs: 900,
    });
    expect(stdout).toContain("line 0");
    expect(stdout).toContain("line 29");
  }, 10_000);

  it("kills a command that goes silent beyond the stall window", async () => {
    const script = "console.log('once'); setTimeout(()=>{console.log('never')}, 60_000);";
    await expect(
      execWithStallGuard(process.execPath, ["-e", script], { cwd: process.cwd(), stallTimeoutMs: 300 }),
    ).rejects.toThrow(/stalled/i);
  });

  it("rejects with the command's stderr when it exits non-zero", async () => {
    const script = "console.error('boom detail'); process.exit(3);";
    await expect(
      execWithStallGuard(process.execPath, ["-e", script], { cwd: process.cwd(), stallTimeoutMs: 1000 }),
    ).rejects.toThrow(/boom detail/);
  });

  it("survives a long SYNCHRONOUS event-loop block while the child keeps streaming", async () => {
    // Taxdome regression: es-git blame runs as SYNC NAPI calls on the same
    // thread that owns this guard. A >window loop block queues the child's
    // 'data' events in the poll phase, but expired timers fire FIRST — the
    // guard used to kill a perfectly-alive `git log` as "stalled". The
    // setImmediate re-check runs AFTER the poll phase, sees the fresh data
    // timestamps, and re-arms instead of killing.
    const script = "let i=0; const t=setInterval(()=>{console.log('line '+i); if(++i>=25){clearInterval(t);}},50);";
    const pending = execWithStallGuard(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      stallTimeoutMs: 400,
    });
    // Give the child time to start emitting, then block OUR loop well past
    // the stall window while it keeps streaming into the pipe.
    await new Promise((r) => setTimeout(r, 150));
    const blockUntil = Date.now() + 700;
    while (Date.now() < blockUntil) {
      /* synchronous busy-wait — simulates a long sync NAPI blame call */
    }
    const stdout = await pending;
    expect(stdout).toContain("line 24");
  }, 10_000);

  it("resolves the full concatenated stdout for a fast command", async () => {
    const stdout = await execWithStallGuard(process.execPath, ["-e", "process.stdout.write('a\\nb\\nc')"], {
      cwd: process.cwd(),
      stallTimeoutMs: 1000,
    });
    expect(stdout).toBe("a\nb\nc");
  });
});
