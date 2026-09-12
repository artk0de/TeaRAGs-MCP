/**
 * Byte-identity instrument for a walker change, in ANY language (bd
 * tea-rags-mcp-zhetx, E1 seam 0) — the language-agnostic sibling of
 * `py-extraction-dump.ts`, which stays pinned to the Python E6 measurement it
 * was written for.
 *
 * Dumps one canonical JSON line per kept file of a corpus: the whole
 * `FileExtraction` the production read path produces, every object key sorted so
 * the comparison cannot be moved by insertion order. Run it on the BEFORE tree
 * and the AFTER tree, then `diff` the two files — a relocation that claims to
 * preserve output has to survive that, and no edge tally is as strict.
 *
 * The walk goes through `LanguageFactory` → `walker.walk`, which is exactly the
 * seam under test: what a provider's `index.ts` composes is what gets dumped.
 *
 *   npx tsx scripts/spikes/extraction-dump.ts --corpus /abs/path [--out FILE]
 *   npx tsx scripts/spikes/extraction-dump.ts --corpus /abs/path --lang bash
 *
 * `--lang` narrows the kept set to the extensions that map to one language;
 * without it every extension the codegraph walks is dumped.
 */
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { buildCorpusExclusionFilter, collectSourceFiles, extractFile } from "../ts-codegraph-typechecker-oracle.js";

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

/** The extensions to keep: one language's, or every language the codegraph walks. */
function walkedExtensions(language: string | undefined): readonly string[] {
  const all = Object.entries(CODEGRAPH_LANGUAGES);
  if (language === undefined) return all.map(([ext]) => ext);
  const kept = all.filter(([, config]) => config.language === language).map(([ext]) => ext);
  if (kept.length === 0) throw new Error(`no codegraph extension maps to language '${language}'`);
  return kept;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = resolve(readFlag(argv, "--corpus") ?? process.cwd());
  const outPath = readFlag(argv, "--out");
  const extensions = walkedExtensions(readFlag(argv, "--lang"));

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: root });
  const selection = await collectSourceFiles(root, root, await buildCorpusExclusionFilter(root, factory), extensions);

  const sink = outPath === undefined ? process.stdout : createWriteStream(outPath);
  let dumped = 0;
  let parseFailures = 0;
  for (const relPath of selection.kept) {
    const extraction = extractFile(root, relPath, composer, factory);
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
  process.stderr.write(`${root}: kept ${selection.kept.length} · dumped ${dumped} · parse failures ${parseFailures}\n`);
}

await main();
