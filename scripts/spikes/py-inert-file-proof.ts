/**
 * The gate for the inert-file fast path (bd tea-rags-mcp-1v12o.2.4, E6.1 FIX B).
 *
 * `fileIsInertForExtraction` lets a consumer skip materializing a file whose
 * native tree bears none of the node types its language's walker can turn into
 * output. That is a claim about the walker, and the only honest way to check it
 * is to RUN the walker on every file the predicate wants to skip and confirm the
 * extraction really is empty.
 *
 * For each corpus this walks the harness kept set — `collectSourceFiles` +
 * `buildCorpusExclusionFilter`, exactly the tally's selection — and for every
 * file the predicate calls inert, materializes the tree, runs `collectSymbols`
 * and the real walker, and compares the result against the empty shape
 * (`relPath`, `language`, `imports: []`, `chunks: []`, `fileScope: []`, no
 * optional channel present). A single mismatch means the language's node-type
 * list is wrong — widen the LIST, never the assertion.
 *
 *   npx tsx scripts/spikes/py-inert-file-proof.ts
 *   npx tsx scripts/spikes/py-inert-file-proof.ts --corpora netbox,polar
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import Parser from "tree-sitter";

import type { FileExtraction } from "../../src/core/contracts/types/codegraph.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { fileIsInertForExtraction } from "../../src/core/infra/extraction-fast-path.js";
import { materializeTree } from "../../src/core/infra/materialize.js";
import { buildCorpusExclusionFilter, collectSourceFiles } from "../ts-codegraph-typechecker-oracle.js";

const WALKED_EXTENSIONS: readonly string[] = Object.keys(CODEGRAPH_LANGUAGES);
const DEFAULT_CORPORA = ["flask", "httpx", "ugnest", "netbox", "polar"];

/** The keys an empty extraction carries, and nothing else. */
const EMPTY_KEYS = ["relPath", "language", "imports", "chunks", "fileScope"];

function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  return dot < 0 ? "" : relPath.slice(dot).toLowerCase();
}

/** Why this extraction is not the empty shape, or `null` when it is. */
function departsFromEmpty(extraction: FileExtraction): string | null {
  const extra = Object.keys(extraction).filter((k) => !EMPTY_KEYS.includes(k));
  if (extra.length > 0) return `extra channels: ${extra.join(", ")}`;
  if (extraction.imports.length > 0) return `${extraction.imports.length} imports`;
  if (extraction.chunks.length > 0) return `${extraction.chunks.length} chunks`;
  if (extraction.fileScope.length > 0) return `${extraction.fileScope.length} fileScope entries`;
  return null;
}

function corpusRoots(): Record<string, string> {
  const registry = JSON.parse(
    readFileSync(new URL("../lib/codegraph-corpora.json", import.meta.url), "utf8"),
  ) as Record<string, { path?: string }>;
  const out: Record<string, string> = {};
  for (const [alias, entry] of Object.entries(registry)) {
    if (typeof entry?.path === "string") out[alias] = entry.path.replace(/^~/, homedir());
  }
  return out;
}

async function proveCorpus(alias: string, root: string): Promise<number> {
  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: root });
  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    WALKED_EXTENSIONS,
  );

  let inert = 0;
  let mismatches = 0;
  for (const relPath of selection.kept) {
    const config = CODEGRAPH_LANGUAGES[extensionOf(relPath)];
    if (!config) continue;
    const { walker } = factory.create(config.language);
    if (!walker?.extractionBearingNodeTypes) continue;

    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(config.loadParser());
    const nativeRoot = parser.parse(code).rootNode;
    if (!fileIsInertForExtraction(nativeRoot, walker.extractionBearingNodeTypes)) continue;
    inert++;

    const tree = { rootNode: materializeTree(nativeRoot, code) };
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      config.scopeSeparator,
      config.disambiguateOverloads ?? false,
      composer,
    );
    const extraction = walker.walk({
      tree,
      code,
      relPath,
      language: config.language,
      chunks,
    });
    const departure = departsFromEmpty(extraction);
    if (departure !== null) {
      mismatches++;
      process.stderr.write(`  MISMATCH ${relPath}: ${departure}\n`);
    }
  }
  process.stdout.write(
    `${alias.padEnd(8)} files ${String(selection.kept.length).padStart(5)} · ` +
      `inert ${String(inert).padStart(4)} · mismatches ${mismatches}\n`,
  );
  return mismatches;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--corpora");
  const aliases = flag >= 0 ? (argv[flag + 1] ?? "").split(",") : DEFAULT_CORPORA;
  const roots = corpusRoots();
  let total = 0;
  for (const alias of aliases) {
    const root = roots[alias];
    if (root === undefined) throw new Error(`unknown corpus '${alias}'`);
    total += await proveCorpus(alias, resolve(root));
  }
  process.stdout.write(`TOTAL MISMATCHES ${total}\n`);
  if (total > 0) process.exitCode = 1;
}

await main();
