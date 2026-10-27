/**
 * Correctness probe for the working-tree hot cache (bd tea-rags-mcp-4qdj0):
 * a delta reader with a live `WorkingTreeChangeClock` over a SCRATCH clone,
 * driven through edit / revert / create / delete / commit / branch switch, each
 * followed immediately by a read. Prints changedFiles + wall time per step.
 * Never touches the source repository beyond `git clone --local`.
 *
 * Usage: npx tsx scripts/spikes/working-tree-clock-probe.ts <sourceRepo> <scratchClone> <trackedFile>
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createWorkingTreeDeltaReader,
  WorkingTreeChangeClock,
} from "../../build/core/domains/explore/working-tree/index.js";

const [source, clone, tracked] = process.argv.slice(2);
if (!source || !clone || !tracked) {
  console.error("usage: working-tree-clock-probe.ts <sourceRepo> <scratchClone> <trackedFile>");
  process.exit(2);
}
rmSync(clone, { recursive: true, force: true });
execFileSync("git", ["clone", "-q", "--local", source, clone]);
const git = (...args: string[]): string => execFileSync("git", args, { cwd: clone, encoding: "utf8" }).trim();
const indexedCommit = git("rev-parse", "HEAD");
const clock = new WorkingTreeChangeClock();
const reader = createWorkingTreeDeltaReader({ changeClock: clock });
const accepts = (): boolean => true;
const original = readFileSync(join(clone, tracked), "utf8");

async function step(label: string, expected: number): Promise<void> {
  const start = performance.now();
  const read = await reader.read(clone, indexedCommit, accepts);
  const ms = Math.round(performance.now() - start);
  const changed = read.kind === "measured" ? read.delta.changed.length + read.delta.deleted.length : -1;
  console.log(
    `${changed === expected ? "OK  " : "FAIL"} ${label}: changedFiles=${changed} (expected ${expected}) ${ms}ms`,
  );
}

await step("cold", 0);
await step("warm, unchanged", 0);
await step("warm, unchanged", 0);
appendFileSync(join(clone, tracked), "\n# probe edit\n");
await step("tracked file edited", 1);
await step("warm after edit", 1);
writeFileSync(join(clone, tracked), original);
await step("edit reverted", 0);
writeFileSync(join(clone, "probe_untracked.rb"), "# new\n");
await step("untracked file created", 1);
rmSync(join(clone, "probe_untracked.rb"));
await step("untracked file deleted", 0);
rmSync(join(clone, tracked));
await step("tracked file deleted", 1);
git("checkout", "--", tracked);
await step("tracked file restored", 0);
git("checkout", "-q", "-b", "probe-branch");
appendFileSync(join(clone, tracked), "\n# committed\n");
git("commit", "-q", "-am", "probe commit");
await step("committed on a new branch (delta vs indexed commit)", 1);
git("checkout", "-q", "-");
await step("branch switched back", 0);
clock.close();
process.exit(0);
