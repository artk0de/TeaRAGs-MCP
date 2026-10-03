/**
 * TypeScript parses carried from one codegraph run to the next inside a
 * long-lived process — the warm working-tree graph child, which builds the same
 * tree again after every edit and would otherwise re-parse the default lib, the
 * dependency `.d.ts` surface and every unchanged project file per build.
 *
 * Only PARSES cross the run boundary, never Programs: a `ts.Program` embeds its
 * module-resolution answers and its host's existence probes, and a file added
 * or deleted between two runs moves those without touching any file a Program
 * holds — so a retained Program cannot be proved equal to the one a cold run
 * would build. A parse can: it is a function of the file's text and the parse
 * options alone. Every read re-stats the file and hands the stored parse back
 * only when path, mtime, size and the options key all match what it was parsed
 * under — the same stamp rule `TSProgramCache` already applies within a run.
 * The stat is taken BEFORE the parse reads the file, so a write racing the
 * parse leaves a stamp older than the file and the next read re-parses.
 *
 * Bounded in source-text bytes, least recently used first, like the run-level
 * parse budget it mirrors. EXEMPT files (the default lib) are kept outside the
 * budget: a small fixed set, and the single largest parse cost the store exists
 * to pay once.
 */
import { statSync } from "node:fs";

import type ts from "typescript";

/** Default text budget — the run-level parse budget (`TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT`), so the store retains about what one run's parse map does. */
export const TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT = 25 * 1024 * 1024;

/** Counters since construction, plus what the store holds now. */
export interface TSSourceFileStoreUsage {
  /** Reads answered by a stored parse. */
  reused: number;
  /** Reads that parsed (a miss, a stale stamp, other options). */
  parsed: number;
  retainedFiles: number;
  /** Text of the budgeted (non-exempt) parses held. */
  retainedTextBytes: number;
}

interface StoredSourceFile {
  sourceFile: ts.SourceFile;
  variantKey: string;
  mtimeMs: number;
  size: number;
  exempt: boolean;
}

export class TSSourceFileStore {
  /** Insertion-ordered LRU — the first key is the least recently used. */
  private readonly entries = new Map<string, StoredSourceFile>();
  private textBytes = 0;
  private reused = 0;
  private parsed = 0;

  constructor(private readonly maxTextBytes: number = TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT) {}

  /**
   * The stored parse of `fileName` when its stamp and `variantKey` still hold,
   * else `parse()`'s result, stored under the stamp taken before it ran. A file
   * that cannot be stat'ed is parsed and never stored (and a stored parse of it
   * is dropped).
   *
   * @param variantKey Everything besides the text the parse depends on — the
   *   caller's language version, module format and compiler options.
   * @param options.exempt Keep the parse outside the text budget (the default lib).
   */
  getOrParse(
    fileName: string,
    variantKey: string,
    parse: () => ts.SourceFile | undefined,
    options: { exempt?: boolean } = {},
  ): ts.SourceFile | undefined {
    const stamp = fileStamp(fileName);
    const stored = this.entries.get(fileName);
    if (
      stored &&
      stamp &&
      stored.variantKey === variantKey &&
      stored.mtimeMs === stamp.mtimeMs &&
      stored.size === stamp.size
    ) {
      this.entries.delete(fileName);
      this.entries.set(fileName, stored);
      this.reused += 1;
      return stored.sourceFile;
    }
    if (stored) this.drop(fileName, stored);
    this.parsed += 1;
    const sourceFile = parse();
    if (!stamp || sourceFile === undefined) return sourceFile;
    const exempt = options.exempt === true;
    this.entries.set(fileName, { sourceFile, variantKey, mtimeMs: stamp.mtimeMs, size: stamp.size, exempt });
    if (!exempt) {
      this.textBytes += sourceFile.text.length;
      this.evictOverflow();
    }
    return sourceFile;
  }

  usage(): TSSourceFileStoreUsage {
    return {
      reused: this.reused,
      parsed: this.parsed,
      retainedFiles: this.entries.size,
      retainedTextBytes: this.textBytes,
    };
  }

  private evictOverflow(): void {
    for (const [fileName, stored] of this.entries) {
      if (this.textBytes <= this.maxTextBytes) return;
      if (!stored.exempt) this.drop(fileName, stored);
    }
  }

  private drop(fileName: string, stored: StoredSourceFile): void {
    this.entries.delete(fileName);
    if (!stored.exempt) this.textBytes -= stored.sourceFile.text.length;
  }
}

function fileStamp(fileName: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(fileName);
    return stats.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : null;
  } catch {
    return null;
  }
}
