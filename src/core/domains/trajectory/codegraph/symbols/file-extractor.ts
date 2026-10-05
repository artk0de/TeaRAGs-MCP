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
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import type { Ignore } from "ignore";
import Parser from "tree-sitter";

import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  LanguageKernel,
  SymbolIdComposer,
} from "../../../../contracts/types/language.js";
import { extractCodeFileFromText } from "../../../../infra/code-file-extraction.js";
import type { PathFilter } from "../../../../infra/file-classification/index.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { CodegraphPhaseTimings } from "./phase-timings.js";
import type { CodegraphRunState } from "./run-state.js";

/**
 * Per-extension parser config. Codegraph walks any file whose extension has a
 * {@link CODEGRAPH_LANGUAGES} row; the walk and `nameOf` come from the injected
 * `LanguageFactoryDescriptor` (`factory.create(lang).walker`), keyed by language
 * name, and so does the grammar (`factory.create(lang).kernel`). Adding a
 * language: a tree-sitter grammar dependency, a native `domains/language/<lang>`
 * provider whose kernel names it, and a row here.
 */
export interface CodegraphLanguageConfig {
  /**
   * Language the file is walked as. Its grammar comes from that language's
   * kernel (`LanguageFactory.create(language).kernel`), selected per extension
   * by `extractLanguage(mod, extension)` — see {@link loadCodegraphGrammar}.
   */
  language: string;
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
  // `.ts` and `.tsx` load different grammars (the TypeScript kernel selects by
  // extension); the native TypeScript walker handles both grammars' node types.
  ".ts": {
    language: "typescript",
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    scopeSeparator: ".",
  },
  // The ESM / CJS module formats (bd tea-rags-mcp-1y13c): the `typescript`
  // grammar, since neither admits JSX. The import mappers name these files as
  // targets, so a missing row left every such edge without a file to land on.
  // Ingest lists them in `LANGUAGE_MAP` / `DEFAULT_CODE_EXTENSIONS` — the tables
  // move together.
  ".mts": {
    language: "typescript",
    scopeSeparator: ".",
  },
  ".cts": {
    language: "typescript",
    scopeSeparator: ".",
  },
  ".py": {
    language: "python",
    scopeSeparator: ".",
  },
  ".rb": {
    language: "ruby",
    scopeSeparator: "::",
  },
  // JavaScript variants — the single `tree-sitter-javascript` grammar serves all
  // four extensions.
  ".js": {
    language: "javascript",
    scopeSeparator: ".",
  },
  ".jsx": {
    language: "javascript",
    scopeSeparator: ".",
  },
  ".mjs": {
    language: "javascript",
    scopeSeparator: ".",
  },
  ".cjs": {
    language: "javascript",
    scopeSeparator: ".",
  },
  ".go": {
    language: "go",
    scopeSeparator: ".",
  },
  ".java": {
    language: "java",
    scopeSeparator: ".",
    // bd tea-rags-mcp-a466 — each Java overload needs its own symbolId so
    // `get_callers` / `get_callees` can pin the right body.
    disambiguateOverloads: true,
  },
  ".rs": {
    language: "rust",
    scopeSeparator: "::",
  },
  // Swift — one grammar, one extension. `.` joins nested types
  // (`Ledger.Account#post`), matching Java and the `swiftKernel`'s
  // `scopeSeparator`. `disambiguateOverloads` for the same reason Java needs
  // it: Swift methods and initializers overload freely on their parameter
  // lists, each overload carries its own body, and the chunker already
  // suffixes duplicates `~N` — the two halves must agree per AST node.
  ".swift": {
    language: "swift",
    scopeSeparator: ".",
    disambiguateOverloads: true,
  },
  // Bash — two extensions, one grammar (`.sh` and `.bash` share the single
  // tree-sitter-bash grammar).
  ".sh": {
    language: "bash",
    scopeSeparator: ".",
  },
  ".bash": {
    language: "bash",
    scopeSeparator: ".",
  },
};

/**
 * The tree-sitter grammar a file of `extension` is parsed with, loaded through
 * its language's kernel: `factory.create(language)` (which throws
 * `GrammarPackageNotInstalledError` when the kernel's `grammarPackage` does not
 * resolve), `kernel.loadModule()`, then `kernel.extractLanguage(mod, extension)`.
 *
 * bd tea-rags-mcp-e2pu7 — the extractor used to import every grammar
 * statically, so ONE missing grammar package failed this module at link time
 * with a raw ERR_MODULE_NOT_FOUND, for every language at once. Loading per
 * language, on demand, confines a missing grammar to its own files.
 */
export async function loadCodegraphGrammar(
  factory: LanguageFactoryDescriptor,
  extension: string,
): Promise<Parser.Language> {
  const { language, kernel } = kernelForExtension(factory, extension);
  return grammarFromModule(language, extension, kernel, await kernel.loadModule());
}

const requireGrammar = createRequire(import.meta.url);

/**
 * Synchronous twin of {@link loadCodegraphGrammar} for the offline harnesses
 * (`scripts/`), whose per-file walks are synchronous. Same kernel, same
 * `extractLanguage` selection — only the module fetch differs (`require` of
 * `kernel.grammarPackage` instead of `kernel.loadModule()`); a grammar package
 * is CommonJS, so both reach the same `module.exports` object.
 */
export function loadCodegraphGrammarSync(factory: LanguageFactoryDescriptor, extension: string): Parser.Language {
  const { language, kernel } = kernelForExtension(factory, extension);
  if (kernel.grammarPackage === undefined) {
    throw new Error(`Codegraph language "${language}" names no grammar package`);
  }
  return grammarFromModule(language, extension, kernel, requireGrammar(kernel.grammarPackage) as TreeSitterModule);
}

type TreeSitterModule = Awaited<ReturnType<LanguageKernel["loadModule"]>>;

function kernelForExtension(
  factory: LanguageFactoryDescriptor,
  extension: string,
): { language: string; kernel: LanguageKernel } {
  const row = CODEGRAPH_LANGUAGES[extension];
  if (!row) throw new Error(`No codegraph language for extension "${extension}"`);
  return { language: row.language, kernel: factory.create(row.language).kernel };
}

function grammarFromModule(
  language: string,
  extension: string,
  kernel: LanguageKernel,
  mod: TreeSitterModule,
): Parser.Language {
  if (mod === null) throw new Error(`Codegraph language "${language}" loads no grammar`);
  const grammar = kernel.extractLanguage ? kernel.extractLanguage(mod, extension) : (mod.default ?? mod);
  return grammar as Parser.Language;
}

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
  exclusionFilter: PathFilter;
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
  /**
   * Grammar per extension, loaded once through the language kernel. A failed
   * load (missing grammar package) is evicted, so a later file re-checks.
   */
  private readonly grammars = new Map<string, Promise<Parser.Language>>();

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
  async extract(root: string, relPath: string): Promise<FileExtraction> {
    const startedAtMs = Date.now();
    const extraction = await this.parse(root, relPath);
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

  /**
   * Parse + walk one file. Timing and progress belong to `extract`. Rejects with
   * `GrammarPackageNotInstalledError` when this file's language has no installed
   * grammar; files of other languages are unaffected.
   */
  async parse(root: string, relPath: string): Promise<FileExtraction> {
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
    parser.setLanguage(await this.grammarFor(ext));
    return extractCodeFileFromText(
      { parser, walker, collectSymbols: this.deps.collectSymbols, composer: this.deps.composer },
      {
        relPath,
        text: code,
        language: langConfig.language,
        scopeSeparator: langConfig.scopeSeparator,
        disambiguateOverloads: langConfig.disambiguateOverloads ?? false,
        // Vocabulary gating at extraction time (bd tea-rags-mcp-w205u.1,
        // adx5p.1b, m99j1.1.8): this language's declared dependencies, read once
        // in loadDeclaredDependencies. undefined → no manifest → FULL catalogue.
        declaredDependencies: runState.declaredDependenciesFor(langConfig.language),
      },
    );
  }

  private async grammarFor(extension: string): Promise<Parser.Language> {
    let pending = this.grammars.get(extension);
    if (!pending) {
      pending = loadCodegraphGrammar(this.deps.languageFactory, extension);
      this.grammars.set(extension, pending);
      pending.catch(() => this.grammars.delete(extension));
    }
    return pending;
  }
}
