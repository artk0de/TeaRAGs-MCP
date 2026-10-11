/**
 * The content hash of one source file — the value the ingest pipeline's
 * synchronizers compute per file and the enrichment providers stamp onto their
 * per-file rows (`cg_symbols_files.content_hash`, bd tea-rags-mcp-6goqa). The
 * NEXT run's repair check diffs those rows against a fresh scan, so every
 * producer of a stamped hash must use this one definition: a second one makes
 * every row it wrote read as drifted forever.
 *
 * In primitives because two layers that may not import each other hash
 * files under this contract: the ingest synchronizers and the working-tree
 * graph (its build stamps walked files, its cache compares a tree's files
 * against what a previously built graph holds). Reading a file to hash it is
 * I/O and lives with its only caller, the working-tree graph walk
 * (`domains/trajectory/codegraph/working-tree/file-content-hash-reader.ts`).
 */
import { createHash } from "node:crypto";

/** sha256 hex of the file's text (read as UTF-8). */
export function fileContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
