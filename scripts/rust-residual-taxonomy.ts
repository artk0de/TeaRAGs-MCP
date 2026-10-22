/**
 * Rust residual taxonomy (bd tea-rags-mcp-s3i8m.1) — sizes every Rust call site
 * production leaves unresolved while an in-project definition of its member
 * exists, by mechanism (axis A) and by std/core/alloc member-name overlap
 * (axis B). Classification lives in `scripts/lib/rust-residual-taxonomy.ts`.
 *
 * Usage:
 *   npx tsx scripts/codegraph-chain-tally.ts --corpus <root> --lang rust --time-only \
 *     --kind-stats --residual-rows /tmp/rg.residual.ndjson --quiet
 *   npx tsx scripts/rust-residual-taxonomy.ts --rows /tmp/rg.residual.ndjson \
 *     --corpus-root <root> --corpus ripgrep --json /tmp/rg.taxonomy.json [--samples 15]
 *
 * `--corpus-root` must be the root the tally ran on: rows carry paths relative
 * to it, and a wrong root reads as every site `unknown: fileUnreadable`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";

import type { ResidualCallSiteRow } from "./codegraph-chain-tally.js";
import {
  buildRustResidualTaxonomyReport,
  classifyRustResidualSite,
  createRustResidualParser,
  formatRustResidualTaxonomyTable,
  type RustResidualClassifiedSite,
} from "./lib/rust-residual-taxonomy.js";

export function parseArgs(argv: readonly string[]) {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rows = read("--rows");
  const corpusRoot = read("--corpus-root");
  if (rows === undefined || corpusRoot === undefined) {
    throw new Error("usage: --rows <ndjson> --corpus-root <abs> [--corpus <alias>] [--json <out>] [--samples N]");
  }
  return {
    rows: resolvePath(rows),
    corpusRoot: resolvePath(corpusRoot),
    corpus: read("--corpus") ?? corpusRoot,
    json: read("--json") ?? null,
    samples: Number(read("--samples") ?? 15),
  };
}

function readResidualRows(path: string): ResidualCallSiteRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ResidualCallSiteRow);
}

/** A row whose file is gone or unreadable is classified `unknown`, never dropped. */
function readSourceOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const parser = await createRustResidualParser();
  const byFile = new Map<string, ResidualCallSiteRow[]>();
  for (const row of readResidualRows(opts.rows)) {
    const bucket = byFile.get(row.relPath) ?? [];
    bucket.push(row);
    byFile.set(row.relPath, bucket);
  }

  const classified: RustResidualClassifiedSite[] = [];
  for (const [relPath, rows] of byFile) {
    const source = readSourceOrNull(resolvePath(opts.corpusRoot, relPath));
    if (source === null) {
      for (const site of rows) classified.push({ site, category: "unknown", reason: "fileUnreadable", sourceLine: "" });
      continue;
    }
    const lines = source.split("\n");
    // One parse per file, every site of the file classified against it.
    const root = parser.parse(source).rootNode;
    for (const site of rows) {
      const sourceLine = (lines[site.startLine - 1] ?? "").trim().slice(0, 200);
      classified.push({ site, ...classifyRustResidualSite(root, site), sourceLine });
    }
  }

  const report = buildRustResidualTaxonomyReport(opts.corpus, classified, opts.samples);
  process.stdout.write(`${formatRustResidualTaxonomyTable(report)}\n`);
  if (opts.json !== null) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
