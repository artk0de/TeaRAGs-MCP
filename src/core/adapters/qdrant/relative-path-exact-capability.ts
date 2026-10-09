/**
 * Whether a collection's path-membership filters may match the keyword-indexed
 * `relativePathExact` (bd tea-rags-mcp-ejio7) — the ONE place that decides it,
 * so the point store, the working-tree base-point reader and test-setup
 * hydration cannot disagree about a collection.
 *
 * Yes requires two things, checked on EVERY call:
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
 *    it serves: one limit-1 probe for such points
 *    (`hasPointsMissingRelativePathExact`), and when it finds one, the same
 *    backfill the v20 migration runs (`backfillRelativePathExact`, the single
 *    owner of that write). A backfill that fails answers no.
 *
 * Why per call, with no remembered yes: an older writer can add twinless
 * points at any moment, so a cached yes is exactly the hazard. The probe is
 * one filtered scroll of limit 1 over two indexed keys. Measured on a
 * 150k-point / 30k-path scratch collection (Qdrant 1.18.2, 2026-10-09): the
 * probe is p50 0.5 ms with 0 or 50 points missing, healing 50 points 27 ms,
 * while 256 paths cost p50 7 ms as one keyword MatchAny against p50 93 ms as
 * per-path exact pairs at the point store's concurrency of 4 — a positive TTL
 * would save under 1% of what serving saves, so none is kept. The residual window — an older build writing between the probe
 * and the caller's filter — is the same race any concurrent writer has with a
 * delete and is closed by the next call.
 *
 * Concurrent callers on one PHYSICAL collection share one in-flight check
 * (version read, probe, backfill), so a burst of deletes never runs parallel
 * backfills; the shared promise is dropped once it settles. Resolving the
 * alias is one alias-list read per call, which keeps an alias switched onto a
 * collection an OLDER build created from inheriting the old target's answer.
 *
 * Never throws: an unreadable alias list, metadata point, probe or backfill
 * answers no, which is always correct, only slower.
 */

import { RELATIVE_PATH_EXACT_SCHEMA_VERSION } from "../../contracts/relative-path-exact.js";
import {
  backfillRelativePathExact,
  hasPointsMissingRelativePathExact,
  type RelativePathExactBackfillStore,
} from "./relative-path-exact-backfill.js";

export interface RelativePathExactCapabilityDeps {
  /** The physical collection an alias names, or the name itself. */
  resolvePhysical: (collectionName: string) => Promise<string>;
  /** The stamped schema version, or `undefined` when the collection has no schema metadata. */
  readSchemaVersion: (physicalCollectionName: string) => Promise<number | undefined>;
  /** Where the probe and the heal read and write; its writes must be visible to the caller's next filter. */
  backfillStore: RelativePathExactBackfillStore;
}

/** The gate's surface, as its consumers take it. */
export interface RelativePathExactGate {
  isServed: (collectionName: string) => Promise<boolean>;
}

export class RelativePathExactCapability implements RelativePathExactGate {
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: RelativePathExactCapabilityDeps) {}

  async isServed(collectionName: string): Promise<boolean> {
    let physical: string;
    try {
      physical = await this.deps.resolvePhysical(collectionName);
    } catch {
      return false;
    }
    const pending = this.inFlight.get(physical);
    if (pending) return pending;
    const check = this.check(physical).finally(() => this.inFlight.delete(physical));
    this.inFlight.set(physical, check);
    return check;
  }

  private async check(physical: string): Promise<boolean> {
    try {
      const version = await this.deps.readSchemaVersion(physical);
      if (version === undefined || version < RELATIVE_PATH_EXACT_SCHEMA_VERSION) return false;
      if (await hasPointsMissingRelativePathExact(this.deps.backfillStore, physical)) {
        await backfillRelativePathExact(this.deps.backfillStore, physical);
      }
      return true;
    } catch {
      return false;
    }
  }
}
