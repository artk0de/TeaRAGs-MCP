/**
 * The dense floor (bd tea-rags-mcp-xi2r9, WTO-5): the working tree's delta rows
 * ranked by their own dense vectors. Without it every ranked query on a dirty
 * tree loses the touched files — their base rows are excluded and the delta
 * rows had no vector to rank by.
 *
 * A delta row's vector comes from, in order:
 *
 *   1. the base point of the same file whose stored `content` is byte-identical
 *      (an unchanged chunk of a modified file — ingest embeds exactly
 *      `content`, so the stored vector is exact). Candidates are the touched
 *      file's base points spanning as many lines as the row, read once per
 *      view (`WorkingTreeView#readTouchedBasePoints`), then fetched by id with
 *      their content and vector;
 *   2. the working-tree chunk store, beside the file's rows (same entry, same
 *      retention), keyed by the chunk content's sha256 and the model;
 *   3. the embedding provider the base index was built with.
 *
 * Only changed chunk content is ever embedded, and one content once per
 * process however many views ask (single-flight, then a bounded memory cache).
 * Vectors reach the store as they resolve — once after the store and base-point
 * stage, then after each provider batch for the files it advanced, embedded
 * file by file — so a process that exits mid-warm keeps what it got.
 * `warm` starts all of it at once and returns a reader that waits at most the
 * time it is given: a row still without a vector is reported as pending (or
 * with the provider's failure), never thrown — the answer is made without it.
 */

import { createHash } from "node:crypto";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type {
  WorkingTreeBasePoint,
  WorkingTreeTouchedBasePointsReader,
} from "../../../contracts/types/working-tree.js";
import { cosine } from "../../../infra/vector-math.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { WorkingTreeEmbeddingMalformedError } from "../errors.js";
import type { ExploreResult } from "../strategies/types.js";
import type { WorkingTreeChunkStore, WorkingTreeChunkStoreKey } from "./chunk-store.js";

/** How long a ranked query waits for the delta rows' vectors before it answers without the missing ones. */
export const WORKING_TREE_DENSE_WAIT_MS = 2_000;

/** What a dense reader had when it answered. */
export interface WorkingTreeDenseVectors {
  /** Dense vector by delta row id (`String(row.id)`). */
  vectors: ReadonlyMap<string, readonly number[]>;
  /** Rows with content still without a vector: they stay out of the dense leg. */
  pending: number;
  /** The provider's failure, when embedding the pending rows failed. */
  failure?: string;
}

/** A view's access to its delta rows' vectors: wait at most `waitMs`. Never rejects. */
export type WorkingTreeDenseVectorReader = (waitMs: number) => Promise<WorkingTreeDenseVectors>;

export interface WorkingTreeDenseVectorRequest {
  /** The base index: where identical-content base points are read. */
  collectionName: string;
  /** The view's delta rows, as the chunk layer yields them. */
  rows: readonly ScrollChunk[];
  /** The chunk-store entry of each file's rows — where their vectors are kept. */
  storeKeys?: ReadonlyMap<string, WorkingTreeChunkStoreKey>;
  /** The view's one read of the touched files' base points. */
  readTouchedBasePoints?: WorkingTreeTouchedBasePointsReader;
}

export interface WorkingTreeDenseVectorSourceDeps {
  /** The provider the base index was embedded with — the query side's provider. */
  embeddings: Pick<EmbeddingProvider, "embedBatch" | "getModel">;
  /** Absent → no base-vector reuse. */
  qdrant?: Pick<QdrantManager, "retrieveDenseVectors">;
  /** Absent → vectors are not persisted across processes. */
  store?: Pick<WorkingTreeChunkStore, "getVectors" | "putVectors">;
  /** Contents whose vector is kept in memory; oldest evicted first. */
  memoryEntries?: number;
  /** Texts per provider call. */
  batchSize?: number;
}

/** ~6 KB per 768-d vector: a delta of 200 files' chunks several times over. */
const DEFAULT_MEMORY_ENTRIES = 4_096;
const DEFAULT_BATCH_SIZE = 64;

const contentOf = (row: ScrollChunk): string => (typeof row.payload.content === "string" ? row.payload.content : "");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const lineOf = (payload: Record<string, unknown> | undefined, key: "startLine" | "endLine"): number | undefined => {
  const value = payload?.[key];
  return typeof value === "number" ? value : undefined;
};
const spanOf = (payload: Record<string, unknown> | undefined): number | undefined => {
  const start = lineOf(payload, "startLine");
  const end = lineOf(payload, "endLine");
  return start === undefined || end === undefined ? undefined : end - start;
};
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

interface WantedRow {
  id: string;
  relativePath: string;
  content: string;
  contentSha256: string;
  span: number | undefined;
}

/** The mutable progress of one warm-up: what its reader snapshots. */
interface DenseWarmState {
  vectors: Map<string, readonly number[]>;
  failure?: string;
}

export class WorkingTreeDenseVectorSource {
  /** Vector by `model \0 content sha256`, oldest first. */
  private readonly memory = new Map<string, readonly number[]>();
  /** Embeds in flight by the same key: a second asker joins, never re-embeds. */
  private readonly inflight = new Map<string, Promise<readonly number[]>>();
  /** The last store write of each entry: the next write of that entry waits for it. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly memoryEntries: number;
  private readonly batchSize: number;

  constructor(private readonly deps: WorkingTreeDenseVectorSourceDeps) {
    this.memoryEntries = deps.memoryEntries ?? DEFAULT_MEMORY_ENTRIES;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Start resolving every row's vector now; the reader waits for them at most its `waitMs`. */
  warm(request: WorkingTreeDenseVectorRequest): WorkingTreeDenseVectorReader {
    const model = this.deps.embeddings.getModel();
    const wanted = wantedRows(request.rows);
    const state: DenseWarmState = { vectors: new Map() };
    const done = this.fill(request, model, wanted, state).catch((error: unknown) => {
      state.failure ??= messageOf(error);
    });
    const snapshot = (): WorkingTreeDenseVectors => ({
      vectors: new Map(state.vectors),
      pending: wanted.filter((row) => !state.vectors.has(row.id)).length,
      ...(state.failure ? { failure: state.failure } : {}),
    });
    return async (waitMs) => {
      await settleWithin(done, waitMs);
      return snapshot();
    };
  }

  private async fill(
    request: WorkingTreeDenseVectorRequest,
    model: string,
    wanted: readonly WantedRow[],
    state: DenseWarmState,
  ): Promise<void> {
    const memoryKey = (row: WantedRow): string => `${model}\0${row.contentSha256}`;
    const settle = (row: WantedRow, vector: readonly number[]): void => {
      state.vectors.set(row.id, vector);
      this.remember(memoryKey(row), vector);
    };
    const missing = (): WantedRow[] => wanted.filter((row) => !state.vectors.has(row.id));

    for (const row of wanted) {
      const hit = this.memory.get(memoryKey(row));
      if (hit) state.vectors.set(row.id, hit);
    }
    const fromStore = await this.readStored(request, model, missing());
    for (const row of missing()) {
      const vector = fromStore.get(row.contentSha256);
      if (vector) settle(row, vector);
    }
    if (missing().length > 0) {
      const reused = await this.readIdenticalBaseVectors(request, missing());
      for (const row of missing()) {
        const vector = reused.get(row.content);
        if (vector) settle(row, vector);
      }
    }
    // What memory and the base points gave is stored now: a process that exits
    // before the provider answers still leaves it for the next one.
    const gainedOutsideStore = new Set<string>();
    for (const row of wanted) {
      if (state.vectors.has(row.id) && !fromStore.has(row.contentSha256)) gainedOutsideStore.add(row.relativePath);
    }
    this.persist(request, model, wanted, state, gainedOutsideStore);
    const toEmbed = groupedByFile(missing());
    if (toEmbed.length === 0) return;
    await this.embed(model, toEmbed, (embedded) => {
      const gained = new Set<string>();
      for (const row of toEmbed) {
        const vector = state.vectors.has(row.id) ? undefined : embedded.get(row.contentSha256);
        if (!vector) continue;
        settle(row, vector);
        gained.add(row.relativePath);
      }
      this.persist(request, model, wanted, state, gained);
    });
  }

  /** Stored vectors of every file a missing row belongs to, by content sha256. */
  private async readStored(
    request: WorkingTreeDenseVectorRequest,
    model: string,
    rows: readonly WantedRow[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const { store } = this.deps;
    const found = new Map<string, readonly number[]>();
    if (!store || !request.storeKeys || rows.length === 0) return found;
    const paths = [...new Set(rows.map((row) => row.relativePath))];
    await Promise.all(
      paths.map(async (path) => {
        const key = request.storeKeys?.get(path);
        if (!key) return;
        const stored = await store.getVectors(request.collectionName, key, model).catch(() => undefined);
        for (const [sha, vector] of stored ?? []) found.set(sha, vector);
      }),
    );
    return found;
  }

  /**
   * Vectors of base points whose stored content a missing row repeats, by that
   * content. A failed read is a miss: the provider embeds those rows instead.
   */
  private async readIdenticalBaseVectors(
    request: WorkingTreeDenseVectorRequest,
    rows: readonly WantedRow[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    const found = new Map<string, readonly number[]>();
    const { qdrant } = this.deps;
    if (!qdrant || !request.readTouchedBasePoints) return found;
    try {
      const byPath = await request.readTouchedBasePoints();
      const ids = new Set<string | number>();
      for (const row of rows) {
        const points: readonly WorkingTreeBasePoint[] = byPath.get(row.relativePath) ?? [];
        for (const point of points) {
          if (row.span !== undefined && spanOf(point.payload) === row.span) ids.add(point.id);
        }
      }
      if (ids.size === 0) return found;
      const points = await qdrant.retrieveDenseVectors(request.collectionName, [...ids], ["content"]);
      for (const point of points) {
        const content = point.payload?.content;
        if (typeof content === "string" && point.vector) found.set(content, point.vector);
      }
    } catch {
      return found;
    }
    return found;
  }

  /**
   * Each missing content embedded once: a content already in flight is joined,
   * the rest goes to the provider in batches, in the order given. Every batch
   * (and every joined content) that answers is handed to `onEmbedded` as it
   * lands. Rejects with the provider's failure after every batch settled; what
   * did embed reaches the next asker through the memory cache either way.
   */
  private async embed(
    model: string,
    rows: readonly WantedRow[],
    onEmbedded: (vectors: ReadonlyMap<string, readonly number[]>) => void,
  ): Promise<void> {
    const bySha = new Map<string, string>();
    for (const row of rows) bySha.set(row.contentSha256, row.content);
    const waits = new Map<string, Promise<readonly number[]>>();
    const fresh: [string, string][] = [];
    for (const [sha, content] of bySha) {
      const joined = this.inflight.get(`${model}\0${sha}`);
      if (!joined) {
        fresh.push([sha, content]);
        continue;
      }
      waits.set(sha, joined);
      void joined.then(
        (vector) => {
          onEmbedded(new Map([[sha, vector]]));
        },
        () => undefined,
      );
    }
    for (let start = 0; start < fresh.length; start += this.batchSize) {
      const batch = fresh.slice(start, start + this.batchSize);
      const call = this.deps.embeddings.embedBatch(batch.map(([, content]) => content));
      void call.then(
        (results) => {
          const landed = new Map<string, readonly number[]>();
          batch.forEach(([sha], i) => {
            const embedding = results[i]?.embedding;
            if (embedding) landed.set(sha, embedding);
          });
          onEmbedded(landed);
        },
        () => undefined,
      );
      batch.forEach(([sha], i) => {
        const key = `${model}\0${sha}`;
        const one = call.then((results) => {
          const embedding = results[i]?.embedding;
          if (!embedding) throw new WorkingTreeEmbeddingMalformedError(batch.length, results.length);
          return embedding;
        });
        this.inflight.set(key, one);
        waits.set(sha, one);
        void one.then(
          (vector) => {
            this.remember(key, vector);
            if (this.inflight.get(key) === one) this.inflight.delete(key);
          },
          () => {
            if (this.inflight.get(key) === one) this.inflight.delete(key);
          },
        );
      });
    }
    const settled = await Promise.allSettled([...waits.values()]);
    let embedded = 0;
    let failure: unknown;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") embedded += 1;
      else failure ??= outcome.reason;
    }
    if (failure !== undefined && embedded < waits.size) {
      throw failure instanceof Error ? failure : new WorkingTreeEmbeddingMalformedError(waits.size, embedded);
    }
  }

  /**
   * Write every vector `state` holds for each of `paths` beside that file's
   * rows. Fire and forget. The store merges a write into the entry's vectors by
   * reading then writing, so writes of one entry are chained — two overlapping
   * writes would each drop what the other added.
   */
  private persist(
    request: WorkingTreeDenseVectorRequest,
    model: string,
    wanted: readonly WantedRow[],
    state: DenseWarmState,
    paths: ReadonlySet<string>,
  ): void {
    const { store } = this.deps;
    if (!store || !request.storeKeys || paths.size === 0) return;
    const byPath = new Map<string, Map<string, number[]>>();
    for (const row of wanted) {
      const vector = state.vectors.get(row.id);
      if (!vector || !paths.has(row.relativePath)) continue;
      const file = byPath.get(row.relativePath) ?? new Map<string, number[]>();
      file.set(row.contentSha256, [...vector]);
      byPath.set(row.relativePath, file);
    }
    for (const [path, vectors] of byPath) {
      const key = request.storeKeys.get(path);
      if (!key) continue;
      const entry = [request.collectionName, model, key.treeRoot, path, key.contentSha256, key.chunkerFingerprint].join(
        "\0",
      );
      const write = (this.writes.get(entry) ?? Promise.resolve())
        .then(async () => store.putVectors(request.collectionName, key, model, vectors))
        .catch(() => undefined);
      this.writes.set(entry, write);
      void write.then(() => {
        if (this.writes.get(entry) === write) this.writes.delete(entry);
      });
    }
  }

  private remember(key: string, vector: readonly number[]): void {
    this.memory.delete(key);
    while (this.memory.size >= this.memoryEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
    this.memory.set(key, vector);
  }
}

/** The rows that need a vector — one per id, content non-empty. */
function wantedRows(rows: readonly ScrollChunk[]): WantedRow[] {
  const byId = new Map<string, WantedRow>();
  for (const row of rows) {
    const content = contentOf(row);
    const id = String(row.id);
    if (content === "" || byId.has(id)) continue;
    const relativePath = typeof row.payload.relativePath === "string" ? row.payload.relativePath : "";
    byId.set(id, { id, relativePath, content, contentSha256: sha256(content), span: spanOf(row.payload) });
  }
  return [...byId.values()];
}

/** `rows` with each file's rows together, files in order of first appearance — so files finish embedding one by one. */
function groupedByFile(rows: readonly WantedRow[]): WantedRow[] {
  const byPath = new Map<string, WantedRow[]>();
  for (const row of rows) {
    const file = byPath.get(row.relativePath);
    if (file) file.push(row);
    else byPath.set(row.relativePath, [row]);
  }
  return [...byPath.values()].flat();
}

/** Resolves when `work` settles or `waitMs` lapses, whichever is first; the timer never holds the process. */
async function settleWithin(work: Promise<void>, waitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapse = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, waitMs));
    timer.unref?.();
  });
  try {
    await Promise.race([work, lapse]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The admitted rows that have a vector, each scored by exact cosine against
 * the query vector — the score Qdrant reports for a cosine collection, so the
 * two lists merge by score. Best first.
 */
export function scoreWorkingTreeRowsByVector(
  rows: readonly ScrollChunk[],
  vectors: ReadonlyMap<string, readonly number[]>,
  query: readonly number[],
  admits: (row: ScrollChunk) => boolean,
): ExploreResult[] {
  const scored: ExploreResult[] = [];
  for (const row of rows) {
    const vector = vectors.get(String(row.id));
    if (vector?.length !== query.length || !admits(row)) continue;
    scored.push({ id: row.id, score: cosine(query, vector), payload: row.payload });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** find_similar's `strategy`. */
export type WorkingTreeRecommendStrategy = "best_score" | "average_vector" | "sum_scores";

/** Qdrant's `scaled_fast_sigmoid`: maps a similarity into (0, 1) monotonically. */
function scaledFastSigmoid(x: number): number {
  return 0.5 * (x / (1 + Math.abs(x)) + 1);
}

function average(vectors: readonly (readonly number[])[]): number[] {
  const sum = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const vector of vectors) vector.forEach((value, i) => (sum[i] += value));
  return sum.map((value) => value / vectors.length);
}

/**
 * The score Qdrant's recommend query gives a point with vector `candidate`
 * (Qdrant 1.18, `reco_query.rs` / the average-vector rewrite), so a delta row
 * merges by score with the recommend page:
 *
 *   - best_score: scaled sigmoid of the best positive cosine when it beats the
 *     best negative, else the negation of the best negative's;
 *   - sum_scores: Σ positive cosines − Σ negative cosines;
 *   - average_vector: cosine against avg(pos) + (avg(pos) − avg(neg)), or
 *     avg(pos) with no negatives.
 */
export function recommendWorkingTreeScore(
  candidate: readonly number[],
  positives: readonly (readonly number[])[],
  negatives: readonly (readonly number[])[],
  strategy: WorkingTreeRecommendStrategy,
): number {
  if (strategy === "average_vector") {
    const positive = average(positives);
    const negative = negatives.length === 0 ? undefined : average(negatives);
    const target = negative ? positive.map((value, i) => 2 * value - (negative[i] ?? 0)) : positive;
    return cosine(target, candidate);
  }
  const positiveScores = positives.map((vector) => cosine(vector, candidate));
  const negativeScores = negatives.map((vector) => cosine(vector, candidate));
  if (strategy === "sum_scores") {
    const total = (scores: number[]): number => scores.reduce((sum, score) => sum + score, 0);
    return total(positiveScores) - total(negativeScores);
  }
  const bestPositive = positiveScores.length > 0 ? Math.max(...positiveScores) : Number.NEGATIVE_INFINITY;
  const bestNegative = negativeScores.length > 0 ? Math.max(...negativeScores) : Number.NEGATIVE_INFINITY;
  return bestPositive > bestNegative ? scaledFastSigmoid(bestPositive) : -scaledFastSigmoid(bestNegative);
}
