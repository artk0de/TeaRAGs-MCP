/**
 * Ruby native-vs-composed walker parity (E1 seam 0, bd tea-rags-mcp-fmcly).
 *
 * `scripts/codegraph-chain-tally.ts` has chain specs for python and java only, so
 * there is no tally gate for Ruby. This is the Ruby half of the seam's
 * byte-identical gate: for every Ruby file in a corpus it runs the NATIVE monolith
 * (`extractFromRubyFile`) and the walker the provider actually hands out
 * (`LanguageFactory.create("ruby").walker.walk`, composed through
 * `composeExtractionWalker`) over the SAME materialized tree, then compares
 * `JSON.stringify` of both — the exact form the codegraph NDJSON spill sees, so a
 * channel materialised as `{}` where the native emitted nothing surfaces as a
 * mismatch instead of passing a deep compare.
 *
 * Expected while `RUBY_EXTRACTION_PASSES` is empty: `mismatches 0`. Once passes
 * exist the two sides legitimately differ and this becomes a diff tool, not a gate.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon [--limit 500]
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve as resolvePath, sep } from "node:path";

import Parser from "tree-sitter";

import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { extractFromRubyFile } from "../../src/core/domains/language/ruby/index.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { materializeTree } from "../../src/core/infra/materialize.js";

const SKIP_DIRECTORIES = new Set(["node_modules", "vendor", "build", "dist", "tmp", "log", "coverage"]);

function rubyFiles(root: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) walk(child);
      } else if (extname(entry.name) === ".rb") {
        found.push(relative(root, child).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

function main(): void {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = resolvePath(read("--corpus") ?? process.cwd());
  const limit = Number(read("--limit") ?? 500);
  const config = CODEGRAPH_LANGUAGES[".rb"];
  const { walker } = new LanguageFactory().create(config.language);
  if (!walker) throw new Error("ruby provider exposes no walker");
  const composer = new DefaultSymbolIdComposer();
  const mismatches: string[] = [];
  let compared = 0;
  for (const relPath of rubyFiles(root, limit)) {
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(config.loadParser());
    const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      config.scopeSeparator,
      config.disambiguateOverloads ?? false,
      composer,
    );
    const input = { tree, code, relPath, language: config.language, chunks };
    compared++;
    if (JSON.stringify(extractFromRubyFile(input)) !== JSON.stringify(walker.walk(input))) mismatches.push(relPath);
  }
  console.log(`ruby walker parity · corpus ${root}`);
  console.log(`  compared ${compared} files · mismatches ${mismatches.length}`);
  for (const relPath of mismatches.slice(0, 5)) console.log(`  MISMATCH ${relPath}`);
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main();
