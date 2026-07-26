/**
 * Schema V13: rename legacy commit-based ownership payload keys.
 *
 * Existing production indexes carry these keys; new code reads only the
 * `recent*`-prefixed names. Migrate by copying values to the new keys, then
 * deleting the old. Idempotent: only points where the new key is missing AND
 * the old key is present get rewritten.
 *
 * Note: the `blame*` (formerly `line*`) family is NOT migrated — those keys
 * were introduced in this same release and never reached production.
 */

import type { IndexStore, Migration, StepResult } from "../types.js";

type V13Store = IndexStore & Required<Pick<IndexStore, "scrollAllPayload" | "batchSetPayload" | "deletePayloadKeys">>;

const ALL_RENAMES: [string, string][] = [
  // File-level recent-activity (commit-based)
  ["git.file.dominantAuthor", "git.file.recentDominantAuthor"],
  ["git.file.dominantAuthorEmail", "git.file.recentDominantAuthorEmail"],
  ["git.file.dominantAuthorPct", "git.file.recentDominantAuthorPct"],
  ["git.file.authors", "git.file.recentAuthors"],
  ["git.file.contributorCount", "git.file.recentContributorCount"],
  // Chunk-level recent-activity
  ["git.chunk.contributorCount", "git.chunk.recentContributorCount"],
];

function readPath(payload: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = payload;
  for (const seg of segments) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Merge a dotted-path leaf into a nested object, creating intermediate maps as
 * needed. Required because Qdrant's setPayload treats top-level keys verbatim:
 * passing {"git.file.recentDominantAuthor": v} produces a flat top-level key
 * containing dots, NOT a nested write at git → file → recentDominantAuthor.
 */
function writeNested(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = cur[seg];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cur = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      cur[seg] = next;
      cur = next;
    }
  }
  cur[segments[segments.length - 1]] = value;
}

export class SchemaV13RenameOwnershipPayload implements Migration {
  readonly name = "schema-v13-rename-ownership-payload";
  readonly version = 13;

  constructor(
    private readonly collection: string,
    private readonly store: V13Store,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];

    const points = await this.store.scrollAllPayload(this.collection);
    if (points.length === 0) {
      return { applied: ["no points to migrate"] };
    }

    const ops: { points: (string | number)[]; payload: Record<string, unknown> }[] = [];
    let renamedCount = 0;

    for (const p of points) {
      const newPayload: Record<string, unknown> = {};
      let touched = false;
      for (const [oldKey, newKey] of ALL_RENAMES) {
        // Skip if new key already populated for this point (idempotent re-run)
        if (readPath(p.payload, newKey) !== undefined) continue;
        const oldVal = readPath(p.payload, oldKey);
        if (oldVal === undefined) continue;
        // Build nested object so Qdrant writes git.file.X as a nested leaf,
        // not a flat top-level key literally containing dots.
        writeNested(newPayload, newKey, oldVal);
        touched = true;
      }
      if (touched) {
        ops.push({ points: [p.id], payload: newPayload });
        renamedCount++;
      }
    }

    if (ops.length > 0) {
      await this.store.batchSetPayload(this.collection, ops);
      applied.push(`renamed ownership keys on ${renamedCount} points`);
    } else {
      applied.push("no points needed rename — skip");
    }

    // Drop old keys regardless (idempotent: deleting a non-existent key is a no-op).
    const oldKeys = ALL_RENAMES.map(([oldKey]) => oldKey);
    await this.store.deletePayloadKeys(this.collection, oldKeys);
    applied.push(`deleted ${oldKeys.length} old ownership keys`);

    return { applied };
  }
}
