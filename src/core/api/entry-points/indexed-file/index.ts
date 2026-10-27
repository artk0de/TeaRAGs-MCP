/**
 * Narrow read for the bootstrap indexed-file query (bd tea-rags-mcp-ueplg).
 *
 * `bootstrap/indexed-file.ts` backs `tea-rags project indexed`, which the
 * PreToolUse deny hook runs on every Read / shell read. Routing it through the
 * api assembly barrel (`../index.ts`) costs ~350 ms per call; this file
 * re-exports only the snapshot-membership query, so bootstrap still reaches
 * the domain through `core/api` (`domain-boundaries.md`).
 */
export { findFirstIndexedFileInDataDir, type IndexedFileMatch } from "../../internal/ops/indexed-file-query.js";
