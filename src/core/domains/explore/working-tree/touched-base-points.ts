/**
 * The ONE reader of the base-index points of the files a working tree touched
 * (bd tea-rags-mcp-xi2r9). Consumers reach it through the view
 * (`WorkingTreeView#readTouchedBasePoints`), each asking for the minimum it
 * reads: hybrid's `has_id` exclusion the light points of every touched path,
 * the dense floor the light points of the paths its missing rows sit in, the
 * delta signals the full points of the paths whose rows are signalled.
 *
 * What a request costs follows what it asks, not the delta (live probe: a tree
 * 3,198 files from its index answered a warm find_symbol in ~10 s, re-reading
 * ~30k points of git / codegraph JSON whenever the touched set moved by one
 * path, every minute, and in every one-shot process):
 *
 * - **Per path.** Points are kept per (index revision, path); a request
 *   scrolls only the paths no earlier one read at that revision, and
 *   concurrent requests for a path share its one scroll. A path the index holds
 *   nothing of is kept too (as empty), so it is not asked again.
 * - **Two tiers.** `light` carries identity and span only; `full` adds `git`
 *   and `codegraph` and is scrolled per path only when a consumer asks it. A
 *   full read also answers the path's light points.
 * - **Revision, not clock.** The revision is (collection, the index run's
 *   stamp — the registry's `indexedAt`, written by every run's `record()` —
 *   and the collection's point count, which moves on a delete outside a run).
 *   Light points are fixed by the run that wrote them, so no clock expires
 *   them. The heavy blocks are not: enrichment may rewrite them after the run
 *   stamped the registry, keeping the point count, so a full read is trusted
 *   for {@link WORKING_TREE_HEAVY_BASE_POINT_TTL_MS} only.
 * - **Across processes.** With a store (`WorkingTreeBasePointStore`) and a
 *   stamped revision, the light tier is loaded from disk once per revision and
 *   written back after a read added paths; a one-shot process over a warm
 *   store scrolls nothing it already holds. The heavy tier stays in memory.
 *
 * One scroll PER PATH, served by the text index on `relativePath`. A filter
 * naming many paths — `anyOfOnTextIndexed`'s `should`, or a bare `match.any` —
 * makes the planner scan: on the live `code_665c0e4c` (137 paths, 1972 points)
 * one multi-path scroll with payload took 4482 ms, the per-path scrolls 448 ms;
 * on the self-index (159 paths, ids only) 1.5 s against 160 ms.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type {
  WorkingTreeBasePoint,
  WorkingTreeBasePointTier,
  WorkingTreeTouchedBasePointsByPath,
} from "../../../contracts/types/working-tree.js";
import type { WorkingTreeBasePointStore } from "./base-point-store.js";

/**
 * How long a path's heavy payload is trusted. The revision catches every index
 * run and every delete; this bounds what it cannot see — enrichment rewriting
 * `git` / `codegraph` after the run stamped the registry. Stale heavy blocks
 * cost delta rows only signals a few minutes old.
 */
export const WORKING_TREE_HEAVY_BASE_POINT_TTL_MS = 10 * 60_000;
/** Index revisions whose light points are kept per process; a server sees one or two at a time. */
const REVISIONS_KEPT = 4;
/** Paths whose heavy points are kept per process — the files recent answers signalled. */
const HEAVY_PATHS_KEPT = 1_024;
/** Per-path scrolls in flight at once. */
const SCROLL_CONCURRENCY = 16;
/** No single file holds more points than this; a scroll cap, not a page size. */
const MAX_POINTS_PER_PATH = 100_000;
const SCROLL_PAGE_SIZE = 1_000;
/** Identity and span: what the `has_id` exclusion and the dense span match read. */
const LIGHT_PAYLOAD = ["relativePath", "symbolId", "startLine", "endLine"];
/** Light plus the trajectory blocks delta rows inherit. */
const FULL_PAYLOAD = [...LIGHT_PAYLOAD, "git", "codegraph"];

const NO_POINTS: WorkingTreeTouchedBasePointsByPath = new Map();

type PathPoints = readonly WorkingTreeBasePoint[];

export interface WorkingTreeTouchedBasePointsRequest {
  collectionName: string;
  /**
   * What names the index run the points belong to — the registry's
   * `indexedAt`. `null` → unknown: the points are kept in memory by point
   * count alone and never stored.
   */
  indexStamp: string | null;
  paths: Iterable<string>;
  tier: WorkingTreeBasePointTier;
}

export interface WorkingTreeTouchedBasePointsDeps {
  /** Where the light tier outlives the process. Absent → memory only. */
  store?: Pick<WorkingTreeBasePointStore, "read" | "write">;
  now?: () => number;
}

/** The light points one index revision holds, in memory. */
interface RevisionLightPoints {
  /** Every path read at this revision → its light points (empty: the index holds none). */
  known: Map<string, PathPoints>;
  inflight: Map<string, Promise<PathPoints>>;
  /** The stored record merged into `known`, once. */
  loaded: Promise<void>;
  /** Whether `known` is written to the store. */
  persistable: boolean;
  /** This revision's record writes, one after another. */
  persisting: Promise<void>;
}

export class WorkingTreeTouchedBasePoints {
  private readonly revisions = new Map<string, RevisionLightPoints>();
  private readonly heavy = new Map<string, { at: number; points: Promise<PathPoints> }>();
  private readonly now: () => number;

  constructor(
    private readonly qdrant: Pick<QdrantManager, "scrollFiltered" | "getCollectionInfo">,
    private readonly deps: WorkingTreeTouchedBasePointsDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The base points of `request.paths` in the tier asked, by path in path
   * order; a path the index holds nothing of has no entry. A failed scroll is
   * not kept: the request rejects and the next one retries the path.
   */
  async pointsOf(request: WorkingTreeTouchedBasePointsRequest): Promise<WorkingTreeTouchedBasePointsByPath> {
    const paths = [...new Set(request.paths)].sort();
    if (paths.length === 0) return NO_POINTS;
    const { collectionName, indexStamp } = request;
    const { pointsCount } = await this.qdrant.getCollectionInfo(collectionName);
    const revision = JSON.stringify([collectionName, indexStamp ?? "", pointsCount]);
    const light = this.revisionOf(revision, indexStamp !== null);
    await light.loaded;
    const perPath =
      request.tier === "full"
        ? await this.readHeavy(collectionName, revision, light, paths)
        : await this.readLight(collectionName, revision, light, paths);

    const byPath = new Map<string, PathPoints>();
    paths.forEach((path, i) => {
      if (perPath[i].length > 0) byPath.set(path, perPath[i]);
    });
    return byPath;
  }

  /** Light points of `paths`: held ones as they are, the rest scrolled light and then stored. */
  private async readLight(
    collectionName: string,
    revision: string,
    light: RevisionLightPoints,
    paths: readonly string[],
  ): Promise<PathPoints[]> {
    const missing = paths.filter((path) => !light.known.has(path) && !light.inflight.has(path));
    const scrolled = this.scrollEach(collectionName, missing, LIGHT_PAYLOAD);
    for (const [path, scroll] of scrolled) {
      const read = scroll.then((points) => {
        light.known.set(path, points);
        return points;
      });
      light.inflight.set(path, read);
      const settle = (): void => {
        if (light.inflight.get(path) === read) light.inflight.delete(path);
      };
      read.then(settle, settle);
    }
    const stored =
      scrolled.size > 0
        ? Promise.allSettled(scrolled.values()).then(async () => this.persist(revision, light))
        : undefined;
    try {
      return await Promise.all(
        paths.map(async (path) => light.known.get(path) ?? light.inflight.get(path) ?? Promise.resolve([])),
      );
    } finally {
      // Awaited so a one-shot process's cleanup, which flushes writes in flight, sees this one.
      await stored;
    }
  }

  /** Full points of `paths`: fresh heavy reads reused, the rest scrolled full (which also answers their light points). */
  private async readHeavy(
    collectionName: string,
    revision: string,
    light: RevisionLightPoints,
    paths: readonly string[],
  ): Promise<PathPoints[]> {
    const at = this.now();
    const keyOf = (path: string): string => `${revision}\0${path}`;
    const missing = paths.filter((path) => {
      const hit = this.heavy.get(keyOf(path));
      return !hit || at - hit.at >= WORKING_TREE_HEAVY_BASE_POINT_TTL_MS;
    });
    const scrolled = this.scrollEach(collectionName, missing, FULL_PAYLOAD);
    let addedLight = false;
    for (const [path, scroll] of scrolled) {
      const key = keyOf(path);
      const read = scroll.then((points) => {
        if (!light.known.has(path)) {
          light.known.set(path, points.map(lightPointOf));
          addedLight = true;
        }
        return points;
      });
      this.heavy.delete(key);
      this.heavy.set(key, { at, points: read });
      read.catch(() => {
        if (this.heavy.get(key)?.points === read) this.heavy.delete(key);
      });
    }
    while (this.heavy.size > HEAVY_PATHS_KEPT) {
      const oldest = this.heavy.keys().next().value;
      if (oldest === undefined) break;
      this.heavy.delete(oldest);
    }
    const reads = paths.map(async (path): Promise<PathPoints> => {
      const entry = this.heavy.get(keyOf(path));
      if (!entry) return [];
      // Most recently used last: eviction drops the oldest-used path.
      this.heavy.delete(keyOf(path));
      this.heavy.set(keyOf(path), entry);
      return entry.points;
    });
    try {
      return await Promise.all(reads);
    } finally {
      if (addedLight) await this.persist(revision, light);
    }
  }

  /** The light points of `revision`, loading its stored record on first use. */
  private revisionOf(revision: string, persistable: boolean): RevisionLightPoints {
    const held = this.revisions.get(revision);
    if (held) {
      this.revisions.delete(revision);
      this.revisions.set(revision, held);
      return held;
    }
    const known = new Map<string, PathPoints>();
    const { store } = this.deps;
    const loaded =
      store && persistable
        ? store.read(revision).then(
            (stored) => {
              for (const [path, points] of stored ?? []) if (!known.has(path)) known.set(path, points);
            },
            () => undefined,
          )
        : Promise.resolve();
    const state: RevisionLightPoints = {
      known,
      inflight: new Map(),
      loaded,
      persistable,
      persisting: Promise.resolve(),
    };
    this.revisions.set(revision, state);
    while (this.revisions.size > REVISIONS_KEPT) {
      const oldest = this.revisions.keys().next().value;
      if (oldest === undefined) break;
      this.revisions.delete(oldest);
    }
    return state;
  }

  /** Writes the revision's light points to the store, after any earlier write of it. Never rejects. */
  private async persist(revision: string, light: RevisionLightPoints): Promise<void> {
    const { store } = this.deps;
    if (!store || !light.persistable) return;
    light.persisting = light.persisting
      .then(async () => store.write(revision, new Map(light.known)))
      .catch(() => undefined);
    await light.persisting;
  }

  /** One scroll per path, {@link SCROLL_CONCURRENCY} at a time; each path's own promise. */
  private scrollEach(
    collectionName: string,
    paths: readonly string[],
    payload: readonly string[],
  ): Map<string, Promise<PathPoints>> {
    const settles = paths.map(() => {
      let resolve!: (points: PathPoints) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<PathPoints>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      return { promise, resolve, reject };
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const index = next++;
        try {
          settles[index].resolve(
            await this.qdrant.scrollFiltered(
              collectionName,
              { must: exactMatchOnTextIndexed("relativePath", paths[index]) },
              MAX_POINTS_PER_PATH,
              SCROLL_PAGE_SIZE,
              [...payload],
            ),
          );
        } catch (error) {
          settles[index].reject(error);
        }
      }
    };
    for (let i = 0; i < Math.min(SCROLL_CONCURRENCY, paths.length); i++) void worker();
    return new Map(paths.map((path, i) => [path, settles[i].promise]));
  }
}

/** A full point cut to its light payload. */
function lightPointOf(point: WorkingTreeBasePoint): WorkingTreeBasePoint {
  const payload: Record<string, unknown> = {};
  for (const key of LIGHT_PAYLOAD) if (key in point.payload) payload[key] = point.payload[key];
  return { id: point.id, payload };
}

/** Every point id of a touched-base-point read, in path order. */
export function touchedBasePointIds(points: WorkingTreeTouchedBasePointsByPath): (string | number)[] {
  const ids: (string | number)[] = [];
  for (const pathPoints of points.values()) for (const point of pathPoints) ids.push(point.id);
  return ids;
}
