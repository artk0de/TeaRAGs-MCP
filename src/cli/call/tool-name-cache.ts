import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tool names for `tea-rags call <TAB>` (bd tea-rags-mcp-8vy3o).
 *
 * The callable set is whatever the server registers under the current config
 * (codegraph tools only when codegraph is on), and building that server —
 * Qdrant, embeddings, composition — is far too slow for a shell completion.
 * So every `call` run records the set it observed from `listTools`, and
 * completion reads that record. Before the first run completion offers
 * nothing; after a config change it is one `call` run stale.
 */
const CACHE_FILE = "call-tool-names.json";

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/** Persist the observed callable tool names. Best-effort: never throws. */
export function rememberCallToolNames(names: readonly string[], dataDir: string = resolveDataDir()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const target = join(dataDir, CACHE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tools: [...names].sort() })}\n`);
    renameSync(tmp, target);
  } catch {
    // Completion is a convenience; a read-only data dir must not fail a call.
  }
}

/** The names the last `call` run observed, or `[]`. Never throws. */
export function recallCallToolNames(dataDir: string = resolveDataDir()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, CACHE_FILE), "utf8")) as { tools?: unknown };
    return Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
