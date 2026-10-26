/**
 * DirectoryChunkGrouper — folds the chunks under a directory into one level of
 * it: the files directly inside with their top-level symbols, and the
 * subdirectories with their file counts (agent turn economy N2).
 *
 * Pure data transformer, no I/O.
 */

import type { DirectoryOutline } from "../../../contracts/types/directory-outline.js";
import type { SearchResult } from "../../../contracts/types/search-result.js";
import { memberOwnerOf, splitFragmentBase } from "./split-fragment.js";
import type { ScrollChunk } from "./types.js";

/** Files listed per directory answer; the rest is counted in `total`. */
export const DIRECTORY_FILE_CAP = 50;

/** Top-level symbols listed per file before the `+N more` remainder. */
const FILE_SYMBOL_CAP = 8;

export interface DirectoryGrouping {
  files: SearchResult[];
  outline: DirectoryOutline;
}

/**
 * The top-level symbol a chunk belongs to: a member names its declaring
 * container, a `#partN` window the owner of its symbol. An unnamed block chunk
 * and a documentation section name none.
 */
function topLevelSymbolOf(row: ScrollChunk): string | undefined {
  if (row.payload.isDocumentation) return undefined;
  const base = splitFragmentBase(row.payload);
  if (base !== undefined) return memberOwnerOf(base) ?? base;
  const parent = row.payload.parentSymbolId as string | undefined;
  const own = row.payload.symbolId as string | undefined;
  return parent || own || undefined;
}

function fileRow(relativePath: string, rows: ScrollChunk[]): SearchResult {
  const sorted = [...rows].sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0));
  const symbols = [...new Set(sorted.map(topLevelSymbolOf).filter((id): id is string => id !== undefined))];
  const listed =
    symbols.length > FILE_SYMBOL_CAP
      ? [...symbols.slice(0, FILE_SYMBOL_CAP), `+${symbols.length - FILE_SYMBOL_CAP} more`]
      : symbols;
  return {
    id: sorted[0].id,
    score: 1.0,
    payload: { relativePath, language: sorted[0].payload.language, symbols: listed },
  };
}

export const DirectoryChunkGrouper = {
  /**
   * One level of `dir` (no trailing `/`) from the chunks of the files under it;
   * undefined when no chunk lies under it. Chunks outside `dir` are ignored.
   */
  group(dir: string, rows: readonly ScrollChunk[]): DirectoryGrouping | undefined {
    const prefix = `${dir}/`;
    const byFile = new Map<string, ScrollChunk[]>();
    const filesBySubdir = new Map<string, Set<string>>();
    for (const chunk of rows) {
      const path = chunk.payload.relativePath;
      if (typeof path !== "string" || !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        const fileRows = byFile.get(path);
        if (fileRows) fileRows.push(chunk);
        else byFile.set(path, [chunk]);
        continue;
      }
      const subdir = `${prefix}${rest.slice(0, slash)}`;
      const files = filesBySubdir.get(subdir);
      if (files) files.add(path);
      else filesBySubdir.set(subdir, new Set([path]));
    }
    if (byFile.size === 0 && filesBySubdir.size === 0) return undefined;

    const paths = [...byFile.keys()].sort();
    return {
      files: paths.slice(0, DIRECTORY_FILE_CAP).map((path) => fileRow(path, byFile.get(path) ?? [])),
      outline: {
        kind: "directory",
        dir,
        subdirs: [...filesBySubdir.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([subdir, files]) => ({ dir: subdir, fileCount: files.size })),
        total: paths.length,
        truncated: paths.length > DIRECTORY_FILE_CAP,
      },
    };
  },
};
