/**
 * Ruby walker before/after parity (E1 seam 0, bd tea-rags-mcp-fmcly; rebuilt by
 * bd tea-rags-mcp-0qaht.58).
 *
 * The identity gate for a change that must not move Ruby extraction output. For
 * every Ruby file in a corpus it runs the walker the provider hands out
 * (`LanguageFactory.create("ruby").walker.walk`, composed through
 * `composeExtractionWalker`) from TWO source trees over the SAME materialized tree
 * and the SAME symbol chunks, then compares `JSON.stringify` of both — the exact
 * form the codegraph NDJSON spill sees, so a channel materialised as `{}` where the
 * other side emitted nothing surfaces as a mismatch instead of passing a deep compare.
 *
 * The AFTER side is this tree. The BEFORE side is either
 *   - `--before-ref <git ref>` (default `main`): the ref's `src/` extracted with
 *     `git archive` under `node_modules/.cache/ruby-walker-parity/<sha>/`, so its
 *     bare package imports resolve to this checkout's `node_modules`; or
 *   - `--before-root <abs checkout>`: another checkout's `src/` loaded in place.
 * tsx transpiles the before tree's `.ts` without type-checking it.
 *
 * Why not the original native-vs-composed comparison: it compared the native
 * monolith (`extractFromRubyFile`) with the composed walker, which was an
 * identity only while `RUBY_EXTRACTION_PASSES` was empty. Once passes existed the
 * two sides legitimately differed (147/147 sinatra mismatches), so the gate now
 * compares like with like — composed walker against composed walker.
 *
 * `--self-check` proves the comparison is not blind: the BEFORE side is fed the
 * file with no symbol chunks, which moves every enclosing-symbol id it emits, and
 * the run passes only when that forced change produces mismatches.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon [--limit 500] \
 *     [--before-ref main | --before-root /abs/path/to/checkout] [--self-check]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "tree-sitter";

import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { loadCodegraphGrammarSync } from "../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { materializeTree } from "../../src/core/infra/materialize.js";
import { resolveCheckoutCommit } from "../lib/checkout-commit.js";

const SKIP_DIRECTORIES = new Set(["node_modules", "vendor", "build", "dist", "tmp", "log", "coverage"]);
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const LANGUAGE_INDEX = "src/core/domains/language/index.ts";

type RubyWalker = NonNullable<ReturnType<LanguageFactory["create"]>["walker"]>;

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

/** The before tree for a git ref: its `src/` extracted once per commit, reused after. */
function extractRef(ref: string): { root: string; commit: string } {
  const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const root = join(REPO_ROOT, "node_modules", ".cache", "ruby-walker-parity", commit);
  if (!existsSync(join(root, LANGUAGE_INDEX))) {
    mkdirSync(root, { recursive: true });
    const archive = execFileSync("git", ["-C", REPO_ROOT, "archive", commit, "src"], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
  }
  return { root, commit };
}

/** The before side's composed Ruby walker, loaded from `<root>/src` as its own module graph. */
async function beforeWalker(root: string): Promise<RubyWalker> {
  const modulePath = resolvePath(root, LANGUAGE_INDEX);
  if (realpathSync(modulePath) === realpathSync(resolvePath(REPO_ROOT, LANGUAGE_INDEX))) {
    throw new Error(`before tree is this tree (${root}) — the comparison would be an identity by construction`);
  }
  const loaded = (await import(modulePath)) as { LanguageFactory?: typeof LanguageFactory };
  if (typeof loaded.LanguageFactory !== "function") {
    throw new Error(`before tree exports no LanguageFactory: ${modulePath}`);
  }
  const { walker } = new loaded.LanguageFactory().create("ruby");
  if (!walker) throw new Error(`before tree's ruby provider exposes no walker: ${modulePath}`);
  return walker;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = resolvePath(read("--corpus") ?? process.cwd());
  const limit = Number(read("--limit") ?? 500);
  const selfCheck = argv.includes("--self-check");
  const beforeRootFlag = read("--before-root");
  const before =
    beforeRootFlag === undefined
      ? extractRef(read("--before-ref") ?? "main")
      : { root: resolvePath(beforeRootFlag), commit: resolveCheckoutCommit(beforeRootFlag) ?? "unknown revision" };
  const walkBefore = await beforeWalker(before.root);

  const config = CODEGRAPH_LANGUAGES[".rb"];
  const factory = new LanguageFactory();
  const { walker } = factory.create(config.language);
  if (!walker) throw new Error("ruby provider exposes no walker");
  const composer = new DefaultSymbolIdComposer();
  const mismatches: string[] = [];
  let compared = 0;
  for (const relPath of rubyFiles(root, limit)) {
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(loadCodegraphGrammarSync(factory, ".rb"));
    const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      config.scopeSeparator,
      config.disambiguateOverloads ?? false,
      composer,
    );
    const input = { tree, code, relPath, language: config.language, chunks };
    const beforeInput = selfCheck ? { ...input, chunks: [] } : input;
    compared++;
    if (JSON.stringify(walkBefore.walk(beforeInput)) !== JSON.stringify(walker.walk(input))) mismatches.push(relPath);
  }
  console.log(`ruby walker parity · corpus ${root} · before ${before.root}@${before.commit}`);
  console.log(`  compared ${compared} files · mismatches ${mismatches.length}${selfCheck ? " (self-check)" : ""}`);
  for (const relPath of mismatches.slice(0, 5)) console.log(`  MISMATCH ${relPath}`);
  if (selfCheck) {
    console.log(mismatches.length > 0 ? "  self-check PASS: a forced change is visible" : "  self-check FAIL: blind");
    process.exit(mismatches.length > 0 ? 0 : 1);
  }
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
