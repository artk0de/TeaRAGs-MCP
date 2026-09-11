/**
 * LanguageVersionDriftMonitor — reports when a language's INDEXED data was
 * produced by an older build than the one running (bd tea-rags-mcp-frwka).
 *
 * Complements `SchemaDriftMonitor`, never merges into it. That one compares
 * payload signal-descriptor KEYS, so bumping a tree-sitter grammar or rewriting
 * a resolver produces exactly zero drift signal — the keys are identical while
 * every chunk boundary and every edge for that language may have moved. This
 * one compares the per-language version stamp the run recorded
 * (`CollectionEntry.languageVersions`) against what the current build declares.
 */

import { SHARED_LANGUAGE, type LanguageCodeVersions } from "../../../contracts/types/language.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import { formatIndexDriftReport, IndexDriftReporter } from "./report.js";

/** One version axis, in the order a drift report lists them. */
export type LanguageVersionAxis = "grammar" | "chunking" | "walker" | "codegraphSchema";

const AXES: readonly LanguageVersionAxis[] = ["grammar", "chunking", "walker", "codegraphSchema"];

/**
 * Axes whose movement relocates chunk point ids. Point ids hash file content
 * and line range, so nothing short of a full rebuild is coherent for these —
 * the same dividing line `epic-completion-gate.md` draws between `--force` and
 * `--force-enrichments`.
 */
const CHUNK_SET_AXES: ReadonlySet<LanguageVersionAxis> = new Set<LanguageVersionAxis>(["grammar", "chunking"]);

/**
 * The version an unstamped integer axis is read as. Entries written before
 * versioning existed carry no stamp at all, and 1 IS the revision the code was
 * at when they were written — so the first bump after this shipped fires on
 * them, which is the point. `grammar` has no such seed: guessing which grammar
 * an old index parsed with would recommend a full reindex on a coin flip.
 *
 * `*` leans on the same read rather than special-casing an absent stamp: every
 * index predates the pseudo-language, so all of them are seeded at 1, and
 * `sharedVersions.walker` starts at 2 precisely so each reports `*.walker`
 * once.
 */
const SEEDED_VERSION = 1;

export interface LanguageVersionAxisDrift {
  axis: LanguageVersionAxis;
  indexed: string | number;
  current: string | number;
}

export interface LanguageVersionDrift {
  language: string;
  axes: LanguageVersionAxisDrift[];
}

/** Registry surface the monitor needs: the stamp the last qualifying run wrote. */
export interface LanguageVersionStampReader {
  get: (collectionName: string) => { languageVersions?: Record<string, Partial<LanguageCodeVersions>> } | null;
}

/**
 * Stats surface the monitor needs: which languages the index actually holds.
 * Without it a TS-only project would be told to rebuild Ruby.
 */
export interface IndexedLanguageReader {
  load: (collectionName: string) => { distributions?: { language?: Record<string, number> } } | null;
}

export class LanguageVersionDriftMonitor implements IndexDriftMonitor {
  readonly axis = "languageVersions" as const;

  constructor(
    private readonly registry: LanguageVersionStampReader,
    private readonly statsCache: IndexedLanguageReader,
    private readonly currentVersions: ReadonlyMap<string, LanguageCodeVersions>,
  ) {}

  /**
   * One finding per moved axis, each carrying what THAT axis costs: a chunk-set
   * axis relocates every point id, so it can only be repaired by a full
   * reindex; the rest are edges, repairable by a recompute narrowed to the one
   * language that moved — except `*`, whose sources ran under every language,
   * so its recompute cannot be narrowed at all.
   */
  check(collectionName: string): IndexDriftFinding[] {
    const entry = this.registry.get(collectionName);
    if (!entry) return [];
    // An empty or missing stats cache means the language distribution is
    // unknown, so no per-language claim can be made — but `*` is in no
    // distribution to begin with and is compared regardless.
    const stats = this.statsCache.load(collectionName);
    const present = Object.keys(stats?.distributions?.language ?? {});

    return LanguageVersionDriftMonitor.detectDrift(entry.languageVersions, this.currentVersions, present).flatMap(
      (drift) =>
        drift.axes.map((axis) => ({
          axis: this.axis,
          subject: `${drift.language}.${axis.axis}`,
          indexed: String(axis.indexed),
          current: String(axis.current),
          remedy: CHUNK_SET_AXES.has(axis.axis)
            ? ({ kind: "force" } as const)
            : ({
                kind: "recompute",
                trajectories: new Set(["codegraph"]),
                languages: drift.language === SHARED_LANGUAGE ? null : new Set([drift.language]),
              } as const),
        })),
    );
  }

  /** Check drift for a filesystem path. Returns null when nothing moved. */
  async checkAndConsume(path: string): Promise<string | null> {
    try {
      return this.checkByCollectionName(resolveCollectionName(await validatePath(path)));
    } catch {
      return null;
    }
  }

  /** Check drift when the collection name is already known. */
  checkByCollectionName(collectionName: string): string | null {
    const report = new IndexDriftReporter([this]).checkByCollectionName(collectionName);
    return report && formatIndexDriftReport(report);
  }

  /**
   * Compare the stamp against the current build, restricted to the languages
   * the index actually contains — plus `*`, which no distribution ever names
   * because it is not a language: it stands for the kernel, resolver chain and
   * chunker sources every language runs through, so it is compared whatever the
   * index holds. Sorted by the caller's language order so the report is stable.
   */
  static detectDrift(
    indexed: Record<string, Partial<LanguageCodeVersions>> | undefined,
    current: ReadonlyMap<string, LanguageCodeVersions>,
    presentLanguages: readonly string[],
  ): LanguageVersionDrift[] {
    const drifts: LanguageVersionDrift[] = [];
    for (const language of new Set([...presentLanguages, SHARED_LANGUAGE])) {
      const currentVersions = current.get(language);
      // A stamped language the build no longer declares carries no claim we can
      // check — a removed vertical is not drift.
      if (!currentVersions) continue;
      const stamp = indexed?.[language] ?? {};
      const axes = AXES.flatMap((axis) => driftOnAxis(axis, stamp, currentVersions));
      if (axes.length > 0) drifts.push({ language, axes });
    }
    return drifts;
  }
}

function driftOnAxis(
  axis: LanguageVersionAxis,
  stamp: Partial<LanguageCodeVersions>,
  current: LanguageCodeVersions,
): LanguageVersionAxisDrift[] {
  if (axis === "grammar") {
    const indexed = stamp.grammar;
    const currentGrammar = current.grammar;
    // Either side unknown → no claim. An index whose grammar was never stamped
    // is not evidence that the grammar changed.
    if (indexed === undefined || currentGrammar === undefined || indexed === currentGrammar) return [];
    return [{ axis, indexed, current: currentGrammar }];
  }
  const indexed = stamp[axis] ?? SEEDED_VERSION;
  const currentVersion = current[axis];
  return indexed === currentVersion ? [] : [{ axis, indexed, current: currentVersion }];
}
