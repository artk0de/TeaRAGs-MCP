# Terminal-Only Enrichment Markers + runId-Staleness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Tests-first uses
> dinopowers:test-driven-development.

**Goal:** Make a false `healthy` enrichment status structurally impossible by
persisting only terminal per-kind markers stamped with a `runId`, plus a single
`_run` run-pointer, and deriving `in_progress`/`stalled`/`crashed` at read time.

**Architecture:** Markers at `INDEXING_METADATA_ID` → `payload.enrichment`
become: one `_run` pointer `{runId, startedAt, lastProgressAt}` (the only
pre-completion write, refreshed by a throttled heartbeat), plus four per-kind
terminal markers (`git.file`, `git.chunk`, `codegraph.symbols.file`,
`codegraph.symbols.chunk`) each carrying its own `runId` and only ever
`completed|degraded|failed`. Writes go through `QdrantManager.batchSetPayload`
with a nested `key` so disjoint sub-trees never clobber each other (race-free,
no client-side read-modify-write). `health-mapper` compares each marker's
`runId` against `_run.runId`: match → render terminal status; absent or stale →
derive `in_progress`/`stalled`/`crashed` from `_run` timestamps; never
`healthy`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Qdrant
`set_payload` with `key` (via `batchSetPayload` → `batchUpdate`),
`.qdrant-required-version` 1.17.0.

---

## Decisions locked from code grounding

- **No `client.ts` change.** `QdrantManager.batchSetPayload` already maps `key`
  to Qdrant `set_payload: {payload, points, key}`
  (`src/core/adapters/qdrant/client.ts:896`), and
  `MockQdrantManager.batchSetPayload` already models the nested merge that
  preserves sibling sub-trees
  (`tests/core/domains/ingest/__helpers__/test-helpers.ts:274-305`). The
  original spec's "add `key?` to `setPayload`" task is **dropped** — using
  `batchSetPayload` avoids touching the high-blast-radius `setPayload` signature
  entirely.
- **Additive-then-remove sequencing.** Narrowing the persisted status type
  cascades across five files. To keep every task compilable and green, new shape
  is added first, consumers migrate, old `markStart` + obsolete tests are
  removed last (Task 6).
- **Deep-silo commits.** `coordinator.ts` (Task 5) and `recovery.ts` (Task 4)
  are deep-silo per `.claude/rules/silo-pairing.md` — their commits MUST carry a
  `Why:` line.
- **Runtime assumption to validate live.** Qdrant `set_payload` with
  `key="enrichment.git.file"` must create intermediate objects when `enrichment`
  is absent. The mock does this; real Qdrant is asserted by the
  post-implementation smoke test (`test-self-reindex` skill). Flagged in Task 7.

## Out of scope (explicitly deferred)

The `completion-runner.run()` hang on `filePhase.drain()` (a `fileWork` promise
that never settles) is a **separate defect**, tracked as its own beads issue.
This plan makes the hang's symptom truthful (`in_progress` → `crashed`) but does
not fix the hang. Do NOT add drain-hang fixes here.

## File structure

| File                                                   | Responsibility after change                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/enrichment/types.ts` | Marker types: add `RunMarker`, `_run` on map, `runId` on terminal inputs; persisted level status narrows to terminal-only (Task 6) |
| `…/enrichment/marker-store.ts`                         | `markRunStart`, `heartbeat`, nested-key terminal writers carrying `runId`; remove deep-merge `write()` + `markStart` (Task 6)      |
| `…/enrichment/health-mapper.ts`                        | Read `_run`, compare `runId`, derive in_progress/stalled/crashed, legacy branch; remove `pending→healthy`                          |
| `…/enrichment/coordinator.ts`                          | `markRunStartPromise`; throttled heartbeat on apply progress; thread `runId` to completion                                         |
| `…/enrichment/completion-runner.ts`                    | Steps 4/8 pass `runId` to terminal writers; `run()` gains `runId` param                                                            |
| `…/enrichment/recovery.ts`                             | `markRecoveryResult` stamps snapshotted `runId`                                                                                    |

---

## Task 1: Marker store — `_run` pointer, heartbeat, nested-key terminal writers

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/marker-store.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts`

- [ ] **Step 1: Add the new marker types (additive)**

In `types.ts`, add the run-pointer type and extend inputs. Do NOT narrow
`EnrichmentLevelStatus` yet (Task 6).

```typescript
/** Run-pointer — the only pre-completion marker write. Lives at enrichment._run. */
export interface RunMarker {
  runId: string;
  startedAt: string;
  /** Throttled heartbeat; advanced on real apply progress. */
  lastProgressAt: string;
}
```

Add `runId` to the terminal-write inputs:

```typescript
export interface FileFinalInput {
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
}

export interface ChunkFinalInput {
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
}

export interface RecoveryResultInput {
  runId: string;
  fileStatus: "completed" | "failed";
  fileUnenriched: number;
  chunkStatus: "completed" | "degraded" | "failed";
  chunkUnenriched: number;
}
```

- [ ] **Step 2: Write the failing tests for the new store API**

Replace the `marker-store.test.ts` body's `describe("markStart", …)` and the
deep-merge/wait blocks with the new model. Add at minimum these tests (keep the
`beforeEach` harness that seeds `INDEXING_METADATA_ID`):

```typescript
describe("markRunStart", () => {
  it("writes only the _run pointer (no per-level status persisted)", async () => {
    await store.markRunStart(COLL, "run-abc", "2026-06-01T10:00:00Z");
    const e = (await store.read(COLL))!;
    expect((e._run as any).runId).toBe("run-abc");
    expect((e._run as any).startedAt).toBe("2026-06-01T10:00:00Z");
    expect((e._run as any).lastProgressAt).toBe("2026-06-01T10:00:00Z");
    // No provider/level markers exist yet — absence == not finished.
    expect(e.git).toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("advances _run.lastProgressAt while preserving runId and startedAt", async () => {
    await store.markRunStart(COLL, "run-1", "2026-06-01T10:00:00Z");
    await store.heartbeat(
      COLL,
      "run-1",
      "2026-06-01T10:00:00Z",
      "2026-06-01T10:00:30Z",
    );
    const run = (await store.read(COLL))!._run as any;
    expect(run.runId).toBe("run-1");
    expect(run.startedAt).toBe("2026-06-01T10:00:00Z");
    expect(run.lastProgressAt).toBe("2026-06-01T10:00:30Z");
  });
});

describe("terminal writers carry runId via disjoint nested keys", () => {
  it("markFileFinal writes enrichment.<provider>.file with runId, preserving a sibling chunk write", async () => {
    await store.markChunkFinal(COLL, "git", {
      runId: "r1",
      status: "completed",
      durationMs: 5,
      unenrichedChunks: 0,
    });
    await store.markFileFinal(COLL, "git", {
      runId: "r1",
      status: "completed",
      durationMs: 10,
      unenrichedChunks: 0,
      matchedFiles: 9,
      missedFiles: 1,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.runId).toBe("r1");
    expect(m.file.status).toBe("completed");
    expect(m.file.matchedFiles).toBe(9);
    expect(typeof m.file.completedAt).toBe("string");
    // sibling chunk write survived (no read-modify-write clobber)
    expect(m.chunk.status).toBe("completed");
    expect(m.chunk.runId).toBe("r1");
  });

  it("concurrent terminal writes to all four kinds all survive (race-free)", async () => {
    await Promise.all([
      store.markFileFinal(COLL, "git", {
        runId: "r",
        status: "completed",
        durationMs: 1,
        unenrichedChunks: 0,
        matchedFiles: 1,
        missedFiles: 0,
      }),
      store.markChunkFinal(COLL, "git", {
        runId: "r",
        status: "completed",
        durationMs: 1,
        unenrichedChunks: 0,
      }),
      store.markFileFinal(COLL, "codegraph.symbols", {
        runId: "r",
        status: "completed",
        durationMs: 1,
        unenrichedChunks: 0,
        matchedFiles: 1,
        missedFiles: 0,
      }),
      store.markChunkFinal(COLL, "codegraph.symbols", {
        runId: "r",
        status: "completed",
        durationMs: 1,
        unenrichedChunks: 0,
      }),
    ]);
    const e = (await store.read(COLL))!;
    expect((e.git as any).file.status).toBe("completed");
    expect((e.git as any).chunk.status).toBe("completed");
    expect((e["codegraph.symbols"] as any).file.status).toBe("completed");
    expect((e["codegraph.symbols"] as any).chunk.status).toBe("completed");
  });
});

describe("markPrefetchFailed / markRecoveryResult stamp runId", () => {
  it("markPrefetchFailed writes both levels failed with runId + errorMessage", async () => {
    await store.markPrefetchFailed(
      COLL,
      "codegraph.symbols",
      "r1",
      "2026-06-01T10:00:00Z",
      3500,
      "spill failed",
    );
    const m = (await store.read(COLL))!["codegraph.symbols"] as any;
    expect(m.file.status).toBe("failed");
    expect(m.file.runId).toBe("r1");
    expect(m.file.errorMessage).toBe("spill failed");
    expect(m.chunk.errorMessage).toBe("spill failed");
  });

  it("markRecoveryResult stamps the snapshotted runId on both levels", async () => {
    await store.markRecoveryResult(COLL, "git", {
      runId: "rec-9",
      fileStatus: "completed",
      fileUnenriched: 0,
      chunkStatus: "degraded",
      chunkUnenriched: 7,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.runId).toBe("rec-9");
    expect(m.chunk.runId).toBe("rec-9");
    expect(m.chunk.status).toBe("degraded");
    expect(m.chunk.unenrichedChunks).toBe(7);
  });
});

describe("uses batchSetPayload nested key with wait:true", () => {
  it("markFileFinal issues a key-scoped batchSetPayload with wait:true", async () => {
    await store.markFileFinal(COLL, "git", {
      runId: "r1",
      status: "completed",
      durationMs: 10,
      unenrichedChunks: 0,
      matchedFiles: 1,
      missedFiles: 0,
    });
    const call = (qdrant as any).batchSetPayloadCalls.at(-1);
    expect(call.operations[0].key).toBe("enrichment.git.file");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts`
Expected: FAIL — `store.markRunStart is not a function`,
`heartbeat is not a function`, `FileFinalInput` missing `runId`,
`batchSetPayloadCalls` empty.

- [ ] **Step 4: Implement the new marker-store**

Rewrite `marker-store.ts`. Replace the private deep-merge `write()` with a
nested-key writer over `batchSetPayload`. Add `markRunStart` + `heartbeat`.
Convert
`markFileFinal`/`markChunkFinal`/`markPrefetchFailed`/`markRecoveryResult` to
write disjoint nested keys carrying `runId`. Keep `read`/`getRunId`. Keep
`markStart` for now (removed in Task 6) but have it delegate to `markRunStart`
so existing callers compile.

```typescript
import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type {
  ChunkFinalInput,
  FileFinalInput,
  RecoveryResultInput,
} from "./types.js";

export class EnrichmentMarkerStore {
  constructor(private readonly qdrant: QdrantManager) {}

  /** Run-pointer — the only pre-completion write. Lives at enrichment._run. */
  async markRunStart(
    coll: string,
    runId: string,
    startedAt: string,
  ): Promise<void> {
    await this.writeKey(coll, "enrichment._run", {
      runId,
      startedAt,
      lastProgressAt: startedAt,
    });
  }

  /** Throttled heartbeat — rewrites the whole _run object (coordinator holds runId+startedAt). */
  async heartbeat(
    coll: string,
    runId: string,
    startedAt: string,
    lastProgressAt: string,
  ): Promise<void> {
    await this.writeKey(
      coll,
      "enrichment._run",
      { runId, startedAt, lastProgressAt },
      false,
    );
  }

  async markFileFinal(
    coll: string,
    providerKey: string,
    input: FileFinalInput,
  ): Promise<void> {
    await this.writeKey(coll, `enrichment.${providerKey}.file`, {
      runId: input.runId,
      status: input.status,
      completedAt: new Date().toISOString(),
      durationMs: input.durationMs,
      unenrichedChunks: input.unenrichedChunks,
      matchedFiles: input.matchedFiles,
      missedFiles: input.missedFiles,
    });
  }

  async markChunkFinal(
    coll: string,
    providerKey: string,
    input: ChunkFinalInput,
  ): Promise<void> {
    await this.writeKey(coll, `enrichment.${providerKey}.chunk`, {
      runId: input.runId,
      status: input.status,
      completedAt: new Date().toISOString(),
      durationMs: input.durationMs,
      unenrichedChunks: input.unenrichedChunks,
    });
  }

  async markPrefetchFailed(
    coll: string,
    providerKey: string,
    runId: string,
    startedAt: string,
    durationMs: number,
    errorMessage?: string,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const file: Record<string, unknown> = {
      runId,
      status: "failed",
      startedAt,
      completedAt,
      durationMs,
      unenrichedChunks: 0,
    };
    const chunk: Record<string, unknown> = {
      runId,
      status: "failed",
      unenrichedChunks: 0,
    };
    if (errorMessage) {
      file.errorMessage = errorMessage;
      chunk.errorMessage = errorMessage;
    }
    await this.writeKeys(coll, [
      { key: `enrichment.${providerKey}.file`, value: file },
      { key: `enrichment.${providerKey}.chunk`, value: chunk },
    ]);
  }

  async markRecoveryResult(
    coll: string,
    providerKey: string,
    input: RecoveryResultInput,
  ): Promise<void> {
    await this.writeKeys(coll, [
      {
        key: `enrichment.${providerKey}.file`,
        value: {
          runId: input.runId,
          status: input.fileStatus,
          unenrichedChunks: input.fileUnenriched,
        },
      },
      {
        key: `enrichment.${providerKey}.chunk`,
        value: {
          runId: input.runId,
          status: input.chunkStatus,
          unenrichedChunks: input.chunkUnenriched,
        },
      },
    ]);
  }

  async read(coll: string): Promise<Record<string, unknown> | null> {
    try {
      const point = await this.qdrant.getPoint(coll, INDEXING_METADATA_ID);
      const e = point?.payload?.enrichment;
      if (e && typeof e === "object") return e as Record<string, unknown>;
    } catch {
      // marker may not exist yet
    }
    return null;
  }

  async getRunId(
    coll: string,
    providerKey: string,
  ): Promise<string | undefined> {
    const marker = await this.read(coll);
    const entry = marker?.[providerKey] as Record<string, unknown> | undefined;
    return typeof entry?.runId === "string" ? entry.runId : undefined;
  }

  /** Write a single nested key (disjoint sub-tree — no read-modify-write). */
  private async writeKey(
    coll: string,
    key: string,
    value: Record<string, unknown>,
    wait = true,
  ): Promise<void> {
    await this.writeKeys(coll, [{ key, value }], wait);
  }

  /** Write several disjoint nested keys in one batchUpdate. */
  private async writeKeys(
    coll: string,
    entries: { key: string; value: Record<string, unknown> }[],
    wait = true,
  ): Promise<void> {
    try {
      await this.qdrant.batchSetPayload(
        coll,
        entries.map((e) => ({
          payload: e.value,
          points: [INDEXING_METADATA_ID],
          key: e.key,
        })),
        { wait },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Enrichment] Failed to update marker for collection ${coll}:`,
        msg,
      );
      pipelineLog.enrichmentPhase("MARKER_UPDATE_FAILED", {
        collection: coll,
        keys: entries.map((e) => e.key),
        error: msg,
      });
    }
  }

  /** @deprecated Removed in Task 6 — delegates to markRunStart during migration. */
  async markStart(
    coll: string,
    _providerKeys: Iterable<string>,
    runId: string,
    startedAt: string,
  ): Promise<void> {
    await this.markRunStart(coll, runId, startedAt);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/types.ts \
        src/core/domains/ingest/pipeline/enrichment/marker-store.ts \
        tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts
git commit -m "refactor(ingest): marker-store writes terminal markers + _run via nested-key set_payload"
```

---

## Task 2: Health-mapper — runId-staleness read path

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/health-mapper.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/health-mapper.test.ts`

- [ ] **Step 1: Add `_run` to the marker map type (additive)**

In `types.ts`, allow `_run` on the map. Keep `EnrichmentMarkerMap` indexable by
provider key plus an optional `_run`:

```typescript
/** Shape stored in Qdrant metadata point payload.enrichment */
export type EnrichmentMarkerMap = {
  _run?: RunMarker;
} & Record<string, ProviderEnrichmentMarker | RunMarker | undefined>;
```

- [ ] **Step 2: Write the failing tests for the new mapper**

Rewrite `health-mapper.test.ts`. `makeMarker` now stamps a `runId` and the tests
pass a `_run` with a matching/mismatching id. Core scenarios:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { mapMarkerToHealth } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/health-mapper.js";
import type {
  EnrichmentMarkerMap,
  RunMarker,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const RUN = "run-1";
function run(over: Partial<RunMarker> = {}): RunMarker {
  const now = new Date().toISOString();
  return { runId: RUN, startedAt: now, lastProgressAt: now, ...over };
}
function completed(runId = RUN) {
  return {
    runId,
    file: { status: "completed", unenrichedChunks: 0 },
    chunk: { status: "completed", unenrichedChunks: 0 },
  };
}

describe("mapMarkerToHealth (terminal-only + runId staleness)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders healthy when marker.runId matches _run.runId and status completed", () => {
    const map = {
      _run: run(),
      git: completed(),
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("healthy");
    expect(r.git.chunk.status).toBe("healthy");
  });

  it("NO false healthy on hang: file terminal present, chunk marker absent → chunk in_progress", () => {
    const map = {
      _run: run(),
      git: { runId: RUN, file: { status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("healthy");
    expect(r.git.chunk.status).toBe("in_progress"); // <-- was the bug (pending→healthy)
  });

  it("stale runId: marker from previous run while a new run is active → in_progress", () => {
    const map = {
      _run: run({ runId: "run-2" }),
      git: completed("run-1"),
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("in_progress");
    expect(r.git.chunk.status).toBe("in_progress");
  });

  it("stalled: no progress in >2min → in_progress with stalled message", () => {
    const stale = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const map = {
      _run: run({ lastProgressAt: stale }),
      git: { runId: RUN, file: { status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.chunk.status).toBe("in_progress");
    expect(r.git.chunk.message).toMatch(/stalled/i);
  });

  it("crashed: no progress in >1h → failed", () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const map = {
      _run: run({ startedAt: old, lastProgressAt: old }),
      git: { runId: RUN, file: { status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.chunk.status).toBe("failed");
    expect(r.git.chunk.message).toMatch(/crashed|recovered/i);
  });

  it("degraded / failed terminal statuses render through (matching runId)", () => {
    const map = {
      _run: run(),
      git: {
        runId: RUN,
        file: { status: "failed", unenrichedChunks: 5 },
        chunk: { status: "degraded", unenrichedChunks: 12 },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("failed");
    expect(r.git.chunk).toMatchObject({
      status: "degraded",
      unenrichedChunks: 12,
    });
  });

  it("surfaces errorMessage on failed terminal", () => {
    const map = {
      _run: run(),
      "codegraph.symbols": {
        runId: RUN,
        file: {
          status: "failed",
          unenrichedChunks: 0,
          errorMessage: "spill failed",
        },
        chunk: {
          status: "failed",
          unenrichedChunks: 0,
          errorMessage: "spill failed",
        },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r["codegraph.symbols"].file.message).toContain("spill failed");
  });

  it("BACK-COMPAT: no _run pointer → legacy markers render; legacy pending → in_progress (never healthy)", () => {
    const map = {
      git: {
        runId: "old",
        file: { status: "completed", unenrichedChunks: 0 },
        chunk: { status: "pending", unenrichedChunks: 0 },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("healthy");
    expect(r.git.chunk.status).toBe("in_progress"); // legacy pending is NOT healthy anymore
  });

  it("returns undefined for empty map", () => {
    expect(mapMarkerToHealth({})).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/health-mapper.test.ts`
Expected: FAIL — current mapper ignores `_run`, maps `pending`/absent →
`healthy`.

- [ ] **Step 4: Implement the new mapper**

Rewrite `health-mapper.ts`:

```typescript
import type {
  EnrichmentHealthMap,
  EnrichmentLevelHealth,
  EnrichmentMarkerMap,
  RunMarker,
} from "./types.js";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CRASHED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export function mapMarkerToHealth(
  markerMap: EnrichmentMarkerMap,
): EnrichmentHealthMap | undefined {
  const run = markerMap._run as RunMarker | undefined;
  const health: EnrichmentHealthMap = {};
  let hasAny = false;

  for (const [key, marker] of Object.entries(markerMap)) {
    if (key === "_run") continue;
    const m = marker as
      | {
          runId?: string;
          file?: Record<string, unknown>;
          chunk?: Record<string, unknown>;
        }
      | undefined;
    if (!m?.file && !m?.chunk) continue;
    hasAny = true;
    health[key] = {
      file: mapLevel(m, "file", run),
      chunk: mapLevel(m, "chunk", run),
    };
  }

  return hasAny ? health : undefined;
}

function mapLevel(
  marker: {
    runId?: string;
    file?: Record<string, unknown>;
    chunk?: Record<string, unknown>;
  },
  levelName: "file" | "chunk",
  run: RunMarker | undefined,
): EnrichmentLevelHealth {
  const level = marker[levelName] as Record<string, unknown> | undefined;
  const markerRunId = (level?.runId as string | undefined) ?? marker.runId;

  // Marker present AND belongs to the active/latest run → render terminal status.
  const matchesActiveRun =
    !run || (markerRunId !== undefined && markerRunId === run.runId);
  if (level && matchesActiveRun) {
    return renderTerminal(level, levelName);
  }

  // No _run pointer (legacy index): terminal statuses render, legacy in-flight → in_progress.
  if (!run) {
    if (
      level &&
      (level.status === "completed" ||
        level.status === "degraded" ||
        level.status === "failed")
    ) {
      return renderTerminal(level, levelName);
    }
    return { status: "in_progress", message: "Enrichment in progress..." };
  }

  // Absent OR stale-runId while a run is active → derive from _run timestamps.
  const since = Date.parse(run.lastProgressAt ?? run.startedAt);
  const elapsed = Date.now() - since;
  if (elapsed > CRASHED_THRESHOLD_MS) {
    return {
      status: "failed",
      message:
        "Enrichment appears to have crashed (no progress for over 1 hour). Status recovered on read. Will retry on next reindex.",
    };
  }
  if (elapsed > STALE_THRESHOLD_MS) {
    return {
      status: "in_progress",
      message:
        "Enrichment appears stalled — no progress in 2 minutes. May need reindex.",
    };
  }
  return { status: "in_progress", message: "Enrichment in progress..." };
}

function renderTerminal(
  level: Record<string, unknown>,
  levelName: "file" | "chunk",
): EnrichmentLevelHealth {
  const base: Record<string, unknown> = {};
  if (level.unenrichedChunks) base.unenrichedChunks = level.unenrichedChunks;
  if (level.startedAt) base.startedAt = level.startedAt;
  if (level.completedAt) base.completedAt = level.completedAt;
  if (level.durationMs !== undefined) base.durationMs = level.durationMs;
  if (level.matchedFiles !== undefined) base.matchedFiles = level.matchedFiles;
  if (level.missedFiles !== undefined) base.missedFiles = level.missedFiles;

  if (level.status === "completed") return { ...base, status: "healthy" };
  if (level.status === "degraded") {
    return {
      ...base,
      status: "degraded",
      message: `${level.unenrichedChunks} chunks missing ${levelName}-level signals. Will recover on next reindex.`,
    };
  }
  // failed
  const fallback =
    levelName === "file"
      ? "File-level enrichment failed. All file-level signals missing. Will recover on next reindex."
      : "Chunk enrichment failed. Will recover on next reindex.";
  return {
    ...base,
    status: "failed",
    message: level.errorMessage
      ? `${fallback} (${level.errorMessage})`
      : fallback,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/health-mapper.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/types.ts \
        src/core/domains/ingest/pipeline/enrichment/health-mapper.ts \
        tests/core/domains/ingest/pipeline/enrichment/health-mapper.test.ts
git commit -m "fix(ingest): health-mapper derives in_progress/crashed from _run + runId staleness, never false healthy"
```

---

## Task 3: Completion-runner — thread `runId` into terminal writes

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `completion-runner.test.ts` a test asserting the runId is forwarded to
the marker store. Use the existing test harness's spy on `markerStore` (mirror
the style already in that file). Skeleton:

```typescript
it("stamps the run's runId on file and chunk terminal markers", async () => {
  const fileFinalCalls: any[] = [];
  const chunkFinalCalls: any[] = [];
  const markerStore = {
    markFileFinal: async (_c: string, _k: string, input: any) => {
      fileFinalCalls.push(input);
    },
    markChunkFinal: async (_c: string, _k: string, input: any) => {
      chunkFinalCalls.push(input);
    },
  } as any;
  // …build CompletionRunner with the existing fakes for filePhase/chunkPhase/backfiller/applier/executor
  // (copy the harness already present in this file), one provider ctx "git".
  await runner.run(
    "coll",
    contexts,
    Date.now(),
    async () => 0,
    "2026-06-01T10:00:00Z",
    "run-xyz",
  );
  expect(fileFinalCalls[0].runId).toBe("run-xyz");
  expect(chunkFinalCalls[0].runId).toBe("run-xyz");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`
Expected: FAIL — `run()` has no `runId` parameter; `markFileFinal` input lacks
`runId`.

- [ ] **Step 3: Implement — add `runId` param and pass it through**

In `completion-runner.ts`, extend `run()`'s signature and the two terminal-write
call sites:

```typescript
async run(
  coll: string,
  contexts: ReadonlyMap<string, ProviderContext>,
  startTime: number,
  unenrichedReader?: UnenrichedReader,
  runStartedAt = "",
  runId = "",
): Promise<EnrichmentMetrics> {
```

Step 4 (file) call site — add `runId`:

```typescript
await markerStore.markFileFinal(coll, ctx.key, {
  runId,
  status: fileStatus,
  durationMs: filePhase.getPrefetchDurationMs(ctx.key),
  unenrichedChunks: fileUnenriched,
  matchedFiles: applier.matchedFiles,
  missedFiles: applier.missedFiles,
});
```

Step 8 (chunk) call site — add `runId`:

```typescript
await markerStore.markChunkFinal(coll, ctx.key, {
  runId,
  status: chunkStatus,
  durationMs: finalChunkMetrics.totalChunkEnrichmentDurationMs,
  unenrichedChunks: chunkUnenriched,
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/completion-runner.ts \
        tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
git commit -m "refactor(ingest): completion-runner stamps runId on terminal markers"
```

---

## Task 4: Recovery — stamp snapshotted `runId` (DEEP-SILO)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/recovery.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `recovery.test.ts` (follow its existing `vi.mock` style) a test that
`recoverAll` passes the snapshotted runId into `markRecoveryResult`:

```typescript
it("stamps the snapshotted runId into markRecoveryResult", async () => {
  const calls: any[] = [];
  const markerStore = {
    getRunId: async () => "run-snap",
    markRecoveryResult: async (_c: string, _k: string, input: any) => {
      calls.push(input);
    },
  } as any;
  // recovery with a provider whose remainingUnenriched resolves to 0/0 (reuse existing fakes)
  await recovery.recoverAll("coll", "/abs", contexts, markerStore);
  expect(calls[0].runId).toBe("run-snap");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`
Expected: FAIL — `markRecoveryResult` input lacks `runId`.

- [ ] **Step 3: Implement — pass `baselineRunId` into the marker write**

In `recovery.ts` `recoverAll`, the `baselineRunId` is already snapshotted. Add
it to the marker write (the stale-runId guard already re-checks `currentRunId`).
`runId` may be `undefined` for a never-run collection — coerce to `""`:

```typescript
await markerStore.markRecoveryResult(coll, ctx.key, {
  runId: baselineRunId ?? "",
  fileStatus: fileResult.remainingUnenriched === 0 ? "completed" : "failed",
  fileUnenriched: fileResult.remainingUnenriched,
  chunkStatus: chunkResult.remainingUnenriched === 0 ? "completed" : "degraded",
  chunkUnenriched: chunkResult.remainingUnenriched,
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (DEEP-SILO — `Why:` line required)**

```bash
git add src/core/domains/ingest/pipeline/enrichment/recovery.ts \
        tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts
git commit -m "refactor(ingest): recovery stamps runId on recovery marker

Why: terminal-only marker model keys staleness on runId; a recovery write
without the snapshotted runId would render as stale (in_progress) under the
new health-mapper. Trade-off: recovery markers now coerce a missing baseline
runId to \"\", which the mapper treats as legacy (renders terminal) — acceptable
because recovery only writes when the stale-runId guard confirmed no concurrent
run rewrote the marker."
```

---

## Task 5: Coordinator — `markRunStart` + throttled heartbeat (DEEP-SILO)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `coordinator.test.ts` (reuse its `MockQdrantManager` harness):

```typescript
it("beginRun writes only the _run pointer, no per-level status", async () => {
  coordinator.beginRun("/abs", COLL);
  await coordinator.awaitCompletion(COLL); // flush markRunStartPromise via the gate
  const e = (await new EnrichmentMarkerStore(qdrant as any).read(COLL))!;
  expect((e._run as any).runId).toBeDefined();
  expect(e.git).toBeUndefined(); // no in_progress/pending persisted
});

it("onChunksStored advances _run.lastProgressAt (throttled heartbeat)", async () => {
  coordinator.beginRun("/abs", COLL);
  await flushMarkRunStart(coordinator); // helper awaits the internal promise
  const before = (await store.read(COLL))!._run as any;
  // advance fake clock beyond the throttle window, then deliver a batch
  vi.advanceTimersByTime(31_000);
  coordinator.onChunksStored(COLL, "/abs", [makeItem()]);
  await Promise.resolve();
  const after = (await store.read(COLL))!._run as any;
  expect(after.lastProgressAt).not.toBe(before.lastProgressAt);
});
```

(If the coordinator test file does not already fake timers, gate the heartbeat
test behind `vi.useFakeTimers()` in a local `beforeEach`/`afterEach`, matching
the file's conventions.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: FAIL — `beginRun` still calls `markStart` (writes per-provider
in_progress); no heartbeat.

- [ ] **Step 3: Implement**

In `coordinator.ts`:

1. Rename the run-state field `markStartPromise` → `markRunStartPromise` (and
   the `RunState` interface field + `createRunState` initializer + the
   `awaitCompletion` gate `await run.markStartPromise`).

2. In `beginRun`, replace the `markStart` write with `markRunStart`:

```typescript
runState.markRunStartPromise = collectionName
  ? this.markerStore
      .markRunStart(collectionName, runState.runId, runState.startedAt)
      .catch(() => undefined)
  : Promise.resolve();
```

3. Add a throttled heartbeat. Add a `lastHeartbeatAt: number` field to
   `RunState` (init `0`). In `onChunksStored`, after dispatching file/chunk
   work, fire the heartbeat for the CURRENT run only (RunState isolation guard):

```typescript
this.maybeHeartbeat(collectionName, run);
```

```typescript
private static readonly HEARTBEAT_THROTTLE_MS = 30_000;

private maybeHeartbeat(collectionName: string | undefined, run: RunState): void {
  if (!collectionName || this.currentRun !== run) return; // only the active run writes _run
  const now = Date.now();
  if (now - run.lastHeartbeatAt < EnrichmentCoordinator.HEARTBEAT_THROTTLE_MS) return;
  run.lastHeartbeatAt = now;
  void this.markerStore
    .heartbeat(collectionName, run.runId, run.startedAt, new Date().toISOString())
    .catch(() => undefined);
}
```

Note `onChunksStored` is called with `(collectionName, absolutePath, items)` and
currently early-returns when `!this.currentRun`. Capture `run = this.currentRun`
(already done) and pass `collectionName` to `maybeHeartbeat`.

4. In `awaitCompletion`, pass `run.runId` as the new `run()` argument:

```typescript
const metrics = await run.completion.run(
  collectionName,
  run.contexts,
  run.startTime,
  async (coll, providerKey, level) =>
    this.countSettledUnenriched(coll, providerKey, level),
  run.startedAt,
  run.runId,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (DEEP-SILO — `Why:` line required)**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
        tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "refactor(ingest): coordinator writes _run pointer + throttled heartbeat instead of markStart

Why: persisting per-level in_progress/pending at run start was the root of stale
false-healthy markers — a hung run froze them and health-mapper read pending as
healthy. The run-pointer is the only pre-completion write; the heartbeat (one
field, never a per-level status) lets the mapper distinguish a live-but-slow run
from a stalled/crashed one. Trade-off: a 30s heartbeat throttle means a stall is
detected up to ~30s late, acceptable against the 2min stale threshold."
```

---

## Task 6: Remove dead code — narrow persisted status, delete `markStart`

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/marker-store.ts`
- Test: all enrichment tests (regression sweep)

- [ ] **Step 1: Narrow the persisted level status type**

In `types.ts`, narrow the persisted marker status to terminal-only and drop the
moved heartbeat fields:

```typescript
export type EnrichmentLevelStatus = "completed" | "degraded" | "failed";

export interface EnrichmentLevelMarker {
  runId?: string;
  status: EnrichmentLevelStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  unenrichedChunks: number;
  errorMessage?: string;
}
```

Remove `lastProgressAt` / `lastProgressChunks` from `EnrichmentLevelMarker`
(they live on `RunMarker` now). `ProviderEnrichmentMarker` keeps
`{ runId, file, chunk }`. `EnrichmentLevelHealth` is unchanged (still has
derived `in_progress`).

- [ ] **Step 2: Delete the deprecated `markStart`**

Remove the `markStart` method from `marker-store.ts` (added as a delegating shim
in Task 1).

- [ ] **Step 3: Fix any remaining compile breaks**

Run: `npx tsc --noEmit` Resolve any references to the removed `markStart` /
`pending` / `in_progress` persisted status or `lastProgressAt` on a level
marker. Expected breakers: none outside the enrichment dir if Tasks 1–5 migrated
all call sites; if `tsc` flags a test still using the old shape, migrate that
test to the new model (do NOT widen the type back).

- [ ] **Step 4: Run the full enrichment + adapter regression sweep**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/ tests/core/adapters/qdrant/`
Expected: PASS (all enrichment + qdrant client tests green).

- [ ] **Step 5: Full type-check + lint**

Run:
`npx tsc --noEmit && npx eslint src/core/domains/ingest/pipeline/enrichment/`
Expected: 0 errors. (No eslint-disable, no threshold changes — fix code if
flagged.)

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/types.ts \
        src/core/domains/ingest/pipeline/enrichment/marker-store.ts
git commit -m "refactor(ingest): drop pending/in_progress from persisted marker status + remove markStart shim"
```

---

## Task 7: Full suite + live smoke validation

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run` Expected: PASS (no regressions across the ~6000-test
suite).

- [ ] **Step 2: Build + link + reconnect MCP (per `.claude/CLAUDE.md` § MCP
      Integration Testing)**

```bash
npm run build && npm link
```

Then reconnect MCP servers in Claude Code.

- [ ] **Step 3: Live smoke via the self-reindex skill**

Invoke the `test-self-reindex` skill (registers `tea-rags-worktree`,
force-reindexes, waits for `ALL_COMPLETE`, checks all four enrichment levels).
This validates the **runtime assumption** that Qdrant `set_payload` with a
nested `key` creates intermediate objects when `enrichment` is absent, and that
all four kinds reach `healthy` with matching `runId`.

Expected:

- `get_index_status` shows `git.file`, `git.chunk`, `codegraph.symbols.file`,
  `codegraph.symbols.chunk` all `healthy`.
- Raw metadata point payload shows `enrichment._run.runId` equal to each kind's
  `runId`.

- [ ] **Step 4: File the deferred drain-hang beads issue**

```bash
bd create --title="completion-runner.run() hangs on filePhase.drain() (fileWork promise never settles)" \
  --description="Separate from the terminal-only marker redesign. run() step 1 (filePhase.drain) can never settle when a per-provider fileWork promise hangs; the marker redesign makes the symptom truthful (in_progress→crashed) but does not fix the hang. Repro: live force_reindex showed all threads idle, runId 34bcbb0f stuck. Investigate which fileWork promise fails to settle and why icfj/H did not fully resolve it." \
  --type=bug --priority=1
```

---

## Self-review

**Spec coverage:**

- §Data model `_run` + per-kind terminal → Tasks 1, 2. ✓
- §Write path nested-key, no RMW → Task 1 (`batchSetPayload` key). ✓
- §Heartbeat → Task 5. ✓
- §Read path runId comparison + remove pending→healthy + legacy branch → Task 2.
  ✓
- §Type changes (narrow status, move lastProgressAt) → Tasks 1, 6. ✓
- §Component changes (marker-store, coordinator, completion-runner, recovery,
  health-mapper) → Tasks 1, 3, 4, 5; types Tasks 1/2/6. ✓
- §Out of scope drain-hang → deferred, beads filed in Task 7. ✓
- §Back-compat legacy shape → Task 2 test + mapper legacy branch. ✓
- §Testing strategy 1–7 → covered across Tasks 1 (race-free, recovery runId), 2
  (no-false-healthy, stale-runId, crash/stalled, successful, back-compat). ✓

**Type consistency:** `markRunStart(coll, runId, startedAt)`,
`heartbeat(coll, runId, startedAt, lastProgressAt)`,
`markFileFinal/markChunkFinal(coll, key, {runId,…})`,
`run(…, runStartedAt, runId)` used consistently across Tasks 1, 3, 5.
`RunMarker` defined Task 1, consumed Task 2. `EnrichmentMarkerMap` extended
Task 2.

**No placeholders:** every code step shows full code; commit messages concrete;
deep-silo `Why:` lines included for recovery.ts and coordinator.ts.
