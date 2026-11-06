/**
 * Resume an unfinished first index into the physical collection it already
 * filled, instead of opening `<alias>_vN+1`.
 *
 * The done-set lives at `snapshots/<alias>.resume/<physical>/`, never inside
 * `snapshots/<alias>/` — that directory is the sharded snapshot, and it is
 * not a resume map.
 * Writes are a temp file plus rename. `meta.json` records the sha256 of each
 * batch; a bad checksum drops that batch only. Meta whose `kind` is not
 * `first-index-resume` (including a snapshot `version: "3"`) loads as `null`,
 * which means "no checkpoint" — an empty done-set is a real, valid checkpoint
 * and must not be confused with one.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

import type { QdrantCollectionCatalog, QdrantPointReader } from "../../../../adapters/qdrant/ports.js";
import { INDEXING_METADATA_ID } from "../../../../contracts/constants.js";
import type { CollectionAlias, PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { isIndexingRunStale, parseMarkerPayload, type IndexingMarkerPayload } from "../../infra/index.js";
import type { FileMetadata } from "../snapshot/sharded-snapshot.js";

/** Same 1s window the synchronizer's mtime+size fast path uses. */
const MTIME_TOLERANCE_MS = 1000;

export const FIRST_INDEX_RESUME_KIND = "first-index-resume";
export const FIRST_INDEX_RESUME_VERSION = 1;

const BATCH_FILE_PATTERN = /^batch-\d+\.json$/;

export interface FirstIndexGeneration<T extends string = string> {
  physical: T;
  version: number;
  /** Parsed marker, or `null` when the point is missing. Missing counts as stale and incomplete. */
  marker: IndexingMarkerPayload | null;
  /** `snapshots/<alias>.resume/<physical>/meta.json` exists. */
  hasCheckpoint: boolean;
}

export interface FirstIndexResumeChoice<T extends string = string> {
  physical: T;
  version: number;
}

export interface DerivedResumeCheckpoint {
  /** Stored paths that still have a content hash. A partial file is accepted as-is. */
  done: Map<string, FileMetadata>;
  /** Stored paths with no hash left on disk. Deleted, not checkpointed. */
  missingFromDisk: string[];
}

export interface ResumeFilePlan {
  /** Checkpointed files whose mtime+size (or else hash) still match. Skipped, never deleted. */
  unchanged: string[];
  /** Checkpointed files whose content changed. Deleted, then re-ingested. */
  rewrite: string[];
  /** On disk, absent from the checkpoint. Re-ingested. */
  ingest: string[];
  /** Checkpointed paths no longer on disk. Deleted. */
  removed: string[];
  /**
   * Rewrite and removed always. Ingest paths only when `storedPaths` was
   * omitted (unknown) or lists the path. Unchanged never appears: an added
   * file is not deleted before ingest on the incremental path, and a resumed
   * file can already have points.
   */
  pathsToDelete: string[];
}

interface ResumeBatchRef {
  file: string;
  sha256: string;
}

interface ResumeMeta {
  kind: typeof FIRST_INDEX_RESUME_KIND;
  version: typeof FIRST_INDEX_RESUME_VERSION;
  batches: ResumeBatchRef[];
}

export type FirstIndexResumeQdrant = Pick<QdrantCollectionCatalog, "listCollections"> &
  Pick<QdrantPointReader, "getPoint">;

/** `snapshots/<alias>.resume/<physical>/`. Never `snapshots/<alias>/`. */
export function firstIndexResumeDirectory(snapshotDir: string, alias: string, physical: string): string {
  return join(snapshotDir, `${alias}.resume`, physical);
}

/**
 * Repo-relative path, matching `ParallelFileSynchronizer`'s keys so a
 * checkpoint lines up with `getCachedFileMetadata()`.
 */
export function repoRelativePath(root: string, filePath: string): string {
  if (filePath.startsWith(root)) return relative(root, filePath);
  return filePath;
}

/**
 * One unfinished generation to keep writing, or `undefined`.
 *
 * Any generation that is still live (incomplete marker, heartbeat not stale)
 * returns `undefined` — the caller throws `IndexingAlreadyInProgressError`
 * rather than opening another version beside it. Two checkpoints also return
 * `undefined`: the caller opens a new version instead of guessing. With no
 * checkpoint, the newest stale unfinished generation wins. A complete marker
 * is not a candidate. This function does not delete older generations.
 */
export function selectFirstIndexResume<T extends string>(
  generations: readonly FirstIndexGeneration<T>[],
  now: number = Date.now(),
): FirstIndexResumeChoice<T> | undefined {
  if (generations.some((generation) => isLiveGeneration(generation, now))) return undefined;

  const candidates = generations.filter((generation) => isResumeCandidate(generation, now));
  const checkpointed = candidates.filter((generation) => generation.hasCheckpoint);
  if (checkpointed.length > 1) return undefined;
  if (checkpointed.length === 1) return choiceOf(checkpointed[0]);

  const newest = newestGeneration(candidates);
  return newest ? choiceOf(newest) : undefined;
}

/** True when any generation is an in-progress run. The caller refuses the index. */
export function hasLiveFirstIndexGeneration(
  generations: readonly FirstIndexGeneration[],
  now: number = Date.now(),
): boolean {
  return generations.some((generation) => isLiveGeneration(generation, now));
}

/**
 * Every `<alias>_vN` Qdrant lists, with its marker and whether a resume
 * checkpoint directory is present. Does not delete anything.
 */
export async function loadFirstIndexGenerations(
  qdrant: FirstIndexResumeQdrant,
  snapshotDir: string,
  alias: CollectionAlias,
): Promise<FirstIndexGeneration<PhysicalCollectionName>[]> {
  const names = await qdrant.listCollections();
  const generations: FirstIndexGeneration<PhysicalCollectionName>[] = [];
  for (const physical of names) {
    const version = generationVersion(alias, physical);
    if (version === undefined) continue;
    const point = await qdrant.getPoint(physical, INDEXING_METADATA_ID);
    const marker = point?.payload ? parseMarkerPayload(point.payload) : null;
    generations.push({
      physical,
      version,
      marker,
      hasCheckpoint: await resumeCheckpointExists(snapshotDir, alias, physical),
    });
  }
  return generations;
}

/**
 * Paths scrolled from the physical collection, split into a done-set and the
 * paths that no longer hash. A file indexed mid-write is kept when it still
 * has a hash — partial content is accepted.
 */
export function checkpointFromStoredPaths(
  stored: Iterable<string>,
  metadata: ReadonlyMap<string, FileMetadata>,
): DerivedResumeCheckpoint {
  const done = new Map<string, FileMetadata>();
  const missingFromDisk: string[] = [];
  const seen = new Set<string>();
  for (const path of stored) {
    if (seen.has(path)) continue;
    seen.add(path);
    const meta = metadata.get(path);
    if (meta && meta.hash.length > 0) {
      done.set(path, { mtime: meta.mtime, size: meta.size, hash: meta.hash });
    } else {
      missingFromDisk.push(path);
    }
  }
  return { done, missingFromDisk };
}

/**
 * What a resumed run still has to do. Unchanged files are skipped: mtime
 * within 1s and the same size reuse the checkpoint hash; otherwise the hashes
 * decide. `storedPaths` omitted means the scroll set is unknown, so every
 * ingest path is deleted before it is written again.
 */
export function planResumeFiles(input: {
  diskPaths: readonly string[];
  done: ReadonlyMap<string, FileMetadata>;
  current: ReadonlyMap<string, FileMetadata>;
  storedPaths?: ReadonlySet<string>;
}): ResumeFilePlan {
  const { diskPaths, done, current, storedPaths } = input;
  const onDisk = new Set(diskPaths);
  const unchanged: string[] = [];
  const rewrite: string[] = [];
  const ingest: string[] = [];

  for (const path of diskPaths) {
    const previous = done.get(path);
    if (!previous) {
      ingest.push(path);
      continue;
    }
    const meta = current.get(path);
    if (meta && fileUnchanged(previous, meta)) unchanged.push(path);
    else rewrite.push(path);
  }

  const removed: string[] = [];
  for (const path of done.keys()) {
    if (!onDisk.has(path)) removed.push(path);
  }

  const pathsToDelete = [...rewrite, ...removed];
  for (const path of ingest) {
    if (storedPaths === undefined || storedPaths.has(path)) pathsToDelete.push(path);
  }

  return { unchanged, rewrite, ingest, removed, pathsToDelete };
}

/**
 * Crash-safe done-set for one physical collection. `load()` returns `null`
 * when the directory or meta is missing or foreign. A valid meta with no
 * readable files returns an empty map.
 */
export class FirstIndexResumeStore {
  private readonly dir: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(snapshotDir: string, alias: string, physical: string) {
    this.dir = firstIndexResumeDirectory(snapshotDir, alias, physical);
  }

  async load(): Promise<Map<string, FileMetadata> | null> {
    const meta = await this.readMeta();
    if (!meta) return null;

    const done = new Map<string, FileMetadata>();
    for (const batch of meta.batches) {
      if (!isBatchRef(batch)) continue;
      const files = await this.readBatch(batch);
      if (!files) continue;
      for (const [path, fileMeta] of files) done.set(path, fileMeta);
    }
    return done;
  }

  /** Append these files as one batch. Concurrent callers are serialized. */
  async save(files: ReadonlyMap<string, FileMetadata>): Promise<void> {
    return this.enqueue(async () => this.appendBatch(files));
  }

  /** Remove this physical collection's resume directory. The snapshot dir is not touched. */
  async discard(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendBatch(files: ReadonlyMap<string, FileMetadata>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const existing = await this.readMeta();
    const batches = existing ? [...existing.batches] : [];
    const file = `batch-${String(batches.length + 1).padStart(4, "0")}.json`;
    const body = batchBody(files);
    await writeAtomic(join(this.dir, file), body);
    const next: ResumeMeta = {
      kind: FIRST_INDEX_RESUME_KIND,
      version: FIRST_INDEX_RESUME_VERSION,
      batches: [...batches, { file, sha256: sha256Hex(body) }],
    };
    await writeAtomic(join(this.dir, "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  }

  private async readMeta(): Promise<ResumeMeta | null> {
    let text: string;
    try {
      text = await fs.readFile(join(this.dir, "meta.json"), "utf8");
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    return isResumeMeta(parsed) ? parsed : null;
  }

  /** `undefined` drops this batch (checksum, missing file, unreadable body). */
  private async readBatch(batch: ResumeBatchRef): Promise<Map<string, FileMetadata> | undefined> {
    let text: string;
    try {
      text = await fs.readFile(join(this.dir, batch.file), "utf8");
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    if (sha256Hex(text) !== batch.sha256) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
    return filesFromBatch(parsed);
  }
}

function isLiveGeneration(generation: FirstIndexGeneration, now: number): boolean {
  const { marker } = generation;
  if (!marker || marker.indexingComplete) return false;
  return !isIndexingRunStale(marker, now);
}

function isResumeCandidate(generation: FirstIndexGeneration, now: number): boolean {
  if (generation.marker?.indexingComplete === true) return false;
  return !isLiveGeneration(generation, now);
}

function choiceOf<T extends string>(generation: FirstIndexGeneration<T>): FirstIndexResumeChoice<T> {
  return { physical: generation.physical, version: generation.version };
}

function newestGeneration<T extends string>(
  generations: readonly FirstIndexGeneration<T>[],
): FirstIndexGeneration<T> | undefined {
  let best: FirstIndexGeneration<T> | undefined;
  for (const generation of generations) {
    if (!best || generation.version > best.version) best = generation;
  }
  return best;
}

function generationVersion(alias: string, name: string): number | undefined {
  const prefix = `${alias}_v`;
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const version = Number(suffix);
  if (!Number.isInteger(version) || version < 1) return undefined;
  return version;
}

async function resumeCheckpointExists(snapshotDir: string, alias: string, physical: string): Promise<boolean> {
  try {
    await fs.access(join(firstIndexResumeDirectory(snapshotDir, alias, physical), "meta.json"));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function fileUnchanged(previous: FileMetadata, current: FileMetadata): boolean {
  if (Math.abs(previous.mtime - current.mtime) < MTIME_TOLERANCE_MS && previous.size === current.size) {
    return true;
  }
  return previous.hash === current.hash;
}

function isResumeMeta(value: unknown): value is ResumeMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  if (meta.kind !== FIRST_INDEX_RESUME_KIND) return false;
  if (meta.version !== FIRST_INDEX_RESUME_VERSION) return false;
  return Array.isArray(meta.batches);
}

function isBatchRef(value: unknown): value is ResumeBatchRef {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as Record<string, unknown>;
  return typeof batch.file === "string" && BATCH_FILE_PATTERN.test(batch.file) && typeof batch.sha256 === "string";
}

function filesFromBatch(value: unknown): Map<string, FileMetadata> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.files !== "object" || body.files === null || Array.isArray(body.files)) return undefined;
  const done = new Map<string, FileMetadata>();
  for (const [path, raw] of Object.entries(body.files as Record<string, unknown>)) {
    const meta = readFileMetadata(raw);
    if (meta) done.set(path, meta);
  }
  return done;
}

function readFileMetadata(value: unknown): FileMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const meta = value as Record<string, unknown>;
  if (typeof meta.mtime !== "number" || typeof meta.size !== "number" || typeof meta.hash !== "string") {
    return undefined;
  }
  if (meta.hash.length === 0) return undefined;
  return { mtime: meta.mtime, size: meta.size, hash: meta.hash };
}

function batchBody(files: ReadonlyMap<string, FileMetadata>): string {
  const record: Record<string, FileMetadata> = {};
  for (const path of [...files.keys()].sort()) {
    const meta = files.get(path);
    if (!meta || meta.hash.length === 0) continue;
    record[path] = { mtime: meta.mtime, size: meta.size, hash: meta.hash };
  }
  return `${JSON.stringify({ files: record })}\n`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, contents);
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
