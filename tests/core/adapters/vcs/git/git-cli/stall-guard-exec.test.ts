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

/**
 * Fixture stall window (bd tea-rags-mcp-lzks3).
 *
 * The guard arms its timer at SPAWN, so the first thing the window has to cover
 * is the child reaching its first byte of stdout — and every child here is a
 * fresh `node -e`, whose interpreter startup is the dominant term. Measured
 * spawn-to-first-byte for `node -e "process.stdout.write('x')"` inside a running
 * suite: median 1082ms, max 1368ms. The old windows (400ms / 900ms / 1000ms)
 * were all UNDER that, so the guard reaped healthy children before they had
 * printed anything — including the one test whose child writes immediately and
 * exits, which cannot stall by construction.
 *
 * 3000ms is 2x the worst measured startup. It is a fixture parameter with no
 * production meaning: the real caller (`client.ts`) floors this at
 * BULK_LOG_STALL_FLOOR_MS = 600_000, five hundred times larger, and is untouched
 * here. What the tests assert about the guard is unchanged.
 */
const STALL_WINDOW_MS = 3_000;

/**
 * A child that streams `lines` lines at `everyMs` intervals.
 *
 * After the first byte the window covers only the gap BETWEEN lines, which the
 * OS sets by scheduling the child. 10ms rather than 50ms keeps that gap far
 * under the window at the same total duration.
 */
const streamingChild = (lines: number, everyMs: number): string =>
  `let i=0; const t=setInterval(()=>{console.log('line '+i); if(++i>=${String(lines)}){clearInterval(t);}},${String(everyMs)});`;

describe("execWithStallGuard", () => {
  it("completes a command whose TOTAL duration exceeds the window while output keeps flowing", async () => {
    // Emits for ~4s against a 3s stall window: total duration exceeds the
    // window, but no single gap comes near it.
    const stdout = await execWithStallGuard(process.execPath, ["-e", streamingChild(400, 10)], {
      cwd: process.cwd(),
      stallTimeoutMs: STALL_WINDOW_MS,
    });
    expect(stdout).toContain("line 0");
    expect(stdout).toContain("line 399");
  });

  // Deliberately keeps a short window: this is the one test that WANTS the kill,
  // so a slow start can only make it fire sooner, never turn the expected
  // rejection into a pass. (A guard that failed to kill would hang on the
  // child's 60s timer and blow the test budget — still a red, not a false green.)
  it("kills a command that goes silent beyond the stall window", async () => {
    const script = "console.log('once'); setTimeout(()=>{console.log('never')}, 60_000);";
    await expect(
      execWithStallGuard(process.execPath, ["-e", script], { cwd: process.cwd(), stallTimeoutMs: 300 }),
    ).rejects.toThrow(/stalled/i);
  });

  it("rejects with the command's stderr when it exits non-zero", async () => {
    const script = "console.error('boom detail'); process.exit(3);";
    await expect(
      execWithStallGuard(process.execPath, ["-e", script], { cwd: process.cwd(), stallTimeoutMs: STALL_WINDOW_MS }),
    ).rejects.toThrow(/boom detail/);
  });

  it("survives a long SYNCHRONOUS event-loop block while the child keeps streaming", async () => {
    // Taxdome regression: es-git blame runs as SYNC NAPI calls on the same
    // thread that owns this guard. A >window loop block queues the child's
    // 'data' events in the poll phase, but expired timers fire FIRST — the
    // guard used to kill a perfectly-alive `git log` as "stalled". The
    // setImmediate re-check runs AFTER the poll phase, sees the fresh data
    // timestamps, and re-arms instead of killing.
    // The child must outlive startup + the block: it streams for ~6s while the
    // block runs 4s, and 4s > the 3s window is what makes the scenario a
    // scenario (a block SHORTER than the window would never arm the bug).
    const pending = execWithStallGuard(process.execPath, ["-e", streamingChild(600, 10)], {
      cwd: process.cwd(),
      stallTimeoutMs: STALL_WINDOW_MS,
    });
    // Give the child time to start emitting, then block OUR loop well past
    // the stall window while it keeps streaming into the pipe.
    await new Promise((r) => setTimeout(r, 150));
    const blockUntil = Date.now() + 4_000;
    while (Date.now() < blockUntil) {
      /* synchronous busy-wait — simulates a long sync NAPI blame call */
    }
    const stdout = await pending;
    expect(stdout).toContain("line 599");
  });

  it("resolves the full concatenated stdout for a fast command", async () => {
    const stdout = await execWithStallGuard(process.execPath, ["-e", "process.stdout.write('a\\nb\\nc')"], {
      cwd: process.cwd(),
      stallTimeoutMs: STALL_WINDOW_MS,
    });
    expect(stdout).toBe("a\nb\nc");
  });
});
