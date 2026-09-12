/**
 * Byte-identity instrument for a walker change (bd tea-rags-mcp-1v12o.2.4, E6.1).
 *
 * Dumps one canonical JSON line per kept file of a corpus — the walker's whole
 * `FileExtraction`, every object key sorted so the comparison cannot be moved by
 * insertion order. The tally's edge and unresolved counts say two runs AGREE on
 * the graph; this says the extractions that fed the graph are the same bytes,
 * which is the stronger claim and the one a "pure performance" fix has to make.
 *
 * The kept set is exactly the tally's: `collectSourceFiles` over the corpus with
 * `buildCorpusExclusionFilter` and the full `CODEGRAPH_LANGUAGES` extension set,
 * so a file the harness measures is a file this dumps.
 *
 *   npx tsx scripts/spikes/py-extraction-dump.ts \
 *     --corpus /abs/path/to/corpus --out before-netbox.ndjson
 *
 * Run it on the BEFORE tree and the AFTER tree, then `diff` the two files.
 */
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  buildCorpusExclusionFilter,
  collectSourceFiles,
  extractFile,
  readCorpusDeclaredDependencies,
} from "../ts-codegraph-typechecker-oracle.js";

/** Every extension the engine walks — the tally's symbol-table set, verbatim. */
const WALKED_EXTENSIONS: readonly string[] = Object.keys(CODEGRAPH_LANGUAGES);

/** JSON with every object key in sorted order, at every depth. Arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

function readFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Dump one corpus. `outPath` undefined → stdout. */
async function dumpCorpus(root: string, outPath: string | undefined, label: string): Promise<void> {
  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: root });
  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    WALKED_EXTENSIONS,
  );

  const sink = outPath === undefined ? process.stdout : createWriteStream(outPath);
  let dumped = 0;
  let parseFailures = 0;
  const declaredDependencies = readCorpusDeclaredDependencies(root, factory);
  for (const relPath of selection.kept) {
    const extraction = extractFile(root, relPath, composer, factory, declaredDependencies);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    dumped++;
    if (!sink.write(`${JSON.stringify(canonical(extraction))}\n`)) await once(sink, "drain");
  }
  if (outPath !== undefined) {
    (sink as ReturnType<typeof createWriteStream>).end();
    await once(sink, "finish");
  }
  process.stderr.write(
    `${label}: kept ${selection.kept.length} · dumped ${dumped} · parse failures ${parseFailures}\n`,
  );
}

/** Corpus roots by alias, read off the registry the harness already keeps. */
function corpusRoots(): Record<string, string> {
  const registry = JSON.parse(
    readFileSync(new URL("../lib/codegraph-corpora.json", import.meta.url), "utf8"),
  ) as Record<string, { path?: string; language?: string }>;
  const out: Record<string, string> = {};
  for (const [alias, entry] of Object.entries(registry)) {
    if (typeof entry?.path === "string") out[alias] = entry.path.replace(/^~/, homedir());
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDir = readFlag(argv, "--out-dir");
  const aliases = readFlag(argv, "--corpora");

  // `--corpora a,b,c --out-dir DIR` dumps several registry corpora in one
  // process; `--corpus PATH [--out FILE]` dumps one arbitrary root.
  if (aliases !== undefined) {
    if (outDir === undefined) throw new Error("--corpora needs --out-dir");
    mkdirSync(outDir, { recursive: true });
    const roots = corpusRoots();
    for (const alias of aliases.split(",")) {
      const root = roots[alias];
      if (root === undefined) throw new Error(`unknown corpus '${alias}'`);
      await dumpCorpus(resolve(root), join(outDir, `${alias}.ndjson`), alias);
    }
    return;
  }
  const root = resolve(readFlag(argv, "--corpus") ?? process.cwd());
  await dumpCorpus(root, readFlag(argv, "--out"), root);
}

await main();
