/**
 * Child-process entry of the working-tree graph build (epic xi2r9, WTO-7).
 * Forked from the COMPILED build by `WorkingTreeGraphProcessBuilder` and kept
 * WARM: it serves `WorkingTreeGraphEntryRequest`s one at a time for as long as
 * the spawner keeps it, running `buildWorkingTreeGraph` for each and replying
 * `built` or `failed` with the request's id and the heap it holds afterwards.
 *
 * A process, not a worker thread, because the budget is enforced by killing it:
 * its own `--max-old-space-size` bounds a whole-project ts.Program, SIGKILL
 * bounds the time, and DuckDB's native memory goes back to the OS with the
 * process — none of which a thread inside the MCP server can promise.
 *
 * Warm, because a cold child pays the fork, the module load and every
 * TypeScript parse again per build. What it carries between builds is ONLY the
 * per-tree parse caches (`TreeGraphParseCacheRegistry`): each build gets a
 * fresh provider runtime, as a cold child would.
 *
 * Every failure becomes a `failed` reply, never an unhandled rejection: the
 * spawner tells "the build failed" from "the child died" by whether a reply
 * arrived, and only the second carries an exit code worth reading.
 */
import { isDebug, setDebug } from "../../../../infra/runtime.js";
import { buildWorkingTreeGraph } from "./tree-graph-build.js";
import { TreeGraphParseCacheRegistry } from "./tree-graph-parse-caches.js";
import {
  isWorkingTreeGraphEntryRequest,
  isWorkingTreeGraphEntryShutdown,
  type WorkingTreeGraphEntryReply,
} from "./tree-graph-protocol.js";

const parseCaches = new TreeGraphParseCacheRegistry();
let busy = false;
let buildsServed = 0;

// The channel closing means the parent went away (killed server, exited with
// this child idle). Mid-build nobody is left to read the graph, and finishing
// it would only hold the clone's DuckDB lock for nothing.
process.on("disconnect", () => {
  process.exit(busy ? 1 : 0);
});

process.on("message", (message: unknown) => {
  // The spawner retires an idle child by asking; it never asks mid-build.
  if (isWorkingTreeGraphEntryShutdown(message)) process.exit(0);
  void serve(message);
});

async function serve(message: unknown): Promise<void> {
  busy = true;
  const reply = await buildReply(message);
  busy = false;
  if (!process.send) process.exit(1);
  process.send({ ...reply, id: requestIdOf(message), heapUsedBytes: process.memoryUsage().heapUsed });
}

async function buildReply(message: unknown): Promise<WorkingTreeGraphEntryReply> {
  if (!isWorkingTreeGraphEntryRequest(message)) {
    return { kind: "failed", reason: "tree-graph entry: malformed request" };
  }
  setDebug(message.debug);
  try {
    const crossRunParseCache = await parseCaches.cacheFor(message.input);
    const outcome = await buildWorkingTreeGraph(message.input, { crossRunParseCache });
    buildsServed += 1;
    if (isDebug()) {
      const use = outcome.parseCache;
      process.stderr.write(
        `[tree-graph] child pid=${String(process.pid)} build#${String(buildsServed)} ` +
          `durationMs=${String(outcome.durationMs)} walked=${String(outcome.walkedFileCount)} ` +
          `programCache: ${use?.state ?? "cold"} parsesReused=${String(use?.reused ?? 0)} ` +
          `parsed=${String(use?.parsed ?? 0)} retainedParses=${String(use?.retainedFiles ?? 0)} ` +
          `heapUsedMb=${String(Math.round(process.memoryUsage().heapUsed / 1024 / 1024))}\n`,
      );
    }
    return { kind: "built", outcome };
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

function requestIdOf(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { id } = message as { id?: unknown };
  return typeof id === "number" ? id : undefined;
}
