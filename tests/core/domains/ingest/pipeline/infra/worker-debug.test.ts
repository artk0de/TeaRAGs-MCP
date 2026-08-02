/**
 * Debug flag inheritance into worker threads.
 *
 * `isDebug()` is a module-level flag set once from config in the main thread
 * (bootstrap/factory.ts). A worker thread gets a FRESH module registry, so the
 * flag defaults to false there no matter what the process was started with —
 * which is why every codegraph pass-2 marker (`CODEGRAPH_PASS2_PROGRESS`,
 * `CODEGRAPH_CHUNK_SIGNALS_READ`, ...) has never reached a log file: they are
 * emitted from inside the enrichment worker, behind `isDebug()`.
 *
 * The pool now ships the flag in `workerData`; this pins the reading half —
 * the worker adopts it only when explicitly told to, and a malformed or absent
 * payload leaves the flag untouched rather than throwing on a hot path.
 */
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkerDebug } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-debug.js";
import { isDebug, setDebug } from "../../../../../../src/core/infra/runtime.js";

describe("applyWorkerDebug", () => {
  afterEach(() => {
    setDebug(false);
  });

  it("adopts an enabled flag from the worker payload", () => {
    setDebug(false);

    applyWorkerDebug({ debug: true });

    expect(isDebug()).toBe(true);
  });

  it("adopts a disabled flag from the worker payload", () => {
    setDebug(true);

    applyWorkerDebug({ debug: false });

    expect(isDebug()).toBe(false);
  });

  it.each([[undefined], [null], ["yes"], [{}], [{ debug: "true" }], [42]])(
    "leaves the flag untouched for a payload without a boolean debug (%s)",
    (payload) => {
      setDebug(true);

      applyWorkerDebug(payload);

      expect(isDebug()).toBe(true);
    },
  );
});
