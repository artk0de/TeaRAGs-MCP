import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CollectionSignalStats,
  Distributions,
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
            langMap.set(key, val);
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
      version: CURRENT_VERSION,
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
}
