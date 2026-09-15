/**
 * An index operation on a collection that is already being indexed is REJECTED
 * (bd tea-rags-mcp-62pgi), exercised through a real `IngestFacade` — the entry MCP
 * `index_codebase` and the CLI worker share — with its real `IndexingOps`,
 * pipelines, chunker pool and coordinator, enriching through the worker pool and
 * a codegraph daemon (see the harness header).
 *
 * `indexing-ops-concurrent-run.test.ts` pins the decision against mocked
 * enrichment and a hand-written marker map. What only real collaborators show is
 * WHICH evidence a real run leaves for the check to find: its detached completion,
 * the `_run` pointer and heartbeats it really writes, and the window before it has
 * written anything at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INDEXING_METADATA_ID } from "../../../../../../../src/core/contracts/constants.js";
import { IndexingAlreadyInProgressError } from "../../../../../../../src/core/domains/ingest/errors.js";
import { STALE_INDEXING_THRESHOLD_MS } from "../../../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";
import {
  startIngestLifecycleHarness,
  type IngestLifecycleHarness,
} from "./__helpers__/enrichment-lifecycle-harness.js";

const REJECTION =
  /already running — in the background or in another session\. Retry after it finishes; get_index_status shows its progress\./;

/** Past both the indexing-marker (10 min) and the enrichment-progress (2 min) staleness thresholds. */
const agedPastStaleThreshold = (): string => new Date(Date.now() - STALE_INDEXING_THRESHOLD_MS - 60_000).toISOString();

/**
 * A timestamp strictly after this process's own last operation let go of the
 * collection: evidence at or before that instant is discounted as its own.
 */
const freshFromAnotherSession = (): string => new Date(Date.now() + 1_000).toISOString();

describe("IndexingOps#run rejects an operation while the collection is being indexed — real facade, pipelines and enrichment", () => {
  let harness: IngestLifecycleHarness;

  beforeEach(async () => {
    harness = await startIngestLifecycleHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function indexAndSettle(): Promise<void> {
    await harness.ingest.indexCodebase(harness.repoRoot);
    await harness.ingest.whenEnrichmentComplete();
  }

  it("rejects one of two operations started together, before either has written any marker", async () => {
    await indexAndSettle();

    // Both resolve the path asynchronously before claiming, so which one claims
    // first is up to the event loop; exactly one of them may run.
    const outcomes = await Promise.allSettled([
      harness.ingest.indexCodebase(harness.repoRoot),
      harness.ingest.indexCodebase(harness.repoRoot),
    ]);

    const rejected = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    const completed = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(IndexingAlreadyInProgressError);
    expect((rejected[0] as Error).message).toMatch(REJECTION);
    expect(completed).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("rejects an operation while the previous one's background enrichment is in flight, and admits one once it settles", async () => {
    const finalize = harness.executor.holdNextFinalize();
    await harness.ingest.indexCodebase(harness.repoRoot);
    // The operation returned after embeddings; its enrichment is provably still running.
    await finalize.reached;

    const whileEnriching = harness.ingest.indexCodebase(harness.repoRoot);
    await expect(whileEnriching).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    await expect(whileEnriching).rejects.toThrow(REJECTION);

    finalize.release();
    await harness.ingest.whenEnrichmentComplete();
    await expect(harness.ingest.indexCodebase(harness.repoRoot)).resolves.toMatchObject({ status: "completed" });
  });

  /** Write into the indexed collection's metadata point as another session would. */
  async function writeMetadataFromAnotherSession(payload: Record<string, unknown>, key?: string): Promise<void> {
    const collection = await harness.indexedCollection();
    await harness.qdrant.batchSetPayload(collection, [
      { points: [INDEXING_METADATA_ID], payload, ...(key ? { key } : {}) },
    ]);
  }

  it("rejects while another session's indexing marker is fresh, and admits once its heartbeat is stale", async () => {
    await indexAndSettle();

    // Another session is building: an unfinished indexing marker with a fresh heartbeat.
    const building = freshFromAnotherSession();
    await writeMetadataFromAnotherSession({ indexingComplete: false, startedAt: building, lastHeartbeat: building });
    const whileBuilding = harness.ingest.indexCodebase(harness.repoRoot);
    await expect(whileBuilding).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    await expect(whileBuilding).rejects.toThrow(REJECTION);

    // ...and that session crashed: its heartbeat aged out, so it no longer locks the project.
    const crashed = agedPastStaleThreshold();
    await writeMetadataFromAnotherSession({ startedAt: crashed, lastHeartbeat: crashed });
    await expect(harness.ingest.indexCodebase(harness.repoRoot)).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects while another session's enrichment run is live, and admits once its progress is stale", async () => {
    await indexAndSettle();

    // Another session's enrichment run: a `_run` pointer whose provider owes terminal markers.
    const enriching = freshFromAnotherSession();
    await writeMetadataFromAnotherSession(
      { runId: "other-session", startedAt: enriching, lastProgressAt: enriching, providers: ["codegraph.symbols"] },
      "enrichment._run",
    );
    const whileEnriching = harness.ingest.indexCodebase(harness.repoRoot);
    await expect(whileEnriching).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);
    await expect(whileEnriching).rejects.toThrow(REJECTION);

    const stalled = agedPastStaleThreshold();
    await writeMetadataFromAnotherSession(
      { runId: "other-session", startedAt: stalled, lastProgressAt: stalled, providers: ["codegraph.symbols"] },
      "enrichment._run",
    );
    await expect(harness.ingest.indexCodebase(harness.repoRoot)).resolves.toMatchObject({ status: "completed" });
  });
});
