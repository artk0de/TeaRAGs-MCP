/**
 * The lean composition seam for `tea-rags project indexed` (bd
 * tea-rags-mcp-ueplg): binds the index-membership query to the user's data
 * directory. It imports the query module alone — never the api assembly barrel
 * — because the plugin's PreToolUse hooks run the command on every `Read` and
 * every file-reading Bash command, and the barrel costs ~350 ms of module
 * loading (whole command p50 ~150 ms without it). The layer rule allows the
 * edge: bootstrap → core/api/* (`.claude/rules/domain-boundaries.md`).
 */

import { findFirstIndexedFileInDataDir, type IndexedFileMatch } from "../core/api/internal/ops/indexed-file-query.js";
import { appDataDir, snapshotsDir } from "./config/index.js";

export type { IndexedFileMatch };

/** The first of `paths` an index lists, against `TEA_RAGS_DATA_DIR` (default `~/.tea-rags`). */
export async function findFirstIndexedFileInAppData(paths: readonly string[]): Promise<IndexedFileMatch | null> {
  return findFirstIndexedFileInDataDir({ dataDir: appDataDir(), snapshotsDir: snapshotsDir() }, paths);
}
