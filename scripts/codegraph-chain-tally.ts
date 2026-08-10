/**
 * codegraph-chain-tally.ts (bd tea-rags-mcp-86qfb)
 *
 * What the resolution chain EMITTED over a real corpus, for a language that has
 * no type-checker oracle. `scripts/ts-codegraph-typechecker-oracle.ts` grew a
 * `CHAIN OUTPUT` block for exactly this reason (bd 5onmn): verdict tables only
 * cover call sites the oracle has an opinion about, and a change that trades
 * edges for precision inside the blind spots is invisible in them. Python and
 * Java have no oracle at all, so the tally IS the measurement.
 *
 * Two modes:
 *
 *   - default — walk the corpus, run the production chain, report
 *     `edges` / `fileOnly` / `unresolved`.
 *   - `--defer <passName>` — ALSO run a second chain, identical except that the
 *     named pass's file-only commit (`resolved({ targetSymbolId: null })`) is
 *     converted to a `deferred` park, and diff the two per call site.
 *
 * The A/B runs in ONE process over ONE symbol table, so the two sides differ by
 * exactly the swapped slot — no baseline drift, no "revert src/ and re-run"
 * ritual. The deferred chain is REBUILT from the same exported strategy classes
 * the production resolver composes (the precedent is the DROP-surface oracle in
 * `taxdome-codegraph-recall-forensics.ts`), and every call site cross-checks the
 * rebuilt baseline against the real `LanguageProvider.resolver` — a non-zero
 * `chainDrift` means the rebuild no longer mirrors production and the numbers
 * are void.
 *
 * The diff buckets are the decision. A park can only be beaten by a LATER pass
 * returning `resolved`, so each changed call site lands in one of:
 *
 *   - `upgradedSameFile`  — park replaced by a symbol IN the parked file. The
 *     shape deferral is FOR.
 *   - `relocatedOtherFile` — park replaced by a symbol in a DIFFERENT file. The
 *     edge's file attribution moved, which is what `fanIn` / `fanOut` /
 *     PageRank read.
 *   - `lost` / `gained` — an edge disappeared or appeared. Invariant 3 says
 *     `lost` must be 0.
 *
 * Usage:
 *   npx tsx scripts/codegraph-chain-tally.ts --corpus <abs path> --lang python \
 *     [--defer importMatch] [--limit N] [--samples 10] [--json out.json]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve as resolvePath, sep } from "node:path";

import Parser from "tree-sitter";

import { deferred } from "../src/core/contracts/resolution.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ChunkExtraction,
  type FileExtraction,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../src/core/contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../src/core/contracts/types/language.js";
import { BUILTIN_IGNORE_PATTERNS } from "../src/core/domains/ingest/pipeline/ignore-defaults.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import {
  JavaEnclosingBareCallSymbolResolutionStrategy,
  JavaFieldTypeSymbolResolutionStrategy,
  JavaGlobalShortNameSymbolResolutionStrategy,
  JavaImportReceiverSymbolResolutionStrategy,
  JavaLocalBindingSymbolResolutionStrategy,
  JavaThisMemberSymbolResolutionStrategy,
} from "../src/core/domains/language/java/resolver/strategies/index.js";
import {
  CONE_MAX_DEFAULT,
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
} from "../src/core/domains/language/python/resolver/strategies/index.js";
import { resolveViaChain } from "../src/core/domains/language/resolver-chain.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { lastSegment } from "../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../src/core/infra/materialize.js";

// ---------------------------------------------------------------------------
// Per-language chain rebuild — the production order, verbatim.
// ---------------------------------------------------------------------------

/** The chain a language's `CallResolver` composes, plus the extensions it owns. */
interface ChainSpec {
  extensions: readonly string[];
  build: () => SymbolResolutionStrategy[];
}

const MODE = DEFAULT_AMBIGUOUS_RESOLVE_MODE;

const CHAINS: Record<string, ChainSpec> = {
  // Mirrors `PythonCallResolver`'s array (python-resolver.ts).
  python: {
    extensions: [".py"],
    build: () => {
      const cfg = { mode: MODE, coneMax: CONE_MAX_DEFAULT };
      return [
        new PythonSuperSymbolResolutionStrategy(cfg),
        new PythonSelfFieldSymbolResolutionStrategy(cfg),
        new PythonSelfMemberSymbolResolutionStrategy(cfg),
        new PythonLocalBindingSymbolResolutionStrategy(cfg),
        new PythonImportMatchSymbolResolutionStrategy(cfg),
        new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
      ];
    },
  },
  // Mirrors `JavaCallResolver`'s array (java-resolver.ts).
  java: {
    extensions: [".java"],
    build: () => {
      const cfg = { mode: MODE };
      return [
        new JavaThisMemberSymbolResolutionStrategy(cfg),
        new JavaFieldTypeSymbolResolutionStrategy(cfg),
        new JavaLocalBindingSymbolResolutionStrategy(cfg),
        new JavaImportReceiverSymbolResolutionStrategy(cfg),
        new JavaEnclosingBareCallSymbolResolutionStrategy(cfg),
        new JavaGlobalShortNameSymbolResolutionStrategy(cfg),
      ];
    },
  },
};

/**
 * Wrap one pass so its FILE-ONLY commit becomes a park. Every other outcome —
 * a pinned `resolved`, a `drop`, a `continue` — passes through untouched, so the
 * A side and the B side differ by exactly the one branch under test.
 */
class DeferFileOnlyStrategy implements SymbolResolutionStrategy {
  readonly name: string;
  constructor(private readonly inner: SymbolResolutionStrategy) {
    this.name = inner.name;
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = this.inner.attempt(call, ctx);
    if (outcome.kind === "resolved" && outcome.target.targetSymbolId === null) return deferred(outcome.target);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Tally + diff — pure, so the shape of the answer is inspectable.
// ---------------------------------------------------------------------------

export interface ChainOutputTally {
  /** Call sites the chain resolved to anything. */
  edges: number;
  /** Of those, edges with `targetSymbolId === null` — a SUBSET of `edges`. */
  fileOnly: number;
  /** Call sites the chain declined. */
  unresolved: number;
}

export interface CallSiteRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  baseline: SymbolResolutionTarget | null;
  variant: SymbolResolutionTarget | null;
  /**
   * Whether the baseline's target names a file that actually exists in the
   * corpus. Both import mappers (`mapPythonImportToFile`, `mapJavaImportToFile`)
   * synthesise a path from the import text WITHOUT probing disk, so an external
   * import yields a phantom path (`java/util/Objects.java`, `re.py`). A file-only
   * edge on a phantom path is the resolver's de-facto "this call leaves the
   * project" marker, and replacing it with an in-project symbol FABRICATES an
   * edge rather than upgrading one. Nothing else in the diff distinguishes the
   * two cases, and they point opposite ways.
   */
  baselineTargetInProject: boolean;
}

export interface DiffTally {
  /** Baseline emitted a file-only edge; the variant pinned a symbol in the SAME file. */
  upgradedSameFile: number;
  /** Baseline emitted a file-only edge; the variant pinned a symbol in a DIFFERENT file. */
  relocatedOtherFile: number;
  /** Of `relocatedOtherFile`, those whose baseline file EXISTS in the corpus. */
  relocatedFromInProject: number;
  /** Of `relocatedOtherFile`, those whose baseline file was a phantom external path. */
  relocatedFromExternal: number;
  /** Baseline emitted an edge; the variant emitted none. Invariant 3 says this is 0. */
  lost: number;
  /** Baseline emitted no edge; the variant emitted one. */
  gained: number;
  /** Any other movement (pinned → pinned elsewhere, file-only → file-only elsewhere). */
  other: number;
}

export function tallyChainOutput(targets: readonly (SymbolResolutionTarget | null)[]): ChainOutputTally {
  const tally: ChainOutputTally = { edges: 0, fileOnly: 0, unresolved: 0 };
  for (const target of targets) {
    if (target === null) {
      tally.unresolved++;
      continue;
    }
    tally.edges++;
    if (target.targetSymbolId === null) tally.fileOnly++;
  }
  return tally;
}

/** Same target? Both null, or both naming the same file and the same symbol. */
export function sameTarget(a: SymbolResolutionTarget | null, b: SymbolResolutionTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.targetRelPath === b.targetRelPath && a.targetSymbolId === b.targetSymbolId;
}

export function diffRows(rows: readonly CallSiteRow[]): { tally: DiffTally; changed: CallSiteRow[] } {
  const tally: DiffTally = {
    upgradedSameFile: 0,
    relocatedOtherFile: 0,
    relocatedFromInProject: 0,
    relocatedFromExternal: 0,
    lost: 0,
    gained: 0,
    other: 0,
  };
  const changed: CallSiteRow[] = [];
  for (const row of rows) {
    if (sameTarget(row.baseline, row.variant)) continue;
    changed.push(row);
    const { baseline, variant } = row;
    if (baseline !== null && variant === null) tally.lost++;
    else if (baseline === null && variant !== null) tally.gained++;
    else if (
      baseline !== null &&
      variant !== null &&
      baseline.targetSymbolId === null &&
      variant.targetSymbolId !== null
    ) {
      if (baseline.targetRelPath === variant.targetRelPath) tally.upgradedSameFile++;
      else {
        tally.relocatedOtherFile++;
        if (row.baselineTargetInProject) tally.relocatedFromInProject++;
        else tally.relocatedFromExternal++;
      }
    } else tally.other++;
  }
  return { tally, changed };
}

// ---------------------------------------------------------------------------
// Corpus walk — mirrors the oracle's two-pass shape (table first, resolve after).
// ---------------------------------------------------------------------------

const SKIP_DIRECTORIES = new Set([
  ...BUILTIN_IGNORE_PATTERNS.map((pattern) => pattern.replace(/\/$|^\*\*\//g, "")),
  "node_modules",
  "build",
  "dist",
  ".git",
  "coverage",
  "target",
  "vendor",
]);

/**
 * Corpus files for the language, repo-relative and sorted. Test sources are
 * skipped because the production codegraph excludes them unconditionally
 * (`CODEGRAPH_TEST_PATTERNS`) — measuring over them would tally a graph the
 * pipeline never builds.
 */
function collectSourceFiles(root: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(child);
        continue;
      }
      if (!extensions.includes(extname(entry.name))) continue;
      const relPath = relative(root, child).split(sep).join("/");
      if (isTestPath(relPath)) continue;
      found.push(relPath);
    }
  };
  walk(root);
  return found.sort();
}

/** Conventional test locations across the two corpora this harness targets. */
function isTestPath(relPath: string): boolean {
  return /(^|\/)(tests?|src\/test)\//.test(relPath) || /(^|\/)test_[^/]+$|_test\.[^/]+$|Test\.java$/.test(relPath);
}

function extractFile(root: string, relPath: string, composer: DefaultSymbolIdComposer, factory: LanguageFactory) {
  const config = CODEGRAPH_LANGUAGES[extname(relPath)];
  const provider = factory.create(config.language);
  const { walker } = provider;
  if (!walker) return null;
  try {
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
    return walker.walk({ tree, code, relPath, language: config.language, chunks });
  } catch {
    return null;
  }
}

function buildSymbolDefs(extraction: FileExtraction): SymbolDefinition[] {
  return extraction.chunks.map((chunk) => ({
    symbolId: chunk.symbolId,
    fqName: chunk.symbolId,
    shortName: lastSegment(chunk.symbolId),
    relPath: extraction.relPath,
    scope: chunk.scope,
  }));
}

function buildCallContext(
  extraction: FileExtraction,
  chunk: ChunkExtraction,
  symbolTable: InMemoryGlobalSymbolTable,
  classExtends: Record<string, string>,
): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable,
    classFieldTypes: extraction.classFieldTypes,
    localBindings: chunk.localBindings,
    classExtends,
  };
}

interface RunResult {
  rows: CallSiteRow[];
  files: number;
  parseFailures: number;
  symbols: number;
  dispatchSkipped: number;
  /** Rebuilt baseline disagreeing with the production resolver. MUST be 0. */
  chainDrift: number;
}

function run(root: string, lang: string, deferPass: string | null, limit: number, quiet: boolean): RunResult {
  const spec = CHAINS[lang];
  if (!spec) throw new Error(`no chain spec for language '${lang}' (have: ${Object.keys(CHAINS).join(", ")})`);

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const production = factory.create(lang).resolver;
  if (!production) throw new Error(`language '${lang}' has no resolver`);

  const baselineChain = spec.build();
  const variantChain = deferPass
    ? spec.build().map((s) => (s.name === deferPass ? new DeferFileOnlyStrategy(s) : s))
    : null;
  if (deferPass && !baselineChain.some((s) => s.name === deferPass)) {
    throw new Error(
      `no pass named '${deferPass}' in the ${lang} chain (have: ${baselineChain.map((s) => s.name).join(", ")})`,
    );
  }

  const symbolTable = new InMemoryGlobalSymbolTable();
  const classExtends: Record<string, string> = {};
  const extractions: FileExtraction[] = [];
  const corpusFiles = new Set<string>();
  let parseFailures = 0;

  for (const relPath of collectSourceFiles(root, spec.extensions).slice(0, limit)) {
    const extraction = extractFile(root, relPath, composer, factory);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    extractions.push(extraction);
    corpusFiles.add(relPath);
  }
  if (!quiet) process.stderr.write(`pass 1: ${extractions.length} files, ${symbolTable.size()} symbols\n`);

  const rows: CallSiteRow[] = [];
  let dispatchSkipped = 0;
  let chainDrift = 0;

  for (const extraction of extractions) {
    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(extraction, chunk, symbolTable, classExtends);
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) {
          dispatchSkipped++;
          continue;
        }
        const baseline = resolveViaChain(baselineChain, call, ctx);
        if (!sameTarget(baseline, production.resolve(call, ctx))) chainDrift++;
        rows.push({
          relPath: extraction.relPath,
          startLine: call.startLine,
          callText: call.callText,
          receiver: call.receiver,
          member: call.member,
          baseline,
          variant: variantChain ? resolveViaChain(variantChain, call, ctx) : baseline,
          baselineTargetInProject: baseline !== null && corpusFiles.has(baseline.targetRelPath),
        });
      }
    }
  }

  return { rows, files: extractions.length, parseFailures, symbols: symbolTable.size(), dispatchSkipped, chainDrift };
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
    lang: read("--lang") ?? "python",
    defer: read("--defer") ?? null,
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    samples: Number(read("--samples") ?? 10),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
  };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const result = run(opts.corpus, opts.lang, opts.defer, opts.limit, opts.quiet);
  const baseline = tallyChainOutput(result.rows.map((r) => r.baseline));
  const variant = tallyChainOutput(result.rows.map((r) => r.variant));
  const { tally, changed } = diffRows(result.rows);

  const out: string[] = [
    `CORPUS ${opts.corpus} · lang ${opts.lang}`,
    `  ${result.files} files, ${result.symbols} symbols, ${result.rows.length} call sites` +
      ` (parse failures ${result.parseFailures}, dispatch skipped ${result.dispatchSkipped})`,
    `  chain drift vs production resolver: ${result.chainDrift}${result.chainDrift === 0 ? "" : "  ← REBUILD IS STALE, numbers void"}`,
    "",
    "CHAIN OUTPUT (what the resolver emitted)",
    `  baseline  edges ${baseline.edges} (of which file-only ${baseline.fileOnly}) · unresolved ${baseline.unresolved}`,
  ];
  if (opts.defer) {
    out.push(
      `  deferred(${opts.defer})  edges ${variant.edges} (of which file-only ${variant.fileOnly}) · unresolved ${variant.unresolved}`,
      "",
      "DIFF (per call site)",
      `  changed ${changed.length}` +
        ` · upgraded-same-file ${tally.upgradedSameFile}` +
        ` · relocated-other-file ${tally.relocatedOtherFile}` +
        ` · lost ${tally.lost} · gained ${tally.gained} · other ${tally.other}`,
      `  of the relocations: from an IN-PROJECT file ${tally.relocatedFromInProject}` +
        ` · from a PHANTOM external path ${tally.relocatedFromExternal} (fabricated in-project edges)`,
    );
    for (const row of changed.slice(0, opts.samples)) {
      out.push(
        `    ${row.relPath}:${row.startLine} ${row.callText}` +
          `\n      baseline ${describe(row.baseline)}${row.baselineTargetInProject ? " [in-project]" : " [external]"}` +
          `\n      deferred ${describe(row.variant)}`,
      );
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);

  if (opts.json) {
    writeFileSync(
      opts.json,
      `${JSON.stringify({ opts, result: { ...result, rows: undefined }, baseline, variant, tally, changed }, null, 2)}\n`,
    );
  }
}

function describe(target: SymbolResolutionTarget | null): string {
  return target === null ? "(none)" : `${target.targetRelPath} # ${target.targetSymbolId ?? "file-only"}`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) main();
