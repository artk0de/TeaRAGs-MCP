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

import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";

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

export class LanguageVersionDriftMonitor {
  constructor(
    private readonly registry: LanguageVersionStampReader,
    private readonly statsCache: IndexedLanguageReader,
    private readonly currentVersions: ReadonlyMap<string, LanguageCodeVersions>,
  ) {}

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
    const entry = this.registry.get(collectionName);
    if (!entry) return null;
    // No stats cache means the language distribution is unknown, and a drift
    // report scoped to "every language we support" would name languages the
    // index has never held. Stay silent rather than guess.
    const stats = this.statsCache.load(collectionName);
    const present = Object.keys(stats?.distributions?.language ?? {});
    if (present.length === 0) return null;

    const drifts = LanguageVersionDriftMonitor.detectDrift(entry.languageVersions, this.currentVersions, present);
    return drifts.length === 0 ? null : LanguageVersionDriftMonitor.formatWarning(drifts);
  }

  /**
   * Compare the stamp against the current build, restricted to the languages
   * the index actually contains. Sorted by the caller's language order so the
   * report is stable.
   */
  static detectDrift(
    indexed: Record<string, Partial<LanguageCodeVersions>> | undefined,
    current: ReadonlyMap<string, LanguageCodeVersions>,
    presentLanguages: readonly string[],
  ): LanguageVersionDrift[] {
    const drifts: LanguageVersionDrift[] = [];
    for (const language of presentLanguages) {
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

  /**
   * Render ONE command for the whole report.
   *
   * A full reindex rebuilds the enrichment layer too, so a report mixing
   * chunk-set axes with edge-only ones escalates to the reindex and drops the
   * recompute — emitting two competing commands would leave the reader to work
   * out which subsumes the other. Same doctrine as the payload-key drift hint.
   */
  static formatWarning(drifts: readonly LanguageVersionDrift[]): string {
    const lines = ["Language tooling moved since last indexing."];
    for (const drift of drifts) {
      lines.push(`${drift.language}: ${drift.axes.map(formatAxis).join(", ")}`);
    }
    lines.push(`Run: ${resolveVersionDriftCommand(drifts)}`);
    return lines.join("\n");
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

function formatAxis(axis: LanguageVersionAxisDrift): string {
  return `${axis.axis} ${axis.indexed}→${axis.current}`;
}

/**
 * Pick the single command that repopulates every drifted language.
 *
 * The recompute IS narrowed by language — `epic-completion-gate.md` makes that
 * mandatory, and it is what keeps the measure-fix-measure loop short. The full
 * reindex is deliberately NOT: it builds a new collection and flips the alias,
 * so `--force --languages ruby` would leave an index containing only Ruby.
 * Recommending that on a polyglot project is a data-loss-shaped mistake.
 */
function resolveVersionDriftCommand(drifts: readonly LanguageVersionDrift[]): string {
  const movesChunkSet = drifts.some((d) => d.axes.some((a) => CHUNK_SET_AXES.has(a.axis)));
  if (movesChunkSet) return "tea-rags index-codebase --force";
  const languages = drifts.map((d) => d.language).join(",");
  return `tea-rags index-codebase --force-enrichments codegraph --languages ${languages}`;
}
