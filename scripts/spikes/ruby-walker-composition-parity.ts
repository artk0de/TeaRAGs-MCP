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
 * `--before-root <abs checkout>` turns the same run into a CROSS-CHECKOUT gate, which
 * is what a relocation seam actually needs: the native side becomes
 * `extractFromRubyFile` dynamically imported from
 * `<before-root>/src/core/domains/language/ruby/walker/walker.ts` — another checkout of
 * this repo, pinned at the pre-relocation commit — while the composed side stays the
 * current tree. Both sides parse the SAME file text and the SAME materialized tree, so
 * `mismatches 0` means the relocated code returns byte-identical JSON to the code it
 * replaced, which the same-tree mode cannot show (there both sides run the new store).
 * The flag is optional; without it the run is the original same-tree identity check.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon [--limit 500] \
 *     [--before-root /abs/path/to/pre-relocation/checkout]
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

/**
 * The native half of the comparison: this tree's own `extractFromRubyFile`, or — with
 * `--before-root` — the one exported by another checkout's `ruby/walker/walker.ts`.
 * The import is dynamic because the path is only known at runtime; tsx compiles the
 * other checkout's `.ts` the same way it compiles this script.
 */
async function nativeExtractor(beforeRoot: string | undefined): Promise<typeof extractFromRubyFile> {
  if (beforeRoot === undefined) return extractFromRubyFile;
  const modulePath = resolvePath(beforeRoot, "src/core/domains/language/ruby/walker/walker.ts");
  const loaded = (await import(modulePath)) as { extractFromRubyFile?: typeof extractFromRubyFile };
  if (typeof loaded.extractFromRubyFile !== "function") {
    throw new Error(`--before-root checkout exports no extractFromRubyFile: ${modulePath}`);
  }
  return loaded.extractFromRubyFile;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = resolvePath(read("--corpus") ?? process.cwd());
  const limit = Number(read("--limit") ?? 500);
  const beforeRoot = read("--before-root");
  const extractNative = await nativeExtractor(beforeRoot);
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
    if (JSON.stringify(extractNative(input)) !== JSON.stringify(walker.walk(input))) mismatches.push(relPath);
  }
  console.log(`ruby walker parity · corpus ${root}${beforeRoot === undefined ? "" : ` · native from ${beforeRoot}`}`);
  console.log(`  compared ${compared} files · mismatches ${mismatches.length}`);
  for (const relPath of mismatches.slice(0, 5)) console.log(`  MISMATCH ${relPath}`);
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
