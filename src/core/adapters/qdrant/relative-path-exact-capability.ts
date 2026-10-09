/**
 * Whether a collection's path-membership filters may match the keyword-indexed
 * `relativePathExact` (bd tea-rags-mcp-ejio7) — the ONE place that decides it,
 * so the point store, the working-tree base-point reader and test-setup
 * hydration cannot disagree about a collection.
 *
 * Yes requires two things:
 *
 * 1. **The collection's schema version is at least
 *    `RELATIVE_PATH_EXACT_SCHEMA_VERSION`.** The schema pipeline stamps a
 *    version only after every migration up to it succeeded, so that version
 *    means the v20 backfill finished. Below it the migration still owns the
 *    backfill and the answer is no — the caller keeps the exact text+value
 *    pairs on `relativePath`.
 * 2. **No point has a `relativePath` but lacks the twin.** The stamp is not
 *    enough: a build OLDER than the twin (the globally installed binary that
 *    auto-update or an MCP server runs) has no idea the key exists and upserts
 *    points without it into a v20 collection, and nothing in that build can be
 *    taught to stop. A keyword filter would miss those points with no error —
 *    a delete or rename leaves them behind as ghosts. So the gate heals before
 *    it serves: two exact PRESENCE counts give the number missing
 *    (`countPointsMissingRelativePathExact` — never an `is_empty` probe, which
 *    counts unvacuumed dead versions as missing; see the `adapters/qdrant`
 *    navigator), and when it is above zero, the same backfill the v20
 *    migration runs (`backfillRelativePathExact`, the single owner of that
 *    write), bounded by that number. A probe or backfill that fails answers no.
 *
 * **A yes is remembered per physical collection for `SERVED_TTL_MS` (60 s);
 * a no never is.** The probe is not free: measured on the self-index
 * (`code_8b243ffe_v71`, 46 097 points, Qdrant 1.18.2, 2026-10-09) the two
 * counts cost ~420 ms together, almost all of it the `has path ∧ has twin`
 * count. What one yes saves is per call: 256 paths cost p50 7 ms as one
 * keyword MatchAny against p50 93 ms as per-path exact pairs at the point
 * store's concurrency of 4 (150k-point scratch collection) — so probing on
 * every call would cost several times what serving saves, while one probe
 * a minute is amortised over every membership filter inside it.
 * The residual window this buys: an OLDER build that writes twinless points
 * inside the 60 s after a yes leaves them invisible to a keyword filter until
 * the next probe heals them — a delete in that window can miss them and leave
 * a stale chunk until the path is next touched. That build is the only writer
 * that omits the twin, and the window is bounded by the TTL.
 *
 * Concurrent callers on one PHYSICAL collection share one in-flight check
 * (version read, probe, backfill), so a burst of deletes never runs parallel
 * backfills; the shared promise is dropped once it settles. Resolving the
 * alias is one alias-list read per call and the remembered yes is keyed by the
 * physical name, which keeps an alias switched onto a collection an OLDER
 * build created from inheriting the old target's answer.
 *
 * Never throws: an unreadable alias list, metadata point, probe or backfill
 * answers no, which is always correct, only slower.
 */

import { RELATIVE_PATH_EXACT_SCHEMA_VERSION } from "../../contracts/relative-path-exact.js";
import {
  backfillRelativePathExact,
  countPointsMissingRelativePathExact,
  type RelativePathExactProbeStore,
} from "./relative-path-exact-backfill.js";

/** How long a yes is remembered per physical collection; the docblock above says why 60 s. */
const SERVED_TTL_MS = 60_000;

export interface RelativePathExactCapabilityDeps {
  /** The physical collection an alias names, or the name itself. */
  resolvePhysical: (collectionName: string) => Promise<string>;
  /** The stamped schema version, or `undefined` when the collection has no schema metadata. */
  readSchemaVersion: (physicalCollectionName: string) => Promise<number | undefined>;
  /** Where the probe counts and the heal reads and writes; its writes must be visible to the caller's next filter. */
  backfillStore: RelativePathExactProbeStore;
}

/** The gate's surface, as its consumers take it. */
export interface RelativePathExactGate {
  isServed: (collectionName: string) => Promise<boolean>;
}

export class RelativePathExactCapability implements RelativePathExactGate {
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** Physical collection → epoch ms until which its yes stands. */
  private readonly servedUntil = new Map<string, number>();

  constructor(private readonly deps: RelativePathExactCapabilityDeps) {}

  async isServed(collectionName: string): Promise<boolean> {
    let physical: string;
    try {
      physical = await this.deps.resolvePhysical(collectionName);
    } catch {
      return false;
    }
    const until = this.servedUntil.get(physical);
    if (until !== undefined && Date.now() < until) return true;
    const pending = this.inFlight.get(physical);
    if (pending) return pending;
    const check = this.check(physical).finally(() => this.inFlight.delete(physical));
    this.inFlight.set(physical, check);
    return check;
  }

  private async check(physical: string): Promise<boolean> {
    this.servedUntil.delete(physical);
    try {
      const version = await this.deps.readSchemaVersion(physical);
      if (version === undefined || version < RELATIVE_PATH_EXACT_SCHEMA_VERSION) return false;
      const missing = await countPointsMissingRelativePathExact(this.deps.backfillStore, physical);
      if (missing > 0) await backfillRelativePathExact(this.deps.backfillStore, physical, { missing });
      this.servedUntil.set(physical, Date.now() + SERVED_TTL_MS);
      return true;
    } catch {
      return false;
    }
  }
}
