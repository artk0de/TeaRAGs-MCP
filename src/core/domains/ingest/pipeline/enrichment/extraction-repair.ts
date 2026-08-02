/**
 * Which files a provider must re-extract before its per-file store matches the
 * code, and which of its rows no longer belong (bd tea-rags-mcp-6goqa).
 *
 * Pure on purpose: two maps in, two lists out, no collaborators. That is what
 * makes the exactness invariant cheap to assert, and the check is the whole
 * point — a graph that merely CONTAINS a file tells you nothing about whether
 * its rows are current, which is how a dead import edge survived every
 * incremental reindex once its file stopped changing.
 */

/** Outcome of diffing a provider's persisted state against the run's files. */
export interface ExtractionRepair {
  /** Eligible files whose persisted state is missing or out of date. */
  repair: string[];
  /** Persisted rows for files that are no longer eligible. */
  orphans: string[];
}

/**
 * `repair` = eligible files absent from the store, plus eligible files whose
 * persisted hash differs from the current one. A persisted `null` — a row
 * written before the provider stored hashes — counts as a difference, because
 * "assume it is current" is the assumption that hid the shadow-DuckDB bug.
 *
 * `orphans` = rows for files that are no longer eligible: deleted, or excluded
 * after an exclusion-config change.
 *
 * Both lists empty means the store matches the code and the run has nothing to
 * repair.
 */
export function computeExtractionRepair(
  eligible: ReadonlyMap<string, string>,
  persisted: ReadonlyMap<string, string | null>,
): ExtractionRepair {
  const repair: string[] = [];
  for (const [path, hash] of eligible) {
    // `undefined` (no row) and `null` (row predating the hash column) both fall
    // out of the inequality on their own, since an eligible file's hash is
    // always a string. Spelling either out separately would be a branch no
    // input can reach independently.
    const known = persisted.get(path);
    if (known !== hash) repair.push(path);
  }

  const orphans: string[] = [];
  for (const path of persisted.keys()) {
    if (!eligible.has(path)) orphans.push(path);
  }

  return { repair, orphans };
}
