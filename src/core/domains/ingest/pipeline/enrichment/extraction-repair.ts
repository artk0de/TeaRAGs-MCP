/**
 * Which files a provider must re-extract before its per-file store matches the
 * code, and which of its rows no longer belong (bd tea-rags-mcp-6goqa).
 *
 * Pure on purpose: maps in, two lists out, no collaborators — the diagnostic
 * force flag is a PARAMETER rather than an env read for the same reason. That is what
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
 *
 * `forceAll` (diagnostic only, off by default) skips the hash comparison and
 * treats every eligible file as drifted. It exists because this comparison is
 * the ONLY thing standing between a repeat run and a full re-resolve: pass-2
 * (`GraphBuildFinalizer#resolveAndUpsert`) resolves whatever reached the spill,
 * unconditionally, so the file set is decided here or nowhere. Measured on a
 * 10,374-file TypeScript corpus, resolve was 2,106,536 ms of a 2,159,393 ms
 * codegraph enrichment — 97.6% — and a repeat run shrank it to 568 ms, which is
 * why the dominant phase had never been CPU-profiled (bd tea-rags-mcp-bij2m).
 * Orphan detection is hash-independent and stays untouched under the flag.
 */
export function computeExtractionRepair(
  eligible: ReadonlyMap<string, string>,
  persisted: ReadonlyMap<string, string | null>,
  forceAll = false,
): ExtractionRepair {
  const repair: string[] = [];
  for (const [path, hash] of eligible) {
    // `undefined` (no row) and `null` (row predating the hash column) both fall
    // out of the inequality on their own, since an eligible file's hash is
    // always a string. Spelling either out separately would be a branch no
    // input can reach independently.
    const known = persisted.get(path);
    if (forceAll || known !== hash) repair.push(path);
  }

  const orphans: string[] = [];
  for (const path of persisted.keys()) {
    if (!eligible.has(path)) orphans.push(path);
  }

  return { repair, orphans };
}
