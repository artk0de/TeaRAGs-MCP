import { createRequire } from "node:module";

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE, type AmbiguousResolveMode } from "../../contracts/types/codegraph.js";
import type {
  LanguageCapability,
  LanguageFactoryDescriptor,
  LanguageProvider,
} from "../../contracts/types/language.js";
import type { SignalFloors } from "../../contracts/types/trajectory.js";
import { BashLanguage } from "./bash/index.js";
import { signalFloors as bashSignalFloors } from "./bash/signal-floors.js";
import { nativeLanguageCapabilities } from "./capability/native.js";
import { GrammarPackageNotInstalledError, UnsupportedLanguageError } from "./errors.js";
import { GoLanguage } from "./go/index.js";
import { signalFloors as goSignalFloors } from "./go/signal-floors.js";
import { JavaLanguage } from "./java/index.js";
import { signalFloors as javaSignalFloors } from "./java/signal-floors.js";
import { JavaScriptLanguage } from "./javascript/index.js";
import { signalFloors as javascriptSignalFloors } from "./javascript/signal-floors.js";
import { MarkdownLanguage } from "./markdown/index.js";
import { signalFloors as markdownSignalFloors } from "./markdown/signal-floors.js";
import { PythonLanguage } from "./python/index.js";
import { signalFloors as pythonSignalFloors } from "./python/signal-floors.js";
import { RubyLanguage } from "./ruby/index.js";
import { signalFloors as rubySignalFloors } from "./ruby/signal-floors.js";
import { RustLanguage } from "./rust/index.js";
import { signalFloors as rustSignalFloors } from "./rust/signal-floors.js";
import { SwiftLanguage } from "./swift/index.js";
import { signalFloors as swiftSignalFloors } from "./swift/signal-floors.js";
import { TypeScriptLanguage } from "./typescript/index.js";
import { signalFloors as typescriptSignalFloors } from "./typescript/signal-floors.js";

/**
 * Languages the factory builds NATIVELY from a `domains/language/<lang>`
 * provider. The factory owns the construction (`new RubyLanguage(mode)`) so the
 * native switch lives in ONE place — `create(lang)` — not at every composition
 * root. ALL supported languages are now native (the legacy adapter / chunker
 * registry that wrapped per-language `LANGUAGE_DEFINITIONS` / `CODEGRAPH_LANGUAGES`
 * into thunks was removed by tea-rags-mcp-jh40 once every vertical migrated).
 * bd tea-rags-mcp-cen6.
 */
const NATIVE_LANGUAGES: ReadonlySet<string> = new Set<string>([
  "ruby",
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
  "rust",
  "bash",
  "swift",
  "markdown",
]);

/**
 * Whether an npm package resolves from this module — the factory's default
 * grammar check. Only a missing package reads as "not installed": any other
 * resolution failure (a broken `exports` map, say) means the package IS there,
 * and the grammar load itself reports what is wrong with it.
 */
const resolveFromFactory = createRequire(import.meta.url);
function isPackageResolvable(packageName: string): boolean {
  try {
    resolveFromFactory.resolve(packageName);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND";
  }
}

/**
 * Real `LanguageFactoryDescriptor`. `create(lang)` ENCAPSULATES construction — it builds
 * the native `domains/language/<lang>` provider itself (`new RubyLanguage(mode)`,
 * …), applying the configured ambiguous-resolve `mode`, rather than reading one
 * from a consumer-assembled registry. Unknown languages throw
 * `UnsupportedLanguageError`.
 *
 * Each built provider is cached per language (spec §5: `create` is expensive —
 * it loads the grammar / builds a Parser — so callers MUST cache; the factory
 * caches internally too, so repeat `create(lang)` is a map lookup).
 */
export class LanguageFactory implements LanguageFactoryDescriptor {
  /**
   * Shared native ambiguous-resolve mode. Threaded into EVERY native provider's
   * resolver (`RubyLanguage`, `TypeScriptLanguage`, …). Generalised when the
   * typescript vertical landed (bd tea-rags-mcp-cen6).
   */
  private readonly ambiguousResolveMode: AmbiguousResolveMode;
  /**
   * FALLBACK root for providers that resolve against project-root-relative
   * configuration — TypeScript's `tsconfig.json` today (bd tea-rags-mcp-f4wcm).
   *
   * It is a fallback, not the answer: this factory is built once per process
   * (composition root, or per-collection in the enrichment worker), and a
   * codegraph run learns which repository it is indexing only when the run
   * starts. So the authoritative root travels per run on
   * `CallContext.projectRoot` and a provider binds to it lazily; this value is
   * what a resolve falls back to when no context root was supplied, which is
   * the shape scripts and unit tests running inside the target repo rely on.
   */
  private readonly repoRoot: string;
  private readonly cache = new Map<string, LanguageProvider>();
  /**
   * bd tea-rags-mcp-e2pu7 — whether a grammar package is installed. Checked in
   * `create` against the built provider's `kernel.grammarPackage`.
   */
  private readonly isGrammarPackageInstalled: (packageName: string) => boolean;

  /**
   * @param options.ambiguousResolveMode Threaded into native resolvers
   *   (`RubyLanguage`, `TypeScriptLanguage`, …). Defaults to the codegraph
   *   default (`strict`).
   * @param options.repoRoot Fallback root for providers that resolve against
   *   project-root-relative configuration (TypeScript's tsconfig today), used
   *   when a resolve arrives with no `CallContext.projectRoot`. Defaults to
   *   `process.cwd()`, which is what every caller got before it existed.
   * @param options.isGrammarPackageInstalled Grammar-package check. Defaults to
   *   resolving the package from this module; tests substitute a fake.
   */
  constructor(
    options: {
      ambiguousResolveMode?: AmbiguousResolveMode;
      repoRoot?: string;
      isGrammarPackageInstalled?: (packageName: string) => boolean;
    } = {},
  ) {
    this.ambiguousResolveMode = options.ambiguousResolveMode ?? DEFAULT_AMBIGUOUS_RESOLVE_MODE;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.isGrammarPackageInstalled = options.isGrammarPackageInstalled ?? isPackageResolvable;
  }

  /**
   * Build (or return the cached) provider for `lang`. Throws
   * `GrammarPackageNotInstalledError` when the provider's grammar package does
   * not resolve — nothing is cached then, so a call after `npm install`
   * re-checks — and `UnsupportedLanguageError` for an unknown language.
   */
  create(lang: string): LanguageProvider {
    const cached = this.cache.get(lang);
    if (cached) return cached;

    const provider = this.build(lang);
    const { grammarPackage } = provider.kernel;
    if (grammarPackage !== undefined && !this.isGrammarPackageInstalled(grammarPackage)) {
      throw new GrammarPackageNotInstalledError(lang, grammarPackage);
    }
    this.cache.set(lang, provider);
    return provider;
  }

  /** Construct (never cache) — `create` owns the cache. */
  private build(lang: string): LanguageProvider {
    // Native switch — extend with one branch per language vertical.
    if (lang === "ruby") return new RubyLanguage(this.ambiguousResolveMode);
    if (lang === "typescript") return new TypeScriptLanguage(this.ambiguousResolveMode, this.repoRoot);
    if (lang === "javascript") return new JavaScriptLanguage(this.ambiguousResolveMode);
    if (lang === "python") return new PythonLanguage(this.ambiguousResolveMode);
    if (lang === "go") return new GoLanguage(this.ambiguousResolveMode);
    if (lang === "java") return new JavaLanguage(this.ambiguousResolveMode);
    if (lang === "rust") return new RustLanguage(this.ambiguousResolveMode);
    if (lang === "bash") return new BashLanguage(this.ambiguousResolveMode);
    if (lang === "swift") return new SwiftLanguage(this.ambiguousResolveMode);
    // Markdown is DOC-ONLY — no resolver, so no `mode` is threaded.
    if (lang === "markdown") return new MarkdownLanguage();
    throw new UnsupportedLanguageError(lang);
  }

  supported(): string[] {
    return [...NATIVE_LANGUAGES];
  }

  /**
   * Static per-language capability descriptors, keyed by language. Mirrors
   * `supported()` (same native set) but LIGHTWEIGHT — imports only each
   * `capability.ts` const, never constructs a runtime provider (no grammar /
   * Parser load). Single source of truth for the language-compatibility
   * generator (rule + README renderers) and prime's per-index highlight.
   */
  capabilities(): Map<string, LanguageCapability> {
    return nativeLanguageCapabilities();
  }

  /**
   * Per-language structural-signal floors, keyed by language. Lightweight in
   * the same way as `capabilities()` — one const import per language, no
   * provider constructed, no grammar loaded. Every entry in `supported()`
   * appears here (`markdown` deliberately empty), which is what stops a new
   * language from shipping without a decision about its floors.
   */
  signalFloors(): Map<string, SignalFloors> {
    return new Map<string, SignalFloors>([
      ["ruby", rubySignalFloors],
      ["typescript", typescriptSignalFloors],
      ["javascript", javascriptSignalFloors],
      ["python", pythonSignalFloors],
      ["go", goSignalFloors],
      ["java", javaSignalFloors],
      ["rust", rustSignalFloors],
      ["bash", bashSignalFloors],
      ["swift", swiftSignalFloors],
      ["markdown", markdownSignalFloors],
    ]);
  }
}
