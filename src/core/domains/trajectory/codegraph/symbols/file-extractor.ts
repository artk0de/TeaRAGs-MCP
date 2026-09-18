/**
 * Pass-1 extraction seam of the codegraph symbols provider: how a file on disk
 * becomes a `FileExtraction`. Owns the per-extension language table, the
 * extractability predicate, repository discovery and pass-1 timing/progress.
 *
 * Touches no graph store and no run-global map — the extraction sink does that.
 * The walker, symbol collector and composer are injected: `trajectory` may not
 * import `domains/language`.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

import type { Ignore } from "ignore";
import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import GoLang from "tree-sitter-go";
import JavaLang from "tree-sitter-java";
import JsLang from "tree-sitter-javascript";
import PyLang from "tree-sitter-python";
import RbLang from "tree-sitter-ruby";
import RustLang from "tree-sitter-rust";
import TsLang from "tree-sitter-typescript";

import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../../contracts/types/language.js";
import { fileIsInertForExtraction } from "../../../../infra/extraction-fast-path.js";
import { materializeTree } from "../../../../infra/materialize.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { CodegraphPhaseTimings } from "./phase-timings.js";
import type { CodegraphRunState } from "./run-state.js";

/**
 * Per-extension parser config. Codegraph walks any file whose extension has a
 * {@link CODEGRAPH_LANGUAGES} row; the walk and `nameOf` come from the injected
 * `LanguageFactoryDescriptor` (`factory.create(lang).walker`), keyed by language
 * name. Adding a language: a tree-sitter grammar dependency, a native
 * `domains/language/<lang>` provider, and a row here.
 */
export interface CodegraphLanguageConfig {
  language: string;
  loadParser: () => Parser.Language;
  /**
   * Joiner used to build the fully-qualified symbol id from the scope
   * stack + the local node name. TypeScript / Python use ".", Ruby
   * uses "::", Go uses ".", Rust uses "::". Wrong separator here
   * silently misroutes resolver lookups — Ruby `Acme::User` indexed as
   * `Acme.User` wouldn't match the receiver string the walker emits
   * for the call site.
   */
  scopeSeparator: string;
  /**
   * When true, duplicate composed symbolIds inside one file are disambiguated
   * with `~N` (first occurrence unchanged, second → `~2`, …) instead of deduped,
   * mirroring the chunker so cg_symbols and the Qdrant payload agree per AST node.
   * Enable where overloads carry distinct bodies (Java, bd tea-rags-mcp-a466);
   * leave false where same-name declarations are stub/impl or accessor pairs and
   * the first should win (Python singledispatch, bd d4ab; TS getter/setter).
   */
  disambiguateOverloads?: boolean;
}

export const CODEGRAPH_LANGUAGES: Record<string, CodegraphLanguageConfig> = {
  // `.ts` and `.tsx` load different grammars; the native TypeScript walker
  // handles both grammars' node types.
  ".ts": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).typescript,
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).tsx,
    scopeSeparator: ".",
  },
  ".py": {
    language: "python",
    loadParser: () => PyLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".rb": {
    language: "ruby",
    loadParser: () => RbLang as Parser.Language,
    scopeSeparator: "::",
  },
  // JavaScript variants — the single `tree-sitter-javascript` grammar serves all
  // four extensions.
  ".js": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".jsx": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".mjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".cjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".go": {
    language: "go",
    loadParser: () => GoLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".java": {
    language: "java",
    loadParser: () => JavaLang as Parser.Language,
    scopeSeparator: ".",
    // bd tea-rags-mcp-a466 — each Java overload needs its own symbolId so
    // `get_callers` / `get_callees` can pin the right body.
    disambiguateOverloads: true,
  },
  ".rs": {
    language: "rust",
    loadParser: () => RustLang as Parser.Language,
    scopeSeparator: "::",
  },
  // Bash — two extensions, one grammar (`.sh` and `.bash` share the single
  // BashLang).
  ".sh": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".bash": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    scopeSeparator: ".",
  },
};

/** Extensions with a {@link CODEGRAPH_LANGUAGES} row — the only files the walk can parse. */
export const CODEGRAPH_SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(CODEGRAPH_LANGUAGES));

/**
 * Extension → the language a file of it is walked as — the same table, reduced
 * to plain data. It is what the provider declares as
 * `workerDescriptor.languageAffinity.partitionByExtension` (bd
 * tea-rags-mcp-sgo8v), so the executor partitions a run by exactly the
 * languages the walk will stamp on its records.
 */
export const CODEGRAPH_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(CODEGRAPH_LANGUAGES).map(([extension, config]) => [extension, config.language])),
);

/** The path's extension including the dot, or `""` when it has none. */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

/**
 * Files between pass-1 progress lines. Coarser than pass-2's 100 because the
 * line carries the larger phase-split payload; 500 keeps a 20k-file run at ~40
 * lines while bounding what a kill at the 5-minute budget can lose.
 */
const PASS1_PROGRESS_EVERY = 500;

/** What the extractor reads; the provider builds it once and shares the instances. */
export interface CodegraphFileExtractorDeps {
  languageFactory: LanguageFactoryDescriptor;
  collectSymbols: CollectSymbolsFn;
  composer: SymbolIdComposer;
  /** Read for the run's Gemfile and declared dependencies, which gate the walk. */
  runState: CodegraphRunState;
  /** Shared with the pass-2 finalizer so both halves land in one summary. */
  phaseTimings: CodegraphPhaseTimings;
  /** The provider's codegraph-layer ignore filter — the same instance its policy reads. */
  exclusionFilter: Ignore;
}

/**
 * Parses and walks files into `FileExtraction`s for one provider instance.
 */
export class CodegraphFileExtractor {
  /**
   * Next cumulative pass-1 file count that earns a progress line. Held as state
   * rather than derived with a modulo because a fan-out absorb folds a whole
   * unit in at once and can jump past an exact multiple (see `recordPass1`).
   */
  private nextPass1ProgressAt = PASS1_PROGRESS_EVERY;

  constructor(private readonly deps: CodegraphFileExtractorDeps) {}

  /**
   * Whether the walk can produce rows for this path at all — the predicate every
   * pass-1 entry point applies before parsing (bd tea-rags-mcp-65bkl). Beyond
   * `shouldEnrich`, it requires a {@link CODEGRAPH_LANGUAGES} row: a `tsconfig.json`
   * still gets its all-zero payload block but never a `cg_symbols_files` row, and
   * the repair diff has to know that.
   */
  isExtractable(relPath: string): boolean {
    return CODEGRAPH_SUPPORTED_EXTENSIONS.has(extensionOf(relPath)) && !this.deps.exclusionFilter.ignores(relPath);
  }

  /**
   * Recursively enumerate supported-language files under `root`, applying two
   * ignore layers per entry (tea-rags-mcp-tf1o, hh4m):
   *
   *   Layer 1 — `scannerIgnoreFilter` (FileScanner's filter via
   *             `FileSignalOptions.ignoreFilter`): BUILTIN_IGNORE_PATTERNS + the
   *             user's `.gitignore` / `.contextignore` — the chunks do not exist
   *             in Qdrant either, so it must be honoured.
   *   Layer 2 — the codegraph exclusion filter: generated + test patterns,
   *             language globs and `CODEGRAPH_CUSTOM_EXCLUDE` — excluded from
   *             the graph while Qdrant still indexes them.
   *
   * Two layers, not a union: merging them either leaks codegraph-only patterns
   * into Qdrant or lets test files back into the graph. Directories are skipped
   * early on both layers (trailing-slash probe). Returns repo-relative POSIX paths.
   */
  discover(root: string, scannerIgnoreFilter?: Ignore): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Dotfiles are pruned at this layer (the scanner filter has no blanket
        // dotfile rule); `.claude-plugin/` is the one exception — shipped source.
        if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
        const full = join(dir, entry.name);
        const relPath = relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          // ignore.ignores() expects a path that semantically denotes
          // a directory (trailing slash) so `node_modules/` matches.
          const dirRel = `${relPath}/`;
          if (scannerIgnoreFilter?.ignores(dirRel)) continue;
          if (this.deps.exclusionFilter.ignores(dirRel)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!CODEGRAPH_SUPPORTED_EXTENSIONS.has(extensionOf(entry.name))) continue;
        if (scannerIgnoreFilter?.ignores(relPath)) continue;
        if (this.deps.exclusionFilter.ignores(relPath)) continue;
        out.push(relPath);
      }
    };
    walk(root);
    return out;
  }

  /** Parse + walk one file from disk, recording its pass-1 time. */
  extract(root: string, relPath: string): FileExtraction {
    const startedAtMs = Date.now();
    const extraction = this.parse(root, relPath);
    this.recordPass1(extraction.language, Date.now() - startedAtMs);
    return extraction;
  }

  /**
   * Fold extraction cost into the run's pass-1 total and, on the cadence, report
   * where the run stands. The line is the ONLY pass-1 telemetry a killed run
   * leaves behind, so it carries the cumulative per-language split and not just
   * a counter. JSON rather than an inspected object: the split nests past
   * `console.error`'s two-level default.
   *
   * `files` is 1 on the serial path (one call per parsed file) and the unit's
   * whole count when the fan-out folds an extraction unit's attribution in at
   * absorb time. The cadence is therefore a THRESHOLD CROSSING, not an exact
   * multiple: a single fan-out absorb can carry hundreds of files past the mark
   * at once, and `count % 500 === 0` would silently never fire again.
   */
  recordPass1(language: string, durationMs: number, files = 1): void {
    const { phaseTimings } = this.deps;
    phaseTimings.record("pass1", durationMs, { language: language || "unknown", count: files });
    const extracted = phaseTimings.count("pass1");
    if (extracted < this.nextPass1ProgressAt || !isDebug()) return;
    this.nextPass1ProgressAt = extracted - (extracted % PASS1_PROGRESS_EVERY) + PASS1_PROGRESS_EVERY;
    const elapsedMs = phaseTimings.elapsedMs();
    console.error(
      "[GitEnrich] PHASE: CODEGRAPH_PASS1_PROGRESS",
      JSON.stringify({
        extracted,
        elapsedMs,
        filesPerSec: elapsedMs > 0 ? Math.round((extracted / elapsedMs) * 1000 * 10) / 10 : 0,
        phases: phaseTimings.toSummary(),
      }),
    );
  }

  /** Parse + walk one file. Timing and progress belong to `extract`. */
  parse(root: string, relPath: string): FileExtraction {
    const ext = extensionOf(relPath);
    const langConfig = CODEGRAPH_LANGUAGES[ext];
    if (!langConfig) {
      // `discover` already filters by extension; this is a defensive guard for
      // callers that pass paths directly.
      return { relPath, language: "", imports: [], chunks: [], fileScope: [] };
    }
    // The walker (walk + nameOf) comes from the injected factory, keyed by language
    // NAME; parser, scopeSeparator and disambiguateOverloads from CODEGRAPH_LANGUAGES.
    const { walker } = this.deps.languageFactory.create(langConfig.language);
    if (!walker) {
      // Defensive: a code language always has a walker (markdown — the only
      // walker-less provider — has no CODEGRAPH_LANGUAGES entry, so we never
      // reach here for it). Return an empty extraction rather than throw.
      return { relPath, language: langConfig.language, imports: [], chunks: [], fileScope: [] };
    }
    const { runState } = this.deps;
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(langConfig.loadParser());
    // Materialize the native tree right after parse so collectSymbols and the walk
    // both see the deterministic plain-JS AstNode tree, as at the chunker boundary
    // (rdv7d).
    const nativeTree = parser.parse(code);
    // bd tea-rags-mcp-1v12o.2.4 — a file bearing none of the node types the walker
    // reads yields the empty extraction; ask the NATIVE tree before materializing
    // it, the most expensive thing pass-1 does on generated data tables.
    if (fileIsInertForExtraction(nativeTree.rootNode, walker.extractionBearingNodeTypes)) {
      return { relPath, language: langConfig.language, imports: [], chunks: [], fileScope: [] };
    }
    const materializedTree = { rootNode: materializeTree(nativeTree.rootNode, code) };
    const chunks = this.deps.collectSymbols(
      materializedTree,
      // Gem-gated declares (bd tea-rags-mcp-o5kwh): bind the run's Gemfile so the
      // Ruby nameOf gates class-body macro DECLARES to this project's gems.
      // undefined runGemfileContent -> FULL catalogue (other languages ignore it).
      (node) => walker.nameOf(node, runState.gemfileContent),
      langConfig.scopeSeparator,
      langConfig.disambiguateOverloads ?? false,
      this.deps.composer,
    );
    return walker.walk({
      tree: materializedTree,
      code,
      relPath,
      language: langConfig.language,
      chunks,
      // Gem-gated DSL grammar at extraction time (adx5p.1b): the run's Gemfile,
      // read once in loadGemfile. undefined → FULL catalogue.
      gemfileContent: runState.gemfileContent,
      // Vocabulary gating at extraction time (bd tea-rags-mcp-w205u.1): the run's
      // declared dependencies, walked once in loadDeclaredDependencies.
      // undefined → no manifest anywhere → FULL catalogue.
      declaredDependencies: runState.declaredDependencies,
    });
  }
}
