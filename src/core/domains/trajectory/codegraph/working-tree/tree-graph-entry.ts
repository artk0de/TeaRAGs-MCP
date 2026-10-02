/**
 * Child-process entry of the working-tree graph build (epic xi2r9, WTO-7).
 * Forked from the COMPILED build by `WorkingTreeGraphProcessBuilder`: receives
 * one `WorkingTreeGraphEntryRequest` over IPC, runs `buildWorkingTreeGraph`,
 * replies `built` or `failed`, and exits.
 *
 * A process, not a worker thread, because the budget is enforced by killing it:
 * its own `--max-old-space-size` bounds a whole-project ts.Program, SIGKILL
 * bounds the time, and DuckDB's native memory goes back to the OS with the
 * process — none of which a thread inside the MCP server can promise.
 *
 * Every failure becomes a `failed` reply, never an unhandled rejection: the
 * spawner tells "the build failed" from "the child died" by whether a reply
 * arrived, and only the second carries an exit code worth reading.
 */
import { setDebug } from "../../../../infra/runtime.js";
import { buildWorkingTreeGraph } from "./tree-graph-build.js";
import { isWorkingTreeGraphEntryRequest, type WorkingTreeGraphEntryReply } from "./tree-graph-protocol.js";

// The parent going away (killed server, closed IPC) leaves nobody to read the
// graph; finishing it would only hold the clone's DuckDB lock for nothing.
process.once("disconnect", () => {
  process.exit(1);
});

process.once("message", (message: unknown) => {
  void replyAndExit(message);
});

async function replyAndExit(message: unknown): Promise<void> {
  const reply = await buildReply(message);
  if (!process.send) process.exit(1);
  process.send(reply, () => {
    process.exit(0);
  });
}

async function buildReply(message: unknown): Promise<WorkingTreeGraphEntryReply> {
  if (!isWorkingTreeGraphEntryRequest(message)) {
    return { kind: "failed", reason: "tree-graph entry: malformed request" };
  }
  setDebug(message.debug);
  try {
    return { kind: "built", outcome: await buildWorkingTreeGraph(message.input) };
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
