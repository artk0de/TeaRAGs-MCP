/**
 * Warm per-call cost of the working-tree overlay inside ONE long-lived server
 * process (bd tea-rags-mcp-4qdj0).
 *
 * Builds the MCP server once (`watchWorkingTrees: true`, like the stdio
 * server), then calls `find_symbol` N times against a registered project and
 * times, per iteration, the overlay's measurement primitives on the same tree
 * in isolation: git toplevel + HEAD read, the ingest file filter, `git status`,
 * and the delta reader's full `read` (status + fingerprint + cache). The
 * remainder of the tool call (Qdrant query + formatting) is total minus the
 * reader's read.
 *
 * Read-only: never indexes, never writes the index.
 *
 * Usage:
 *   npx tsx scripts/spikes/working-tree-measure-profile.ts <project> <treeRoot> <relativePath> [iterations]
 */
import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

import { createConfiguredServer, createWorkingTreeFileFilter } from "../../build/bootstrap/factory.js";
import { connectInProcessClient } from "../../build/bootstrap/transport/in-memory.js";
import { prepareMcpServerRuntime } from "../../build/bootstrap/transport/server-runtime.js";
import { readStatusPorcelain } from "../../build/core/adapters/vcs/git/git-cli/working-tree.js";
import { findGitToplevel, readRepoGitState } from "../../build/core/adapters/vcs/git/repo-git-state.js";
import { createWorkingTreeDeltaReader } from "../../build/core/domains/explore/working-tree/delta.js";

// Spawn trace: every child process started while a find_symbol call runs is
// recorded with its wall time (spawn → exit), so the call's subprocess cost is
// visible per command. Hooks the one path spawn/execFile/exec all take.
const spawnLog: { cmd: string; ms: number }[] = [];
let tracing = false;
{
  const proto = ChildProcess.prototype as unknown as { spawn: (options: { file: string; args: string[] }) => unknown };
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, options) {
    const out = original.call(this, options);
    if (tracing) {
      const start = performance.now();
      const cmd = options.args.join(" ").slice(0, 400);
      this.once("exit", () => spawnLog.push({ cmd, ms: Math.round(performance.now() - start) }));
    }
    return out;
  };
}

const [project, treeRoot, relativePath, iterationsArg] = process.argv.slice(2);
if (!project || !treeRoot || !relativePath) {
  console.error("usage: working-tree-measure-profile.ts <project> <treeRoot> <relativePath> [iterations]");
  process.exit(2);
}
const iterations = Number(iterationsArg ?? 10);

type Phase = "toplevelHead" | "fileFilter" | "gitStatus" | "deltaRead" | "findSymbol";
const samples: Record<Phase, number[]> = {
  toplevelHead: [],
  fileFilter: [],
  gitStatus: [],
  deltaRead: [],
  findSymbol: [],
};

async function timed<T>(phase: Phase, run: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    samples[phase].push(performance.now() - start);
  }
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

const { ctx, promptsConfig } = await prepareMcpServerRuntime({ watchWorkingTrees: true });
const server = createConfiguredServer(ctx, promptsConfig, { autoUpdate: false });
const session = await connectInProcessClient(server);
const config = (await import("../../build/bootstrap/config/app-config.js")).parseAppConfig();
const fileFilter = createWorkingTreeFileFilter(config.ingestCode);
const reader = createWorkingTreeDeltaReader();
const indexedCommit = readRepoGitState(treeRoot)?.commit ?? null;
const params = { project, path: treeRoot, relativePath };

// One cold call each, discarded: the first pays connection + cache fill.
await session.callTool("find_symbol", params);
const coldAccepts = await fileFilter(treeRoot);
await reader.read(treeRoot, indexedCommit, coldAccepts);

for (let i = 0; i < iterations; i++) {
  await timed("toplevelHead", () => readRepoGitState(findGitToplevel(treeRoot) ?? treeRoot));
  const accepts = await timed("fileFilter", async () => fileFilter(treeRoot));
  await timed("gitStatus", async () => readStatusPorcelain(treeRoot));
  await timed("deltaRead", async () => reader.read(treeRoot, indexedCommit, accepts));
  tracing = true;
  const result = await timed("findSymbol", async () => session.callTool("find_symbol", params));
  tracing = false;
  if (i === 0 || i === iterations - 1) console.error(`spawns in call ${i}: ${JSON.stringify(spawnLog)}`);
  spawnLog.length = 0;
  if (result.isError === true) throw new Error(`find_symbol failed: ${JSON.stringify(result).slice(0, 300)}`);
}

const rows = (Object.keys(samples) as Phase[]).map((phase) => ({
  phase,
  p50ms: Math.round(quantile(samples[phase], 0.5)),
  p95ms: Math.round(quantile(samples[phase], 0.95)),
  maxms: Math.round(Math.max(...samples[phase])),
}));
const rest = samples.findSymbol.map((total, i) => total - (samples.deltaRead[i] ?? 0));
rows.push({
  phase: "findSymbol − deltaRead (query+format+rest)" as Phase,
  p50ms: Math.round(quantile(rest, 0.5)),
  p95ms: Math.round(quantile(rest, 0.95)),
  maxms: Math.round(Math.max(...rest)),
});
console.log(JSON.stringify({ project, treeRoot, relativePath, iterations, rows }, null, 1));
await session.close();
await ctx.cleanup?.();
process.exit(0);
