/**
 * The indexing lock across REAL processes (bd tea-rags-mcp-39xca.13).
 *
 * The unit suite drives two lock instances inside one process. What only separate
 * processes prove is the property the lock exists for: `open(path, "wx")` is
 * exclusive for every process on the machine, and a claimant that was killed
 * leaves a lock the next process recognises as dead by its pid.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const COLLECTION = "code_raced";
const CLAIMANT_SCRIPT = join(import.meta.dirname, "__fixtures__", "claim-indexing-lock.ts");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

interface ClaimOutcome {
  acquired: boolean;
  pid: number;
}

interface Claimant {
  child: ChildProcessWithoutNullStreams;
  nextLine: () => Promise<string | undefined>;
  exited: Promise<void>;
}

function startClaimant(lockDir: string): Claimant {
  const child = spawn(process.execPath, ["--import", "tsx", CLAIMANT_SCRIPT, lockDir, COLLECTION], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
  });
  return { child, nextLine: async () => (await lines.next()).value as string | undefined, exited };
}

async function claim(claimant: Claimant): Promise<ClaimOutcome> {
  claimant.child.stdin.write("go\n");
  const line = await claimant.nextLine();
  return JSON.parse(line ?? "null") as ClaimOutcome;
}

describe("CollectionIndexingLock across processes", () => {
  let dir: string;
  const claimants: Claimant[] = [];
  const lockFile = (): string => join(dir, `${COLLECTION}.indexing.lock`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "indexing-lock-processes-"));
  });

  afterEach(async () => {
    for (const claimant of claimants.splice(0)) {
      claimant.child.stdin.end();
      await claimant.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function spawnClaimant(): Claimant {
    const claimant = startClaimant(dir);
    claimants.push(claimant);
    return claimant;
  }

  it("lets exactly one of two processes racing for the same collection claim it", async () => {
    const [first, second] = [spawnClaimant(), spawnClaimant()];
    expect(await Promise.all([first.nextLine(), second.nextLine()])).toEqual(["ready", "ready"]);

    const outcomes = await Promise.all([claim(first), claim(second)]);

    const winners = outcomes.filter((outcome) => outcome.acquired);
    expect(winners).toHaveLength(1);
    expect((JSON.parse(readFileSync(lockFile(), "utf8")) as ClaimOutcome).pid).toBe(winners[0]?.pid);

    for (const claimant of claimants.splice(0)) {
      claimant.child.stdin.end();
      await claimant.exited;
    }
    expect(existsSync(lockFile())).toBe(false);
  }, 30_000);

  it("admits the next process once the one holding the lock was killed", async () => {
    const holder = spawnClaimant();
    expect(await holder.nextLine()).toBe("ready");
    expect(await claim(holder)).toMatchObject({ acquired: true });

    holder.child.kill("SIGKILL");
    await holder.exited;
    expect(existsSync(lockFile())).toBe(true);

    const next = spawnClaimant();
    expect(await next.nextLine()).toBe("ready");
    const outcome = await claim(next);

    expect(outcome.acquired).toBe(true);
    expect((JSON.parse(readFileSync(lockFile(), "utf8")) as ClaimOutcome).pid).toBe(outcome.pid);
  }, 30_000);
});
