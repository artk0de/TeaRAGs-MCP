/**
 * `runRepairPass` under a `--languages` selection (bd tea-rags-mcp-df1rn).
 *
 * The repair set is the ONLY lever that reaches pass-2: `resolveAndUpsert`
 * resolves whatever landed in the spill, unconditionally. So a run restricted
 * to one language is restricted here or nowhere — and the two directions this
 * pins are equally load-bearing. Narrowing too little re-resolves the whole
 * corpus (what taxdome did on 2026-08-14: 19,966 files repaired under
 * `--languages typescript`, 8,817 of them ruby). Narrowing the wrong set
 * destroys data: the eligible map also feeds orphan detection, so filtering it
 * would report every unselected-language row as no longer eligible and prune
 * the graph the run was told to leave alone.
 */

import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

const qdrant = {} as never;

function makeExecutor(runFileBatch: ReturnType<typeof vi.fn>) {
  return {
    runFileBatch,
    runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseCollection: vi.fn().mockResolvedValue(undefined),
  } as never;
}

/** Codegraph-shaped provider: owns a per-file store, so it can be forced. */
function graphProvider(persisted: Map<string, string | null>, handleDeletedPaths = vi.fn()) {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: vi.fn((p: string) => p),
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn().mockResolvedValue(persisted),
    handleDeletedPaths,
  } as never;
}

const MIXED = new Map([
  ["src/app.ts", "h1"],
  ["src/view.tsx", "h2"],
  ["lib/worker.rb", "h3"],
  ["bin/deploy.sh", "h4"],
]);

/** A store that matches every scanned file, so only a force widens the set. */
const CURRENT = new Map<string, string | null>([
  ["src/app.ts", "h1"],
  ["src/view.tsx", "h2"],
  ["lib/worker.rb", "h3"],
  ["bin/deploy.sh", "h4"],
]);

function pathsFrom(runFileBatch: ReturnType<typeof vi.fn>): string[] {
  return runFileBatch.mock.calls.flatMap((call) => call[2] as string[]);
}

describe("EnrichmentCoordinator.runRepairPass — language scope", () => {
  it("re-extracts only the selected language's files under a force", async () => {
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(CURRENT),
      undefined,
      makeExecutor(runFileBatch),
    );

    const repaired = await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, ["codegraph"], ["typescript"]);

    expect(repaired).toBe(2);
    expect(pathsFrom(runFileBatch).sort()).toEqual(["src/app.ts", "src/view.tsx"]);
  });

  it("carries every extension of a multi-language selection", async () => {
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(CURRENT),
      undefined,
      makeExecutor(runFileBatch),
    );

    await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, ["codegraph"], ["typescript", "ruby"]);

    expect(pathsFrom(runFileBatch)).toContain("lib/worker.rb");
    expect(pathsFrom(runFileBatch)).not.toContain("bin/deploy.sh");
  });

  it("leaves the whole corpus in scope when no selection is given", async () => {
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(CURRENT),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, ["codegraph"])).toBe(4);
  });

  it("treats an empty selection as no restriction, not as an empty match", async () => {
    // Same reading `scrollStoredChunks` gives it. A restriction selecting
    // nothing finishes cleanly and is indistinguishable from a completed run.
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(CURRENT),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, ["codegraph"], [])).toBe(4);
  });

  it("never prunes the unselected languages' rows as orphans", async () => {
    // The eligible map feeds BOTH lists. Narrowing it instead of the repair
    // list would report every ruby and bash row as no longer eligible.
    const handleDeletedPaths = vi.fn();
    const persisted = new Map<string, string | null>([...CURRENT, ["gone/old.ts", "h9"]]);
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(persisted, handleDeletedPaths),
      undefined,
      makeExecutor(runFileBatch),
    );

    await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, ["codegraph"], ["typescript"]);

    expect(handleDeletedPaths).toHaveBeenCalledTimes(1);
    expect(handleDeletedPaths.mock.calls[0][0]).toEqual(["gone/old.ts"]);
  });

  it("narrows a drift-driven repair too, not just a forced one", async () => {
    // The selection scopes the RUN, not the force. A drifted ruby file on a
    // typescript-only run heals on the next unrestricted pass; re-resolving it
    // here is exactly the cost the flag exists to avoid.
    const stale = new Map<string, string | null>([
      ["src/app.ts", "old"],
      ["lib/worker.rb", "old"],
    ]);
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(qdrant, graphProvider(stale), undefined, makeExecutor(runFileBatch));

    await coordinator.runRepairPass("code_x_v1", "/repo", MIXED, undefined, ["typescript"]);

    expect(pathsFrom(runFileBatch)).not.toContain("lib/worker.rb");
    expect(pathsFrom(runFileBatch)).toContain("src/app.ts");
  });

  it("matches the extension case-insensitively", async () => {
    const scanned = new Map([["src/Legacy.TS", "h1"]]);
    const runFileBatch = vi.fn().mockResolvedValue(new Map());
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      graphProvider(new Map<string, string | null>([["src/Legacy.TS", "h1"]])),
      undefined,
      makeExecutor(runFileBatch),
    );

    expect(await coordinator.runRepairPass("code_x_v1", "/repo", scanned, ["codegraph"], ["typescript"])).toBe(1);
  });
});
