/**
 * Worker-thread entry for `ts-live-resolve-harness.ts` (bd tea-rags-mcp-6aytq).
 *
 * A worker gets a FRESH module registry, so the `tsx` ESM loader the parent
 * registered does not cross the boundary — and `WorkerOptions.execArgv` will
 * not carry `--import tsx` across either (Node ignores it there). So the entry
 * has to be a file Node can load with no loader at all, which is what this
 * plain `.js` is (the package is `"type": "module"`, so it is already ESM):
 * register `tsx` in THIS thread, then hand off to the TypeScript worker module.
 *
 * Nothing else belongs here. Everything measured lives in
 * `ts-live-resolve-worker.ts`, and the handoff is deliberately the first thing
 * the thread does, so the profiler that module starts covers the whole run.
 */

import { register } from "tsx/esm/api";

register();

await import("./ts-live-resolve-worker.ts");
