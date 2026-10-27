/**
 * Zero-chunk probe (bd tea-rags-mcp-6xdwe) — offline, read-only.
 *
 * Runs the COMPILED ingest path (`build/`) over a list of files from a repo
 * root and reports every file that would reach the index with ZERO chunks,
 * grouped by reason. Per file it applies exactly what `SourceFileIngestor`
 * applies before and during parse: `sourceContentSkipReason` (the secrets and
 * compiled-bundle gates), then `TreeSitterChunker#chunkWithTree`. No Qdrant,
 * no embeddings, no index writes.
 *
 * Reasons:
 *   - `emptyFile`  — the file has no non-blank text (nothing grep could find);
 *   - `secretsGate` / `compiled` — the pre-parse content gate rejected the file
 *     (the names the ingest skip record, `<collection>.skipped.json`, persists);
 *   - `zeroChunks` — non-blank text, no gate, and still no chunk (the defect);
 *   - `parseError` — `chunkWithTree` threw (the run would quarantine it);
 *   - `missing`    — the listed path does not exist under the root.
 *
 * Usage (run `npm run build` first):
 *   npx tsx scripts/spikes/zero-chunk-probe.ts --root <repo> --files <list.json> [--sample 10]
 * `<list.json>` is a JSON array of root-relative paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type * as LanguageConfigModule from "../../src/core/domains/ingest/pipeline/chunker/language-config/index.js";
// Types only: the values are loaded from the compiled `build/` at run time.
import type * as TreeSitterModule from "../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import type * as FileChunkPointsModule from "../../src/core/domains/ingest/pipeline/file-chunk-points.js";
import type * as LanguageModule from "../../src/core/domains/language/index.js";

// `--build <dir>` points at another checkout's `build/` (a before/after comparison).
const BUILD = join(argValue("--build") ?? join(import.meta.dirname, "..", "..", "build"), "core");

type ZeroChunkReason = "emptyFile" | "secretsGate" | "compiled" | "zeroChunks" | "parseError" | "missing";

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function load<T>(relative: string): Promise<T> {
  return (await import(pathToFileURL(join(BUILD, relative)).href)) as T;
}

async function main(): Promise<void> {
  const root = argValue("--root");
  const list = argValue("--files");
  const sample = Number(argValue("--sample") ?? "10");
  if (!root || !list) {
    console.error("usage: zero-chunk-probe.ts --root <repo> --files <list.json> [--sample N]");
    process.exit(2);
  }

  const { TreeSitterChunker } = await load<typeof TreeSitterModule>("domains/ingest/pipeline/chunker/tree-sitter.js");
  const { DefaultSymbolIdComposer, LanguageFactory } = await load<typeof LanguageModule>("domains/language/index.js");
  const { sourceContentSkipReason } = await load<typeof FileChunkPointsModule>(
    "domains/ingest/pipeline/file-chunk-points.js",
  );
  const { detectLanguage } = await load<typeof LanguageConfigModule>(
    "domains/ingest/pipeline/chunker/language-config/index.js",
  );

  // The production defaults (INGEST_CHUNK_SIZE 2500; the pipeline sets maxChunkSize = chunkSize).
  const chunker = new TreeSitterChunker(
    { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );

  const paths = JSON.parse(readFileSync(list, "utf8")) as string[];
  const byReason = new Map<ZeroChunkReason, string[]>();
  let chunked = 0;
  for (const relativePath of paths) {
    const filePath = join(root, relativePath);
    let reason: ZeroChunkReason | undefined;
    if (!existsSync(filePath)) reason = "missing";
    else {
      const code = readFileSync(filePath, "utf8");
      const language = detectLanguage(filePath);
      if (code.trim() === "") reason = "emptyFile";
      else {
        // Report the gate under the name the skip record persists (`secretsGate`).
        const gate = sourceContentSkipReason(filePath, relativePath, code, language);
        reason = gate === "secrets" ? "secretsGate" : gate;
        if (!reason) {
          try {
            const { chunks } = await chunker.chunkWithTree(code, filePath, language);
            if (chunks.length === 0) reason = "zeroChunks";
          } catch {
            reason = "parseError";
          }
        }
      }
    }
    if (!reason) {
      chunked++;
      continue;
    }
    const bucket = byReason.get(reason) ?? [];
    bucket.push(relativePath);
    byReason.set(reason, bucket);
  }

  const report = {
    files: paths.length,
    chunked,
    zeroChunk: Object.fromEntries(
      [...byReason].map(([reason, files]) => [reason, { count: files.length, sample: files.slice(0, sample) }]),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
}

await main();
