/**
 * Debug flag inheritance into the chunker's forked worker processes
 * (bd tea-rags-mcp-372we).
 *
 * `isDebug()` is module state per process, so a forked chunker child starts
 * with it false regardless of the parent. `ChunkerPool` ships the parent's flag
 * in the init payload and the worker entry adopts it before it builds the
 * engine — otherwise chunker-side debug output (chunker/tree-sitter.ts) is
 * silent under DEBUG=1. Both halves of that wire seam are pinned here.
 */

import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setDebug } from "../../../../../../../src/core/primitives/diagnostics/index.js";

const state = vi.hoisted(() => {
  const initial: { init: unknown; poolInit: unknown } = { init: undefined, poolInit: undefined };
  return initial;
});

vi.mock("../../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch/worker-runtime.js", () => ({
  createWorkerRuntime: () => ({
    init: async () => state.init,
    onRequest: () => undefined,
    respond: () => undefined,
    onShutdown: () => undefined,
  }),
}));

vi.mock("../../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch/worker-dispatch-pool.js", () => ({
  WorkerDispatchPool: class {
    constructor(_size: number, _transport: unknown, init: unknown) {
      state.poolInit = init;
    }
  },
}));

vi.mock("../../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch/process-transport.js", () => ({
  ProcessTransport: class {},
}));

const CONFIG = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };

describe("chunker worker debug inheritance", () => {
  afterEach(() => {
    setDebug(false);
    vi.resetModules();
  });

  it("ChunkerPool ships the parent's debug flag in the worker init payload", async () => {
    setDebug(true);
    const { ChunkerPool } = await import("../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js");

    new ChunkerPool(1, CONFIG);

    expect(state.poolInit).toMatchObject({ debug: true });
  });

  it("the worker entry adopts the debug flag from its init payload", async () => {
    vi.resetModules();
    const languageModulePath = pathToFileURL(
      new URL("../../../../../../../src/core/domains/language/index.ts", import.meta.url).pathname,
    ).href;
    state.init = { ...CONFIG, languageModulePath, debug: true };

    await import("../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker.js");

    // The entry runs in its own module registry (as a forked child does), so
    // read the flag from the registry the entry loaded, not the static import.
    const { isDebug } = await import("../../../../../../../src/core/primitives/diagnostics/index.js");
    await vi.waitFor(() => {
      expect(isDebug()).toBe(true);
    });
  });
});
