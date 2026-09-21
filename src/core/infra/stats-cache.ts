import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  /**
   * When this collection's stats file was last written, as an opaque revision
   * marker; undefined when there is no file. A `stat` only — cheap enough for a
   * consumer to probe on every request before deciding to re-read.
   *
   * Exists because a stats file is written by whichever PROCESS ran the index,
   * while a long-running server holds its copy in memory. Without a marker to
   * compare, that server cannot tell a fresh recompute from the state it
   * already has, and keeps serving percentiles the CLI replaced (bd
   * tea-rags-mcp-yntsd). `computedAt` inside the file cannot serve: reading it
   * is the very work the marker exists to avoid.
   */
  lastWrittenAt(collectionName: string): number | undefined {
    try {
      return statSync(this.filePath(collectionName)).mtimeMs;
    } catch {
      return undefined;
    }
  }

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
