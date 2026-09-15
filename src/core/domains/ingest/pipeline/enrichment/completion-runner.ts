/**
 * CompletionRunner — final sequence. Where a later step depends on an earlier
 * one, the earlier step RETURNS a value the later step REQUIRES, so a reorder
 * does not compile (bd tea-rags-mcp-39xca.5):
 *  1. drain fileWork (streaming file applies)
 *  2. finalize-file pass: provider.finalizeSignals → applyFinalize (codegraph)
 *  3. backfill per ctx (skips defer-providers), overlapping 2
 *     → `OutOfWindowBackfillOutcome`
 *  4. markFileFinal per ctx (degraded on residual file-unenriched)
 *     ← `OutOfWindowBackfillOutcome`
 *  5. aggregate metrics
 *  6. drain chunkWork (git streaming)
 *  7. deferred-chunk pass: chunkPhase.runDeferredChunk (codegraph)
 *     → `DeferredChunkPassOutcome`
 *  7b. codegraph payload heal: rewrite points OUTSIDE this run's chunk map
 *      whose derived signals moved (bd tea-rags-mcp-a2ddb)
 *      ← `DeferredChunkPassOutcome` → `CodegraphHealStepOutcome`
 *  8. markChunkFinal per ctx ← `CodegraphHealStepOutcome`
 *  9. re-fire stats callback if backfill wrote overlays
 *
 * A step that throws does not leave the run without a verdict: before the
 * original error is rethrown, every level whose terminal marker this run has
 * not yet written is settled as `failed` for every provider, carrying the
 * error's message (bd tea-rags-mcp-39xca.11). Which levels are already written
 * is `CompletionTerminalMarkerProgress`, returned by steps 4 and 8.
 */

import type { CodegraphPass1FileAggregates } from "../../../../contracts/types/codegraph.js";
import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentBackfiller } from "./backfiller.js";
import type { ChunkPhase, ChunkPhaseMetrics } from "./chunk-phase.js";
import type { CodegraphPayloadHealRunner } from "./codegraph-payload-heal.js";
import type { FilePhase } from "./file-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ChunkFinalInput, EnrichmentProvider, ProviderContext } from "./types.js";

export interface CompletionRunnerDeps {
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  applier: EnrichmentApplier;
  markerStore: EnrichmentMarkerStore;
  executor: EnrichmentExecutor;
  /**
   * Rewrites `codegraph.symbols.*` for points this run never reached but whose
   * derived signals moved anyway (bd tea-rags-mcp-a2ddb). Undefined when
   * codegraph is disabled — the step is then skipped entirely, not stubbed.
   */
  codegraphHeal?: CodegraphPayloadHealRunner;
}

/**
 * Reader for the per-provider, per-level "unenriched chunks" count persisted
 * with the final marker. Owned by Coordinator (which holds the optional
 * EnrichmentRecovery) — passed as a callback so CompletionRunner stays
 * decoupled from Recovery. Resolves to 0 when recovery is unavailable.
 */
export type UnenrichedReader = (coll: string, provider: EnrichmentProvider, level: "file" | "chunk") => Promise<number>;

/**
 * What the out-of-window backfill (step 3) left behind. The terminal FILE
 * markers require it, because the unenriched counts they persist must reflect
 * post-backfill state.
 */
export interface OutOfWindowBackfillOutcome {
  /** Whether any missed files existed — drives the post-backfill stats re-fire. */
  readonly occurred: boolean;
}

/**
 * What the deferred chunk pass (step 7) took over this run. The codegraph heal
 * builds its skip set from this value and from nothing else.
 *
 * `noDeferringProvider` is not the same as an empty `wholeFileRelPaths`, and the
 * distinction is the heal's gate: a run carrying no codegraph provider (a
 * provider-scoped recompute of some other trajectory) has no business healing
 * codegraph payload, while a codegraph run that happened to change no file
 * still has a whole-graph diff worth applying — that is the entire defect.
 */
export type DeferredChunkPassOutcome =
  | { readonly kind: "noDeferringProvider" }
  | {
      readonly kind: "deferred";
      /**
       * Every relPath in a deferring provider's accumulated chunk map, read
       * before the pass clears that map — read after, it is empty, and the heal
       * would rewrite every file this run already wrote. Paths seeded from a
       * recovery handoff are excluded: they carry only the chunks recovery found
       * owed, so the pass does not rewrite the rest of that file and the heal
       * still has to (bd tea-rags-mcp-fxio5).
       */
      readonly wholeFileRelPaths: ReadonlySet<string>;
    };

/**
 * How the codegraph payload heal (step 7b) settled. The terminal CHUNK markers
 * require it: their `wait: true` write is the barrier draining the heal's
 * `wait: false` payload writes, so they must not be written before it.
 */
export type CodegraphHealStepOutcome =
  /** No heal runner is wired (codegraph off), or no provider in the run defers chunk enrichment. */
  | { readonly kind: "notApplicable" }
  | { readonly kind: "healed"; readonly pointsRewritten: number; readonly filesTouched: number }
  /** Best-effort: the baseline was not refreshed, so the diff stands for the next run to retry. */
  | { readonly kind: "failed"; readonly error: string };

/**
 * Which terminal marker levels THIS run has written, as far as `run` got. A
 * completion that throws settles every level not covered here as `failed`
 * (bd tea-rags-mcp-39xca.11).
 *
 * A level counts as written only once its whole marker step returned. A marker
 * step that throws part-way (its unenriched read failed after an earlier
 * provider's write landed) leaves the level unwritten, so the failure settles
 * it `failed` for every provider — the run failed, and a marker set that is
 * terminal for some providers and absent for others would read as still running.
 */
type CompletionTerminalMarkerProgress =
  | { readonly kind: "noLevelWritten" }
  /** Step 4 returned; the chunk level (step 8) is still owed. */
  | { readonly kind: "fileLevelWritten" }
  /** Step 8 returned; nothing is owed. */
  | { readonly kind: "allLevelsWritten" };

/** Levels a failed completion still owes, in the order the success path writes them. */
function unwrittenTerminalLevels(progress: CompletionTerminalMarkerProgress): readonly ("file" | "chunk")[] {
  switch (progress.kind) {
    case "noLevelWritten":
      return ["file", "chunk"];
    case "fileLevelWritten":
      return ["chunk"];
    case "allLevelsWritten":
      return [];
  }
}

export class CompletionRunner {
  /**
   * Provider keys whose persisted pass-1 aggregate read failed THIS run
   * (bd tea-rags-mcp-weno4). The read is best-effort, but without the injected
   * rows the codegraph barrier either reads the store itself or, when that read
   * fails too, resolves against a batch-scoped registry — a degraded run whose
   * terminal FILE marker must say so, not stderr alone. Per RUN: the coordinator
   * holds one runner across runs, so `run` clears this before anything adds to it.
   */
  private readonly pass1AggregateReadFailures = new Set<string>();

  constructor(private readonly deps: CompletionRunnerDeps) {}

  /**
   * Time one step of the serial tail and report it.
   *
   * This sequence is the last thing a run does, after every overlap has been
   * exhausted, so its cost is wall-clock one-for-one. It used to emit nothing:
   * two taxdome force-reindexes left 121 s and 261 s of silence between the
   * final DEFERRED pass and ALL_COMPLETE, unattributable to any step. Reported
   * on the failure path too — a step that threw still consumed its time.
   *
   * A step that REQUIRES an earlier step's outcome calls this from inside its
   * own body, so `run` hands it that outcome at a direct call site. Passed into
   * a `stepBody` closure instead, a reordered use still compiles — TypeScript
   * does not report use-before-declaration inside a nested function.
   */
  private async timedStep<T>(step: string, stepBody: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await stepBody();
    } finally {
      pipelineLog.enrichmentPhase("COMPLETION_STEP", { step, durationMs: Date.now() - startedAt });
    }
  }

  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: UnenrichedReader,
    runStartedAt = "",
    runId = "",
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase } = this.deps;
    const readUnenriched: UnenrichedReader = unenrichedReader ?? (async () => 0);
    // Run-scoped, and this is the only run-start seam the runner has — run 2 must
    // not inherit run 1's failed read (bd tea-rags-mcp-weno4).
    this.pass1AggregateReadFailures.clear();

    // Which terminal levels are already written — read only by the failure path
    // below (bd tea-rags-mcp-39xca.11).
    let terminalMarkers: CompletionTerminalMarkerProgress = { kind: "noLevelWritten" };
    try {
      // 1. drain prefetch (no-op) + drain streaming fileWork
      await filePhase.awaitPrefetch();
      await filePhase.drain();

      // 2‖3 OVERLAP: the out-of-window file backfill (re-enrich of files the 12mo
      // streaming window missed — the serial tail's dominant cost) depends only on
      // the missed set, now stable after the drain above, and writes a DISJOINT
      // payload subtree (`git.*`) to Qdrant — independent of the codegraph finalize
      // below (DuckDB `cg_*` + `codegraph.*` Qdrant keys) and of the shared applier
      // state (only git miss-tracks; codegraph defers, so `markBackfilled` races
      // nothing the finalize pass touches). Kick it off HERE so its git-blame runs
      // concurrently with the codegraph resolve/SCC/PageRank finalize, collapsing
      // the tail from finalize+backfill to max(finalize, backfill). Awaited below,
      // before the terminal file markers read post-backfill unenriched counts.
      // `backfiller.runFor` is internally try/caught (never rejects), so the
      // in-flight promise can't surface an unhandled rejection before the await.
      const backfillPromise = this.runBackfills(coll, contexts, runStartedAt);

      // 2. finalize-file pass — deferred whole-repo FILE overlays (codegraph graph
      //    metrics) read back after the run sink finishes, applied by the
      //    accumulated chunkMap. git's finalizeSignals returns an empty map.
      await this.timedStep("fileFinalize", async () => this.applyFileFinalize(coll, contexts));

      // 3. await the backfill kicked off before the finalize pass (see 2‖3 above).
      const backfill = await this.timedStep("backfillAwait", async () => backfillPromise);

      // 4. markFileFinal per ctx — reconcile to degraded on residual file-unenriched.
      //    Requires the backfill's outcome, so it cannot read pre-backfill counts.
      terminalMarkers = await this.markFileTerminals(coll, contexts, readUnenriched, runId, backfill);

      // 5. aggregate metrics
      const metrics = this.buildMetrics(contexts, startTime);

      // 6. drain chunkWork (git streaming)
      // Heartbeats now fire at the applier apply-site (EnrichmentApplier.onApply →
      // coordinator.maybeHeartbeat), covering every apply path uniformly. The plain
      // drain() here no longer needs to thread onProgress per-settle.
      await this.timedStep("chunkDrain", async () => chunkPhase.drain());

      // 7. deferred-chunk pass — codegraph buildChunkSignals against the finished
      //    graph with the full accumulated chunkMap, applied via applyChunkSignals.
      //    Returns the paths it owned; that value is the heal's only skip-set input.
      //
      // applyChunkSignals fires onApply → maybeHeartbeat when batches land, so
      // lastProgressAt advances during the deferred pass without a separate seam
      // here. The previously-tracked limitation (tea-rags-mcp-xlhu) about the
      // codegraph.chunk phase potentially reporting "stalled" during a long
      // PageRank/resolve pass is resolved: the applier-site hook covers it.
      const deferredPass = await this.timedStep("deferredChunk", async () => this.runDeferredChunkPass(coll, contexts));

      // 7b. codegraph payload heal — the run's chunk map covers the files that
      //     CHANGED; these are the ones that did not, and whose fanIn / fanOut /
      //     pageRank moved because the graph around them did. Times itself, and
      //     only when it applies.
      const codegraphHeal = await this.runCodegraphHeal(coll, deferredPass, runStartedAt);

      const finalChunkMetrics = chunkPhase.getMetrics();
      metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

      // 8. markChunkFinal per ctx — requires the heal's outcome (see 7b).
      terminalMarkers = await this.markChunkTerminals(
        coll,
        contexts,
        readUnenriched,
        runId,
        finalChunkMetrics,
        codegraphHeal,
      );

      // 9. Re-fire stats callback if backfill wrote post-streaming overlays.
      // First fire (streaming end inside ChunkPhase) preserves the 896f343c
      // contract; this is a strictly-later second fire so listeners (StatsCache)
      // reflect post-backfill state. Listeners must be idempotent.
      if (backfill.occurred) {
        await chunkPhase.fireOnComplete(coll);
      }

      pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });
      return metrics;
    } catch (error) {
      await this.settleUnwrittenTerminalsAsFailed(coll, contexts, readUnenriched, runId, terminalMarkers, error);
      throw error;
    }
  }

  /**
   * Failure path of `run` — write a terminal `failed` marker, carrying the
   * completion error's message, for every provider at every level
   * `terminalMarkers` says this run still owes (bd tea-rags-mcp-39xca.11).
   *
   * Without it a completion that threw left only `enrichment._run` behind, and
   * the health mapper read the collection as in_progress / stalled with no cause.
   *
   * Best-effort on every axis, because the caller rethrows the completion error
   * and nothing here may replace it: an unenriched read that throws counts 0, and
   * a write that throws is logged and swallowed, so one bad write does not cost
   * the other providers their marker. Durations are the ones the success path
   * reports (prefetch per provider for file, the per-provider chunk span for
   * chunk), whatever they had reached when the step threw.
   */
  private async settleUnwrittenTerminalsAsFailed(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    readUnenriched: UnenrichedReader,
    runId: string,
    terminalMarkers: CompletionTerminalMarkerProgress,
    completionError: unknown,
  ): Promise<void> {
    const { filePhase, chunkPhase, applier, markerStore } = this.deps;
    const errorMessage = completionError instanceof Error ? completionError.message : String(completionError);
    for (const level of unwrittenTerminalLevels(terminalMarkers)) {
      for (const ctx of contexts.values()) {
        try {
          const unenrichedChunks = await this.readUnenrichedOrZero(readUnenriched, coll, ctx.provider, level);
          if (level === "file") {
            await markerStore.markFileFinal(coll, ctx.key, {
              runId,
              status: "failed",
              durationMs: filePhase.getPrefetchDurationMs(ctx.key),
              unenrichedChunks,
              matchedFiles: applier.matchedFiles,
              missedFiles: applier.missedFiles,
              ignoredFiles: applier.ignoredFiles,
              errorMessage,
            });
          } else {
            await markerStore.markChunkFinal(coll, ctx.key, {
              runId,
              status: "failed",
              durationMs: chunkPhase.getMetrics().providerDurationsMs[ctx.key] ?? 0,
              unenrichedChunks,
              errorMessage,
            });
          }
        } catch (err) {
          pipelineLog.enrichmentPhase("COMPLETION_FAILURE_MARKER_FAILED", {
            collection: coll,
            provider: ctx.key,
            level,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /** The failure path's unenriched count: 0 when the read throws, synchronously or not. */
  private async readUnenrichedOrZero(
    readUnenriched: UnenrichedReader,
    coll: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
  ): Promise<number> {
    try {
      return await readUnenriched(coll, provider, level);
    } catch {
      return 0;
    }
  }

  /**
   * Step 2 — read back each provider's deferred whole-repo FILE overlays and
   * apply them through the accumulated chunkMap. Runs CONCURRENTLY with the
   * out-of-window backfill; see the 2‖3 note in `run`.
   */
  private async applyFileFinalize(coll: string, contexts: ReadonlyMap<string, ProviderContext>): Promise<void> {
    const { filePhase, chunkPhase, executor } = this.deps;
    for (const ctx of contexts.values()) {
      // Method-existence is no longer guarded here: runFinalize returns an
      // empty map when the provider has no finalizeSignals (executor smooths
      // over the optional method), and the size-zero branch below skips the
      // apply step — equivalent to the old `if (!finalizeSignals) continue`.
      if (filePhase.hasPrefetchFailed(ctx.key)) continue;
      const root = ctx.effectiveRoot ?? "";
      // Cross-pass end-of-file-phase flush: the MAIN-thread provider instance
      // buffered node defs via `acceptExtraction` and flushed only complete
      // cadence batches during embedding — its `N mod cadence` remainder is still
      // buffered. `runFinalize` dispatches to a SEPARATE worker instance whose own
      // buffer is empty, so flush the MAIN remainder HERE (on `ctx.provider`, the
      // main instance) and await it BEFORE the worker resolves + upserts edges —
      // nodes-before-edges across the instance boundary. Mirrors the cross-pass
      // `beginExtractionRun` call in `coordinator.beginRun`. No-op off cross-pass
      // (incremental finalize runs on this same instance and owns its own flush)
      // and for providers without the seam (git omits it).
      if (filePhase.crossPassEnabled) await ctx.provider.endExtractionRun?.(coll || undefined);
      // bd tea-rags-mcp-weno4 — read the persisted pass-1 aggregate slices HERE,
      // on the MAIN instance, and inject them into the finalize below. This
      // instance's pool replaces a daemon from another build or one lacking a
      // required op; the worker `runFinalize` dispatches to cannot respawn and,
      // since 39xca.4, refuses such a daemon with `CodegraphDaemonBuildSkewError`
      // rather than silently degrading the znxg8 repair. Providers with no
      // pass-1 store (git) omit the method.
      const pass1Aggregates = await this.readPass1Aggregates(coll, ctx);
      // yl9tv Task 5b — thread crossPass so the codegraph worker's finalize
      // drains the main-written input spill (pass-1) before resolving (pass-2),
      // instead of relying on a streamFileBatch that no-opped. Other providers
      // (git) ignore the flag.
      const fileOverlays = await executor.runFinalize(ctx.provider, root, {
        collectionName: coll || undefined,
        crossPass: filePhase.crossPassEnabled,
        // bd tea-rags-mcp-xpmwg — always explicit on this path, so a pipeline
        // run can never fall back to the provider's direct-caller default.
        runCoverage: filePhase.runCoverage,
        // The run's per-file hashes, stamped onto the rows pass-2 writes (bd
        // tea-rags-mcp-o317j). Finalize is the one dispatch every ingest path
        // makes, and pass-2 — the only writer of those rows — runs inside it, so
        // this is what keeps a first index / `--force` from persisting NULL and
        // making the next run repair the whole corpus. Providers that keep no
        // per-file store (git) ignore it.
        contentHashes: filePhase.runContentHashes,
        ...(pass1Aggregates ? { pass1Aggregates } : {}),
      });
      if (fileOverlays.size > 0) {
        await filePhase.applyFinalize(coll, ctx, fileOverlays, chunkPhase.getDeferredChunkMap(ctx.key));
      }
    }
    await filePhase.drain();
  }

  /**
   * Step 7b — diff the derived codegraph signals against the previous run's
   * baseline, rewrite the points that moved, record the new baseline.
   *
   * The skip set is exactly `deferredPass.wholeFileRelPaths`: the files this
   * run's deferred chunk pass already rewrote with the same builders. Not
   * applicable — and not timed or logged — when no heal runner is wired or no
   * provider in the run defers chunk enrichment.
   *
   * Best-effort, like the out-of-window backfill and the pass-1 aggregate read:
   * a payload repair that fails is a run that healed nothing, not a run that
   * failed. The baseline is refreshed only on success (inside the runner), so an
   * unhealed diff still stands for the next run to retry.
   */
  async runCodegraphHeal(
    coll: string,
    deferredPass: DeferredChunkPassOutcome,
    runStartedAt: string,
  ): Promise<CodegraphHealStepOutcome> {
    const healer = this.deps.codegraphHeal;
    if (!healer || deferredPass.kind === "noDeferringProvider") return { kind: "notApplicable" };
    const skipRelPaths = deferredPass.wholeFileRelPaths;
    return this.timedStep("codegraphHeal", async (): Promise<CodegraphHealStepOutcome> => {
      try {
        const { pointsRewritten, filesTouched } = await healer.run(coll, skipRelPaths, runStartedAt || undefined);
        if (pointsRewritten > 0 || filesTouched > 0) {
          pipelineLog.enrichmentPhase("CODEGRAPH_PAYLOAD_HEAL", { collection: coll, pointsRewritten, filesTouched });
        }
        return { kind: "healed", pointsRewritten, filesTouched };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        pipelineLog.enrichmentPhase("CODEGRAPH_PAYLOAD_HEAL_FAILED", { collection: coll, error });
        return { kind: "failed", error };
      }
    });
  }

  /**
   * Read one provider's persisted pass-1 aggregate slices for this run, or
   * record the failure and return undefined (bd tea-rags-mcp-weno4).
   *
   * Modelled on `EnrichmentCoordinator#runRepairPass`'s handling of
   * `readPersistedFileHashes`: a store we cannot read must not abort the run, and
   * staying quiet about it would hide a permanently broken provider, so it goes
   * to the pipeline log. Unlike the repair, the loss is also folded into the
   * terminal FILE marker — see `pass1AggregateReadFailures`.
   *
   * A provider that offers no such store (git) returns undefined with nothing
   * recorded: absence is not a failure.
   */
  private async readPass1Aggregates(
    coll: string,
    ctx: ProviderContext,
  ): Promise<readonly CodegraphPass1FileAggregates[] | undefined> {
    const read = ctx.provider.readPersistedPass1Aggregates;
    if (!read) return undefined;
    try {
      return await read.call(ctx.provider, coll);
    } catch (err) {
      this.pass1AggregateReadFailures.add(ctx.key);
      pipelineLog.enrichmentPhase("PASS1_AGGREGATE_READ_FAILED", {
        provider: ctx.key,
        collection: coll,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Report a marker step's two halves apart.
   *
   * A marker step does exactly two things: scan for residual unenriched points,
   * and write the terminal marker. The write is `wait: true`, which makes it a
   * BARRIER on every `wait: false` payload write the preceding apply step
   * queued — so a marker step's wall clock is mostly not its own work. The
   * unenriched scans measure ~6ms on taxdome since the v14 payload indexes while
   * the steps measured 11.6s and 11.4s; without this split that gap is
   * unattributable and invites re-optimising a scan that is already free.
   */
  private reportMarkerSplit(step: string, scanMs: number, writeMs: number): void {
    pipelineLog.enrichmentPhase("COMPLETION_MARKER_SPLIT", { step, scanMs, writeMs });
  }

  /**
   * Step 4 — terminal FILE marker per provider. Reads post-backfill unenriched
   * counts. `_backfill` is not read: requiring it is what keeps this step from
   * running before the backfill settles. Times itself (see `timedStep`).
   */
  private async markFileTerminals(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    readUnenriched: UnenrichedReader,
    runId: string,
    _backfill: OutOfWindowBackfillOutcome,
  ): Promise<{ readonly kind: "fileLevelWritten" }> {
    await this.timedStep("fileMarkers", async () => {
      const { filePhase, applier, markerStore } = this.deps;
      let scanMs = 0;
      let writeMs = 0;
      for (const ctx of contexts.values()) {
        const scanStartedAt = Date.now();
        const fileUnenriched = await readUnenriched(coll, ctx.provider, "file");
        scanMs += Date.now() - scanStartedAt;
        const writeStartedAt = Date.now();
        // A failed pass-1 aggregate read (bd tea-rags-mcp-weno4) degrades the run
        // exactly as residual unenriched points do: everything was written, but the
        // codegraph barrier resolved against a batch-scoped registry, so the entry
        // edges this run produced are not the ones a healthy run would produce. It
        // ranks BELOW `failed` — the prefetch failure is still the stronger verdict.
        const fileStatus = filePhase.hasPrefetchFailed(ctx.key)
          ? "failed"
          : fileUnenriched > 0 || this.pass1AggregateReadFailures.has(ctx.key)
            ? "degraded"
            : "completed";
        await markerStore.markFileFinal(coll, ctx.key, {
          runId,
          status: fileStatus,
          durationMs: filePhase.getPrefetchDurationMs(ctx.key),
          unenrichedChunks: fileUnenriched,
          matchedFiles: applier.matchedFiles,
          missedFiles: applier.missedFiles,
          ignoredFiles: applier.ignoredFiles,
          // Carry the prefetch failure cause into the TERMINAL marker — this
          // write used to overwrite markPrefetchFailed's errorMessage, leaving
          // `failed` with no cause anywhere (worker stderr is detached).
          ...(fileStatus === "failed" ? { errorMessage: filePhase.getPrefetchError(ctx.key) } : {}),
        });
        writeMs += Date.now() - writeStartedAt;
      }
      this.reportMarkerSplit("fileMarkers", scanMs, writeMs);
    });
    return { kind: "fileLevelWritten" };
  }

  /**
   * Step 5 (+5b) — snapshot the run's counters. Top-level fields stay
   * coordinator-owned and git-historical for back-compat; provider-specific
   * counters (codegraph extractedFiles, etc.) go under `byProvider`.
   *
   * `chunkChurnDurationMs` is a PRELIMINARY read here — the deferred-chunk pass
   * (step 7) still has to run, and `run` overwrites the field afterwards.
   */
  private buildMetrics(contexts: ReadonlyMap<string, ProviderContext>, startTime: number): EnrichmentMetrics {
    const { filePhase, chunkPhase, applier } = this.deps;
    const fileMetrics = filePhase.getMetrics();
    const chunkMetrics = chunkPhase.getMetrics();
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (startTime || Date.now()),
      matchedFiles: applier.matchedFiles,
      missedFiles: applier.missedFiles,
      missedPathSamples: [...applier.missedPathSamples],
    };

    let byProvider: Record<string, Record<string, unknown>> | undefined;
    for (const ctx of contexts.values()) {
      const providerMetrics = ctx.provider.getRunMetrics?.();
      if (!providerMetrics) continue;
      byProvider ??= {};
      byProvider[ctx.key] = providerMetrics;
    }
    if (byProvider) metrics.byProvider = byProvider;
    return metrics;
  }

  /**
   * Step 7 — codegraph buildChunkSignals against the finished graph, keyed by
   * the full accumulated chunkMap, and the paths that map covered.
   *
   * A provider's paths are read in the same iteration, BEFORE its
   * `runDeferredChunk` clears the map, and a prefetch-failed provider's paths
   * count even though its pass is skipped. See `DeferredChunkPassOutcome`.
   */
  async runDeferredChunkPass(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
  ): Promise<DeferredChunkPassOutcome> {
    const { filePhase, chunkPhase } = this.deps;
    let wholeFileRelPaths: Set<string> | undefined;
    for (const ctx of contexts.values()) {
      if (!ctx.provider.defersChunkEnrichment) continue;
      wholeFileRelPaths ??= new Set<string>();
      const cm = chunkPhase.getDeferredChunkMap(ctx.key);
      const seeded = chunkPhase.getSeededDeferredPaths(ctx.key);
      for (const relPath of cm.keys()) {
        if (!seeded.has(relPath)) wholeFileRelPaths.add(relPath);
      }
      if (filePhase.hasPrefetchFailed(ctx.key)) continue;
      if (cm.size > 0) {
        await chunkPhase.runDeferredChunk(coll, ctx, ctx.effectiveRoot ?? "", cm);
      }
    }
    return wholeFileRelPaths ? { kind: "deferred", wholeFileRelPaths } : { kind: "noDeferringProvider" };
  }

  /**
   * Step 8 — terminal CHUNK marker per provider. `_codegraphHeal` is not read:
   * requiring it is what keeps this `wait: true` write — the barrier on the
   * heal's `wait: false` payload writes — from landing before the heal settles.
   * Times itself (see `timedStep`).
   */
  private async markChunkTerminals(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    readUnenriched: UnenrichedReader,
    runId: string,
    finalChunkMetrics: ChunkPhaseMetrics,
    _codegraphHeal: CodegraphHealStepOutcome,
  ): Promise<{ readonly kind: "allLevelsWritten" }> {
    await this.timedStep("chunkMarkers", async () => {
      const { filePhase, chunkPhase, markerStore } = this.deps;
      let scanMs = 0;
      let writeMs = 0;
      for (const ctx of contexts.values()) {
        const scanStartedAt = Date.now();
        const chunkUnenriched = await readUnenriched(coll, ctx.provider, "chunk");
        scanMs += Date.now() - scanStartedAt;
        const writeStartedAt = Date.now();
        let chunkStatus: ChunkFinalInput["status"];
        if (filePhase.hasPrefetchFailed(ctx.key) || chunkPhase.hasChunkEnrichmentFailed(ctx.key)) {
          chunkStatus = "failed";
        } else if (chunkUnenriched > 0) {
          chunkStatus = "degraded";
        } else {
          chunkStatus = "completed";
        }
        await markerStore.markChunkFinal(coll, ctx.key, {
          runId,
          status: chunkStatus,
          // iqpuu: per-provider wall span — the marker no longer inherits the
          // cross-provider span (deferred codegraph used to stretch git's).
          durationMs: finalChunkMetrics.providerDurationsMs[ctx.key] ?? 0,
          unenrichedChunks: chunkUnenriched,
          ...(chunkStatus === "failed" ? { errorMessage: filePhase.getPrefetchError(ctx.key) } : {}),
        });
        writeMs += Date.now() - writeStartedAt;
      }
      this.reportMarkerSplit("chunkMarkers", scanMs, writeMs);
    });
    return { kind: "allLevelsWritten" };
  }

  /**
   * Backfill file+chunk signals for every non-deferring provider's missed files.
   * Extracted so the completion sequence can OVERLAP it with the codegraph
   * finalize pass (see `run` step 2‖3). Skips defer-providers (codegraph) — they
   * have no miss-tracking; their overlays come from `applyFinalize`. Reports
   * whether any missed files existed (drives the post-backfill stats re-fire).
   * `backfiller.runFor` is internally try/caught, so this never rejects.
   */
  private async runBackfills(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    runStartedAt: string,
  ): Promise<OutOfWindowBackfillOutcome> {
    const { filePhase, backfiller, applier } = this.deps;
    if (applier.getMissedFileChunks().size === 0) return { occurred: false };
    for (const ctx of contexts.values()) {
      if (filePhase.hasPrefetchFailed(ctx.key) || ctx.provider.defersChunkEnrichment) continue;
      await backfiller.runFor(coll, ctx, runStartedAt);
    }
    return { occurred: true };
  }
}
