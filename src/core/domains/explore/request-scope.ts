/**
 * ExploreRequestScope (bd tea-rags-mcp-89k7k.1.18) — the reads that are
 * invariant across the explore calls ONE caller request makes. A naming review
 * runs dozens of concept searches against one index and one tree; without a
 * scope each re-probed the index's existence and re-measured the tree, and
 * those reads, not the vector search, dominated the review's wall clock.
 *
 * The caller creates one per request and passes it explicitly to every
 * explore call of that request; it is never kept across requests, so a later
 * request sees the index and tree as they are then.
 */

import { WorkingTreeMeasurements } from "./working-tree/overlay.js";

export class ExploreRequestScope {
  /** The request's tree measurements, shared by every view its calls ask for. */
  readonly workingTree = new WorkingTreeMeasurements();

  /** Existence probes by collection name; a failed probe is forgotten, so the next call probes again. */
  private readonly existence = new Map<string, Promise<boolean>>();

  /** Whether `collectionName` exists, probed once per request by `probe`. */
  async collectionExists(collectionName: string, probe: (name: string) => Promise<boolean>): Promise<boolean> {
    let exists = this.existence.get(collectionName);
    if (exists === undefined) {
      exists = probe(collectionName);
      this.existence.set(collectionName, exists);
      exists.catch(() => {
        if (this.existence.get(collectionName) === exists) this.existence.delete(collectionName);
      });
    }
    return exists;
  }
}
