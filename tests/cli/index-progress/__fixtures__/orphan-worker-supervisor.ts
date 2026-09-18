/**
 * Child process for `parent-death-guard.test.ts` — a stand-in foreground CLI.
 *
 * Forks `orphan-worker.ts` exactly as `index-codebase` forks its worker
 * (detached into its own process group, stdio ignored, IPC channel) and prints
 * one JSON line per pid the test has to watch:
 *
 *   {"worker":<pid>}
 *   {"grandchild":<pid>}
 *
 * Then it idles until the test kills it — the "pkill'ed CLI".
 */

import { fork } from "node:child_process";
import { join } from "node:path";

const mode = process.argv[2] ?? "guarded";
const worker = fork(join(import.meta.dirname, "orphan-worker.ts"), [mode], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
process.stdout.write(`${JSON.stringify({ worker: worker.pid })}\n`);
worker.on("message", (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
});
setInterval(() => undefined, 1000);
