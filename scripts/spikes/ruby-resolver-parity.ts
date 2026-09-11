/**
 * Ruby resolver cross-checkout parity (E1 seam 3, bd tea-rags-mcp-9pn22).
 *
 * `codegraph-chain-tally.ts` has chain specs for python and java only, so a
 * Ruby relocation has no tally gate. This is the resolver half of the seam's
 * byte-identical gate, and it is stronger than a tally triple: it compares
 * PER CALL SITE, so a relocation that moved forty sites from one target to
 * another fails here and scores identically there.
 *
 * ONE corpus walk, ONE symbol table, ONE `CallContext` per chunk, two
 * resolvers: this tree's `RubyCallResolver`, and the one dynamically imported
 * from `--before-root` — another checkout of this repo pinned at the
 * pre-relocation commit. Both answer the same `CallRef`, so a difference is
 * the relocation and nothing else. No baseline file, no earlier run, no
 * question about which commit the BEFORE numbers came from.
 *
 * `drift` is the same guard the tally's `chainDrift` is: this tree's direct
 * `new RubyCallResolver()` must answer identically to
 * `LanguageFactory.create("ruby").resolver`. Non-zero means the harness is no
 * longer exercising production and every number it prints is void.
 *
 * Without `--before-root` both sides are this tree, so the run is an identity
 * check — it proves the walk and the context are sound, not that a relocation
 * held.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-resolver-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon \
 *     --before-root /abs/path/to/pre-relocation/checkout [--limit 20000] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve as resolvePath, sep } from "node:path";

import type {
  CallContext,
  ChunkExtraction,
  FileExtraction,
  SymbolResolutionTarget,
} from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { RubyCallResolver } from "../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { sameTarget } from "../codegraph-chain-tally.js";
import { resolveCheckoutCommit } from "../lib/checkout-commit.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
} from "../ts-codegraph-typechecker-oracle.js";

/** Call sites are scored for Ruby only; the symbol table holds every walkable language. */
const RUBY_EXTENSIONS: readonly string[] = [".rb"];
const SYMBOL_TABLE_EXTENSIONS: readonly string[] = Object.keys(CODEGRAPH_LANGUAGES);

/** One call site, as each side's resolver answered it. */
export interface ResolverParityRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  /** `--before-root`'s resolver, or this tree's again when the flag is absent. */
  before: SymbolResolutionTarget | null;
  after: SymbolResolutionTarget | null;
}

export interface ResolverParityResult {
  /** Only the DISAGREEING rows — a mastodon walk resolves six figures of sites. */
  mismatches: ResolverParityRow[];
  compared: number;
  /** Direct `new RubyCallResolver()` vs the factory's. MUST be 0. */
  drift: number;
  /** BEFORE resolved to the class THIS tree runs — an identity check, not a cross-checkout gate. */
  beforeSameModule: boolean;
  files: number;
  symbolTableOnlyFiles: number;
  ingestIgnored: number;
  codegraphExcluded: number;
  parseFailures: number;
  symbols: number;
  dispatchSkipped: number;
}

/**
 * The verdict, with the tally's own `sameTarget` semantics rather than a
 * restatement of them: both null, or the same file AND the same symbol.
 */
export function mismatchingRows(rows: readonly ResolverParityRow[]): ResolverParityRow[] {
  return rows.filter((row) => !sameTarget(row.before, row.after));
}

/** `--before-root` as printed: the path, plus the revision it was sitting at. */
function beforeLabel(beforeRoot: string | undefined, beforeCommit: string | null): string {
  if (beforeRoot === undefined) return "";
  return ` · before from ${beforeRoot}@${beforeCommit ?? "unknown revision"}`;
}

export function formatParitySummary(
  root: string,
  beforeRoot: string | undefined,
  result: ResolverParityResult,
  // Defaulted, not required: the three summary tests that predate it keep their
  // three-argument calls, which the business-logic-tests rule asks for.
  beforeCommit: string | null = null,
): string[] {
  return [
    `ruby resolver parity · corpus ${root}${beforeLabel(beforeRoot, beforeCommit)}` +
      `${result.beforeSameModule ? "  ← SAME MODULE both sides, identity check only" : ""}`,
    `  ${result.files} scored files (+${result.symbolTableOnlyFiles} symbol-table only), ${result.symbols} symbols` +
      ` (parse failures ${result.parseFailures}, dispatch skipped ${result.dispatchSkipped})`,
    `  excluded as production excludes them: ${result.ingestIgnored} by .gitignore and friends · ` +
      `${result.codegraphExcluded} generated/test/non-app`,
    `  compared ${result.compared} sites · mismatches ${result.mismatches.length} · drift ${result.drift}` +
      `${result.drift === 0 ? "" : "  ← HARNESS IS NOT EXERCISING PRODUCTION, numbers void"}`,
  ];
}

/**
 * The BEFORE side: another checkout's `RubyCallResolver`, or this tree's own
 * when `--before-root` is absent. tsx transpiles the other checkout's `.ts`
 * without type-checking it, so the structural difference between the two trees'
 * `CallContext` declarations is a non-issue at runtime — the same property the
 * walker precedent (`ruby-walker-composition-parity.ts`) relies on.
 */
async function beforeResolver(
  beforeRoot: string | undefined,
): Promise<{ resolver: RubyCallResolver; sameModule: boolean }> {
  if (beforeRoot === undefined) return { resolver: new RubyCallResolver(), sameModule: true };
  const modulePath = resolvePath(beforeRoot, "src/core/domains/language/ruby/resolver/ruby-resolver.ts");
  const loaded = (await import(modulePath)) as { RubyCallResolver?: new () => RubyCallResolver };
  if (typeof loaded.RubyCallResolver !== "function") {
    throw new Error(`--before-root checkout exports no RubyCallResolver: ${modulePath}`);
  }
  // A `--before-root` pointing back at THIS tree loads the very class the AFTER
  // side runs, and then `mismatches 0` is arithmetic rather than evidence. Not
  // an error — the identity check is a legitimate mode — but the summary has to
  // say so, or a mis-typed path reads as a passing gate.
  return { resolver: new loaded.RubyCallResolver(), sameModule: loaded.RubyCallResolver === RubyCallResolver };
}

/** The run-global channels pass 1 merges, mirroring `CodegraphRunState`'s. */
interface RunGlobalChannels {
  classExtends: Record<string, string>;
  classFieldTypes: NonNullable<CallContext["classFieldTypes"]>;
  classAncestors: NonNullable<CallContext["classAncestors"]>;
  classPrependedAncestors: NonNullable<CallContext["classPrependedAncestors"]>;
  functionReturnTypes: NonNullable<CallContext["functionReturnTypes"]>;
  ivarTypes: NonNullable<CallContext["ivarTypes"]>;
  structuredReturnTypes: NonNullable<CallContext["structuredReturnTypes"]>;
  compactDeclaredClasses: Set<string>;
}

function emptyChannels(): RunGlobalChannels {
  return {
    classExtends: {},
    classFieldTypes: {},
    classAncestors: {},
    classPrependedAncestors: {},
    functionReturnTypes: {},
    ivarTypes: {},
    structuredReturnTypes: {},
    compactDeclaredClasses: new Set<string>(),
  };
}

function mergeChannels(channels: RunGlobalChannels, extraction: FileExtraction): void {
  Object.assign(channels.classExtends, extraction.classExtends ?? {});
  Object.assign(channels.classFieldTypes, extraction.classFieldTypes ?? {});
  Object.assign(channels.classAncestors, extraction.classAncestors ?? {});
  Object.assign(channels.classPrependedAncestors, extraction.classPrependedAncestors ?? {});
  Object.assign(channels.functionReturnTypes, extraction.functionReturnTypes ?? {});
  Object.assign(channels.ivarTypes, extraction.ivarTypes ?? {});
  Object.assign(channels.structuredReturnTypes, extraction.structuredReturnTypes ?? {});
  for (const fq of extraction.compactDeclaredClasses ?? []) channels.compactDeclaredClasses.add(fq);
}

/**
 * One call site's context. Richer than the tally's because the Ruby fold reads
 * channels the tally never threads — `ivarTypes`, `structuredReturnTypes`,
 * `gemfileContent` — and a channel absent here is a branch the gate cannot
 * reach. Both sides receive this same object, so the extra channels widen
 * coverage without touching the comparison.
 */
function buildCallContext(
  extraction: FileExtraction,
  chunk: ChunkExtraction,
  symbolTable: InMemoryGlobalSymbolTable,
  channels: RunGlobalChannels,
  corpus: { root: string; gemfileContent: string | undefined },
): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable,
    classFieldTypes: channels.classFieldTypes,
    associationTypes: extraction.associationTypes,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    functionReturnTypes: channels.functionReturnTypes,
    ivarTypes: channels.ivarTypes,
    structuredReturnTypes: channels.structuredReturnTypes,
    classAncestors: channels.classAncestors,
    classPrependedAncestors: channels.classPrependedAncestors,
    compactDeclaredClasses: channels.compactDeclaredClasses,
    classExtends: channels.classExtends,
    gemfileContent: corpus.gemfileContent,
    projectRoot: corpus.root,
  };
}

/** The project's `Gemfile`, as the provider reads it once per run; absent ⇒ ungated catalogue. */
function readGemfile(root: string): string | undefined {
  try {
    return readFileSync(join(root, "Gemfile"), "utf8");
  } catch {
    return undefined;
  }
}

export async function run(
  root: string,
  beforeRoot: string | undefined,
  limit: number,
  quiet: boolean,
): Promise<ResolverParityResult> {
  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const production = factory.create("ruby").resolver;
  if (!production) throw new Error("ruby provider exposes no resolver");
  const after = new RubyCallResolver();
  const { resolver: before, sameModule: beforeSameModule } = await beforeResolver(beforeRoot);

  const symbolTable = new InMemoryGlobalSymbolTable();
  const channels = emptyChannels();
  const scored: FileExtraction[] = [];
  let parseFailures = 0;
  let symbolTableOnlyFiles = 0;

  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    SYMBOL_TABLE_EXTENSIONS,
  );
  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(root, relPath, composer, factory);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    mergeChannels(channels, extraction);
    if (RUBY_EXTENSIONS.includes(extname(relPath).toLowerCase())) scored.push(extraction);
    else symbolTableOnlyFiles++;
  }
  if (!quiet) {
    process.stderr.write(
      `pass 1: ${scored.length} ruby files (+${symbolTableOnlyFiles} symbol-table only), ${symbolTable.size()} symbols\n`,
    );
  }

  const corpus = { root, gemfileContent: readGemfile(root) };
  const mismatches: ResolverParityRow[] = [];
  let compared = 0;
  let dispatchSkipped = 0;
  let drift = 0;

  for (const extraction of scored) {
    // Batched per file: a mastodon walk resolves six figures of call sites, so
    // the full row set never exists at once — only the disagreements survive.
    const rows: ResolverParityRow[] = [];
    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(extraction, chunk, symbolTable, channels, corpus);
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) {
          dispatchSkipped++;
          continue;
        }
        const afterTarget = after.resolve(call, ctx);
        if (!sameTarget(afterTarget, production.resolve(call, ctx))) drift++;
        rows.push({
          relPath: extraction.relPath,
          startLine: call.startLine,
          callText: call.callText,
          receiver: call.receiver,
          member: call.member,
          before: before.resolve(call, ctx),
          after: afterTarget,
        });
      }
    }
    compared += rows.length;
    mismatches.push(...mismatchingRows(rows));
  }

  return {
    mismatches,
    compared,
    drift,
    beforeSameModule,
    files: scored.length,
    symbolTableOnlyFiles,
    ingestIgnored: selection.ingestIgnored,
    codegraphExcluded: selection.codegraphExcluded,
    parseFailures,
    symbols: symbolTable.size(),
    dispatchSkipped,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]) {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    corpus: resolvePath(read("--corpus") ?? process.cwd()),
    beforeRoot: read("--before-root"),
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Read before the walk: a long run gives the other checkout time to move, and
  // the revision the BEFORE resolver was loaded from is the one worth recording.
  const beforeCommit = resolveCheckoutCommit(opts.beforeRoot);
  const started = Date.now();
  const result = await run(opts.corpus, opts.beforeRoot, opts.limit, opts.quiet);
  const out = formatParitySummary(opts.corpus, opts.beforeRoot, result, beforeCommit);
  out.push(`  wall ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const row of result.mismatches.slice(0, 20)) out.push(`    MISMATCH ${JSON.stringify(row)}`);
  process.stdout.write(`${out.join("\n")}\n`);
  if (opts.json) {
    writeFileSync(opts.json, `${JSON.stringify({ opts: { ...opts, beforeCommit }, result }, null, 2)}\n`);
  }
  if (result.mismatches.length > 0 || result.drift > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
