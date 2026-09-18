/**
 * Language affinity plan — which pinned workers one run of one collection is
 * served by (bd tea-rags-mcp-sgo8v).
 *
 * Collection affinity pins everything stateful to ONE worker, so a mixed
 * repository's language windows run back to back: on taxdome a combined
 * codegraph recompute took 125,578 ms against 34,958 (Ruby alone) + 90,589
 * (TypeScript alone) — a sum to the millisecond, with zero interleave. Per-
 * language affinity gives each partition its own worker, and the sum becomes a
 * max.
 *
 * A partition is not free. Each one holds a FULL copy of the run's pass-1
 * state — every partition absorbs every file, owning only its own (see
 * `FileExtractionAbsorbRole`), because the symbol table and run-global maps are
 * language-blind and a partition that saw only its own language would resolve
 * differently. So the plan splits only where a second pass-2 thread has work
 * worth its isolate and its copy:
 *
 *   - the largest language alone, every other language together — the critical
 *     path is the largest language's pass-2, and a third partition would only
 *     split the side that finishes first anyway;
 *   - only when both sides reach `minFilesPerPartition`, the same
 *     files-per-thread bar the extraction fan-out applies before it spins a
 *     thread up (`INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD`);
 *   - collection completion (cycles, PageRank, and every file of no known
 *     language) on the SMALLER partition: it finishes pass-2 first, and it is
 *     not the one holding the TypeScript `ts.Program`.
 */

export interface LanguageAffinityPartition {
  /** Languages joined by `+`, sorted — also the worker's provider-cache discriminator. */
  readonly label: string;
  /** The pool routing key: `<collection>::<label>`. */
  readonly routingKey: string;
  /** The language labels (as `partitionByExtension` names them) this partition owns. */
  readonly languages: ReadonlySet<string>;
  /** Files of the run it owns. */
  readonly fileCount: number;
}

export interface LanguageAffinityPlan {
  /** Largest language first. */
  readonly partitions: readonly LanguageAffinityPartition[];
  /** Owns cycles + PageRank, and every file whose extension names no language. */
  readonly completionOwner: LanguageAffinityPartition;
  partitionOfPath: (relPath: string) => LanguageAffinityPartition;
  partitionOfLanguage: (language: string) => LanguageAffinityPartition;
}

export interface LanguageAffinityPlanInput {
  /** The PHYSICAL collection name the run writes; prefixes every routing key. */
  collectionName: string;
  /** Every repo-relative path the run will feed through the file phase. */
  runRelPaths: readonly string[];
  /** The provider's declared extension → language map (`workerDescriptor.languageAffinity`). */
  partitionByExtension: Readonly<Record<string, string>>;
  /** Files each side must own before it earns a worker. */
  minFilesPerPartition: number;
  /** Partitions the pool can host; below 2 there is nothing to plan. */
  maxPartitions: number;
}

/** The language `relPath` belongs to by its extension, or `undefined` for none. */
export function languageOfPath(
  relPath: string,
  partitionByExtension: Readonly<Record<string, string>>,
): string | undefined {
  const slash = relPath.lastIndexOf("/");
  const dot = relPath.lastIndexOf(".");
  if (dot <= slash) return undefined;
  return partitionByExtension[relPath.slice(dot)];
}

/**
 * Plan the run's partitions, or `null` when it should keep collection affinity:
 * fewer than two languages, a pool that cannot host two partitions, or a side
 * too small to earn its worker.
 */
export function planLanguageAffinity(input: LanguageAffinityPlanInput): LanguageAffinityPlan | null {
  if (input.maxPartitions < 2) return null;
  const minFiles = Math.max(1, input.minFilesPerPartition);

  const filesByLanguage = new Map<string, number>();
  for (const relPath of input.runRelPaths) {
    const language = languageOfPath(relPath, input.partitionByExtension);
    if (language !== undefined) filesByLanguage.set(language, (filesByLanguage.get(language) ?? 0) + 1);
  }
  // Largest first; a tie falls back to the name, so the plan never depends on
  // the order the run listed its files in.
  let remaining = [...filesByLanguage].sort(([aLang, aCount], [bLang, bCount]) =>
    bCount !== aCount ? bCount - aCount : aLang.localeCompare(bLang),
  );

  const groups: [string, number][][] = [];
  while (groups.length < input.maxPartitions - 1 && remaining.length > 1) {
    const [lead, ...rest] = remaining;
    const restFiles = rest.reduce((sum, [, count]) => sum + count, 0);
    if (lead[1] < minFiles || restFiles < minFiles) break;
    groups.push([lead]);
    remaining = rest;
  }
  if (groups.length === 0) return null;
  groups.push(remaining);

  const partitions = groups.map((group): LanguageAffinityPartition => {
    const languages = group.map(([language]) => language).sort();
    const label = languages.join("+");
    return {
      label,
      routingKey: `${input.collectionName}::${label}`,
      languages: new Set(languages),
      fileCount: group.reduce((sum, [, count]) => sum + count, 0),
    };
  });
  // The last group is the remainder, which wins a tie: it is the side that
  // never carries the single largest language.
  const completionOwner = partitions.reduce((smallest, candidate) =>
    candidate.fileCount <= smallest.fileCount ? candidate : smallest,
  );
  const byLanguage = new Map<string, LanguageAffinityPartition>();
  for (const partition of partitions) for (const language of partition.languages) byLanguage.set(language, partition);

  const partitionOfLanguage = (language: string): LanguageAffinityPartition =>
    byLanguage.get(language) ?? completionOwner;
  return {
    partitions,
    completionOwner,
    partitionOfLanguage,
    partitionOfPath: (relPath) => {
      const language = languageOfPath(relPath, input.partitionByExtension);
      return language === undefined ? completionOwner : partitionOfLanguage(language);
    },
  };
}
