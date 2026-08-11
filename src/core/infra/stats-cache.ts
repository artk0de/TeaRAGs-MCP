import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CollectionSignalStats,
  Distributions,
  PayloadKeyOwner,
  ScopedSignalStats,
  ScoreBackground,
  SignalStats,
} from "../contracts/types/trajectory.js";

interface StatsFileContentV6 {
  version: 6;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  perLanguage: Record<string, Record<string, { source: SignalStats; test?: SignalStats }>>;
  distributions: Distributions;
  payloadFieldKeys?: string[];
  /** Collection similarity scale — absent in files written before v6. */
  scoreBackground?: ScoreBackground;
}

interface StatsFileContentV5 {
  version: 5;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  perLanguage: Record<string, Record<string, { source: SignalStats; test?: SignalStats }>>;
  distributions: Distributions;
  payloadFieldKeys?: string[];
}

interface StatsFileContentV4 {
  version: 4;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  perLanguage: Record<string, Record<string, SignalStats>>;
  distributions: Distributions;
  payloadFieldKeys?: string[];
}

type StatsFileContent = StatsFileContentV6 | StatsFileContentV5 | StatsFileContentV4;

const CURRENT_VERSION = 6;

export interface SchemaDrift {
  added: string[];
  removed: string[];
}

export class StatsCache {
  constructor(private readonly snapshotsDir: string) {}

  /** Load cached stats from JSON file. Returns null if missing/corrupt. */
  load(collectionName: string): (CollectionSignalStats & { payloadFieldKeys?: string[] }) | null {
    const filePath = this.filePath(collectionName);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as StatsFileContent;
      if (data.version !== 4 && data.version !== 5 && data.version !== 6) return null;

      const perLanguage = new Map<string, Map<string, ScopedSignalStats>>();
      if (data.version === 4) {
        for (const [lang, signals] of Object.entries(data.perLanguage ?? {})) {
          const langMap = new Map<string, ScopedSignalStats>();
          for (const [key, val] of Object.entries(signals)) {
            langMap.set(key, { source: val });
          }
          perLanguage.set(lang, langMap);
        }
      } else {
        for (const [lang, signals] of Object.entries(data.perLanguage ?? {})) {
          const langMap = new Map<string, ScopedSignalStats>();
          for (const [key, val] of Object.entries(signals)) {
            langMap.set(key, val as ScopedSignalStats);
          }
          perLanguage.set(lang, langMap);
        }
      }

      return {
        perSignal: new Map(Object.entries(data.perSignal)),
        perLanguage,
        distributions: data.distributions,
        computedAt: data.computedAt,
        payloadFieldKeys: data.payloadFieldKeys,
        ...(data.version === 6 && data.scoreBackground ? { scoreBackground: data.scoreBackground } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Save stats to JSON file. */
  save(collectionName: string, stats: CollectionSignalStats, payloadFieldKeys?: string[]): void {
    mkdirSync(this.snapshotsDir, { recursive: true });
    const perLanguageObj: Record<string, Record<string, { source: SignalStats; test?: SignalStats }>> = {};
    for (const [lang, signals] of stats.perLanguage) {
      const signalObj: Record<string, { source: SignalStats; test?: SignalStats }> = {};
      for (const [key, scoped] of signals) {
        signalObj[key] = { source: scoped.source, ...(scoped.test ? { test: scoped.test } : {}) };
      }
      perLanguageObj[lang] = signalObj;
    }
    const content: StatsFileContentV6 = {
      version: CURRENT_VERSION as 6,
      collectionName,
      computedAt: stats.computedAt,
      perSignal: Object.fromEntries(stats.perSignal),
      perLanguage: perLanguageObj,
      distributions: stats.distributions,
      payloadFieldKeys,
      ...(stats.scoreBackground ? { scoreBackground: stats.scoreBackground } : {}),
    };
    writeFileSync(this.filePath(collectionName), JSON.stringify(content, null, 2), "utf-8");
  }

  /** Copy the stats file from sourceCollection to targetCollection. No-op if source is absent. */
  clone(sourceCollection: string, targetCollection: string): void {
    const from = this.filePath(sourceCollection);
    if (!existsSync(from)) return;
    copyFileSync(from, this.filePath(targetCollection));
  }

  /** Invalidate (delete) cache file. */
  invalidate(collectionName: string): void {
    const filePath = this.filePath(collectionName);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  private filePath(collectionName: string): string {
    return join(this.snapshotsDir, `${collectionName}.stats.json`);
  }

  /** Compare cached payload keys vs current. Returns null if no drift or no cached keys. */
  static checkSchemaDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
    if (!cachedKeys) return null;
    const cachedSet = new Set(cachedKeys);
    const currentSet = new Set(currentKeys);
    const added = currentKeys.filter((k) => !cachedSet.has(k));
    const removed = cachedKeys.filter((k) => !currentSet.has(k));
    if (added.length === 0 && removed.length === 0) return null;
    return { added, removed };
  }

  /**
   * Format a human-readable warning for schema drift.
   *
   * With `owners` supplied, the hint names the narrowest command that actually
   * repopulates the drifted keys: an enrichment recompute when every new key
   * belongs to a trajectory that has an enrichment provider, a full reindex
   * otherwise, and nothing at all when the drift is removals only. Without
   * `owners` the legacy full-reindex hint is kept, so callers that have no
   * attribution to give are unaffected.
   */
  static formatSchemaDriftWarning(drift: SchemaDrift, owners?: readonly PayloadKeyOwner[]): string {
    const remedy = owners ? resolveDriftRemedy(drift, owners) : null;
    const lines: string[] = ["Payload schema changed since last indexing."];
    if (drift.added.length > 0) {
      const verb = remedy?.kind === "recompute" ? "recompute" : "reindex";
      lines.push(`New fields: ${drift.added.join(", ")} (require ${verb} to populate)`);
    }
    if (drift.removed.length > 0) {
      lines.push(`Removed fields: ${drift.removed.join(", ")} (no longer used)`);
    }
    lines.push(remedy ? remedy.hint : "Run index_codebase with forceReindex=true to update.");
    return lines.join("\n");
  }
}

/** The single command a drift warning should recommend. */
interface DriftRemedy {
  kind: "none" | "recompute" | "reindex";
  hint: string;
}

/**
 * Pick ONE remedy for the whole drift.
 *
 * A full reindex rebuilds the enrichment layer as well, so a drift that mixes
 * enrichment-owned keys with chunker-owned ones escalates to the reindex and
 * drops the per-trajectory list — emitting two competing commands would leave
 * the reader to work out which one subsumes the other.
 */
function resolveDriftRemedy(drift: SchemaDrift, owners: readonly PayloadKeyOwner[]): DriftRemedy {
  if (drift.added.length === 0) {
    return {
      kind: "none",
      hint: "Removed fields are simply ignored by the current build — no action required.",
    };
  }

  const ownerByKey = new Map(owners.map((o) => [o.key, o]));
  const trajectories = new Set<string>();
  for (const key of drift.added) {
    const owner = ownerByKey.get(key);
    // An unattributed key is treated as chunker-owned: assuming it is cheap to
    // recompute would hand back a command that silently populates nothing.
    if (!owner?.recomputable || owner.trajectory === undefined) {
      return { kind: "reindex", hint: "Run: tea-rags index-codebase --force" };
    }
    trajectories.add(owner.trajectory);
  }

  const scope = [...trajectories].sort().join(",");
  return { kind: "recompute", hint: `Run: tea-rags index-codebase --force-enrichments ${scope}` };
}
