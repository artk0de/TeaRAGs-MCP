/**
 * The ONE reader of the base-index points of the files a working tree touched
 * (bd tea-rags-mcp-xi2r9). Two consumers read them on every request against a
 * tree with a delta: hybrid_search's `has_id` exclusion (the ids) and the
 * delta-signal source (the git / codegraph payload delta rows inherit). Both go
 * through the view (`WorkingTreeView#readTouchedBasePoints`), so one request
 * reads once, and the cache below makes every later request read nothing.
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
  WorkingTreeTouchedBasePointsByPath,
} from "../../../contracts/types/working-tree.js";

/** Touched sets kept per process; a tree under edit reuses one set across many queries. */
const CACHE_ENTRIES = 32;
/**
 * How long a read is trusted. The revision key (point count + indexed commit)
 * catches an index run that changes either; this bounds one that changes
 * neither. Stale points cost hybrid only RRF positions (it also drops any base
 * row of a touched file the request still returned) and the delta rows only
 * inherited signals a minute old.
 */
const TTL_MS = 60_000;
/** Per-path scrolls in flight at once. */
const SCROLL_CONCURRENCY = 16;
/** No single file holds more points than this; a scroll cap, not a page size. */
const MAX_POINTS_PER_PATH = 100_000;
const SCROLL_PAGE_SIZE = 1_000;
/** What hybrid (ids) and the delta signals (identity, range, trajectory blocks) read. */
const BASE_POINT_PAYLOAD = ["relativePath", "symbolId", "startLine", "endLine", "git", "codegraph"];

const NO_POINTS: WorkingTreeTouchedBasePointsByPath = new Map();

/**
 * Base points of a touched-file set, read once per (collection, index
 * revision, touched set) and reused while the tree sits in that state.
 * Concurrent identical requests share one read; a failed read is not kept, so
 * the next request retries.
 */
export class WorkingTreeTouchedBasePoints {
  private readonly reads = new Map<string, { at: number; points: Promise<WorkingTreeTouchedBasePointsByPath> }>();

  constructor(
    private readonly qdrant: Pick<QdrantManager, "scrollFiltered" | "getCollectionInfo">,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `indexedCommit` is the commit the base index was stamped at; with the
   * collection's point count it is the index revision the read is valid for.
   */
  async pointsOf(
    collectionName: string,
    touchedPaths: ReadonlySet<string>,
    indexedCommit: string | null,
  ): Promise<WorkingTreeTouchedBasePointsByPath> {
    if (touchedPaths.size === 0) return NO_POINTS;
    const paths = [...touchedPaths].sort();
    const { pointsCount } = await this.qdrant.getCollectionInfo(collectionName);
    const key = JSON.stringify([collectionName, pointsCount, indexedCommit ?? "", paths]);
    const at = this.now();
    const hit = this.reads.get(key);
    if (hit && at - hit.at < TTL_MS) {
      // Most recently used last: eviction drops the oldest-used entry.
      this.reads.delete(key);
      this.reads.set(key, hit);
      return hit.points;
    }

    const points = this.scrollPoints(collectionName, paths);
    this.reads.delete(key);
    while (this.reads.size >= CACHE_ENTRIES) {
      const oldest = this.reads.keys().next().value;
      if (oldest === undefined) break;
      this.reads.delete(oldest);
    }
    this.reads.set(key, { at, points });
    points.catch(() => {
      if (this.reads.get(key)?.points === points) this.reads.delete(key);
    });
    return points;
  }

  /** One scroll per path, {@link SCROLL_CONCURRENCY} at a time; the map in path order. */
  private async scrollPoints(
    collectionName: string,
    paths: readonly string[],
  ): Promise<WorkingTreeTouchedBasePointsByPath> {
    const perPath: (readonly WorkingTreeBasePoint[])[] = paths.map(() => []);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const index = next++;
        perPath[index] = await this.qdrant.scrollFiltered(
          collectionName,
          { must: exactMatchOnTextIndexed("relativePath", paths[index]) },
          MAX_POINTS_PER_PATH,
          SCROLL_PAGE_SIZE,
          BASE_POINT_PAYLOAD,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCROLL_CONCURRENCY, paths.length) }, worker));

    const byPath = new Map<string, readonly WorkingTreeBasePoint[]>();
    paths.forEach((path, i) => {
      if (perPath[i].length > 0) byPath.set(path, perPath[i]);
    });
    return byPath;
  }
}

/** Every point id of a touched-base-point read, in path order. */
export function touchedBasePointIds(points: WorkingTreeTouchedBasePointsByPath): (string | number)[] {
  const ids: (string | number)[] = [];
  for (const pathPoints of points.values()) for (const point of pathPoints) ids.push(point.id);
  return ids;
}
