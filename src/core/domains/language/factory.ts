import { createRequire } from "node:module";

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE, type AmbiguousResolveMode } from "../../contracts/types/codegraph.js";
import type {
  LanguageCapability,
  LanguageFactoryDescriptor,
  LanguageProvider,
  ManifestFilesReader,
  RustCallSiteSource,
  RustExternalSignatureSources,
} from "../../contracts/types/language.js";
import type { SignalFloors } from "../../contracts/types/trajectory.js";
import { signalFloors as bashSignalFloors } from "./bash/signal-floors.js";
import { nativeLanguageCapabilities } from "./capability/native.js";
import type { CrossRunParseCache } from "./cross-run-parse-cache.js";
import {
  GrammarPackageNotInstalledError,
  LanguageModuleNotPreloadedError,
  UnsupportedLanguageError,
} from "./errors.js";
import { signalFloors as goSignalFloors } from "./go/signal-floors.js";
import { signalFloors as javaSignalFloors } from "./java/signal-floors.js";
import { signalFloors as javascriptSignalFloors } from "./javascript/signal-floors.js";
import { signalFloors as kotlinSignalFloors } from "./kotlin/signal-floors.js";
import { signalFloors as markdownSignalFloors } from "./markdown/signal-floors.js";
import { signalFloors as objcSignalFloors } from "./objc/signal-floors.js";
import { signalFloors as phpSignalFloors } from "./php/signal-floors.js";
import {
  NATIVE_LANGUAGES,
  providerSources,
  type ProviderBuilder,
  type ProviderConstructionDeps,
} from "./provider-sources.js";
import { signalFloors as pythonSignalFloors } from "./python/signal-floors.js";
import { signalFloors as rubySignalFloors } from "./ruby/signal-floors.js";
import { signalFloors as rustSignalFloors } from "./rust/signal-floors.js";
import { signalFloors as swiftSignalFloors } from "./swift/signal-floors.js";
import { signalFloors as typescriptSignalFloors } from "./typescript/signal-floors.js";
import { signalFloors as yamlSignalFloors } from "./yaml/signal-floors.js";

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
 * Real `LanguageFactoryDescriptor`. `create(lang)` ENCAPSULATES construction — it
 * builds the native `domains/language/<lang>` provider itself, applying the
 * configured ambiguous-resolve `mode`, rather than reading one from a
 * consumer-assembled registry. Unknown languages throw
 * `UnsupportedLanguageError`; a known language whose module was not loaded
 * throws `LanguageModuleNotPreloadedError`.
 *
 * bd tea-rags-mcp-zkd96 — the factory reaches the per-language verticals
 * through the LAZY registry in `provider-sources.ts` (dynamic `import()`), not
 * static imports: the static closure `factory -> <lang>/index.ts -> <lang>
 * resolver/walker` put every pipeline-booting test into `vitest related` for
 * any resolver edit. `preload()` loads the sources (idempotent, deduped);
 * `create()` stays synchronous and only serves preloaded languages. The
 * composition root and the worker entries preload before first use; capability
 * descriptors and signal floors stay statically readable.
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
   * what a resolve falls back to when no context root was supplied, which is the
   * shape scripts and unit tests running inside the target repo rely on.
   */
  private readonly repoRoot: string;
  private readonly cache = new Map<string, LanguageProvider>();
  /** Sync builders materialized by `preload` — empty until a language is loaded. */
  private readonly builders = new Map<string, ProviderBuilder>();
  /** In-flight loads, so concurrent `preload` calls share one module import. */
  private readonly loading = new Map<string, Promise<void>>();
  /**
   * bd tea-rags-mcp-e2pu7 — whether a grammar package is installed. Checked in
   * `create` against the built provider's `kernel.grammarPackage`.
   */
  private readonly isGrammarPackageInstalled: (packageName: string) => boolean;
  /**
   * Parses carried in from earlier runs of a long-lived process — absent, every
   * provider parses cold. Only the stores are shared; each provider this
   * factory builds is otherwise as fresh as the factory.
   */
  private readonly crossRunParseCache: CrossRunParseCache | undefined;
  /**
   * The manifest walk, injected (bd tea-rags-mcp-2wu2h): this leaf domain never
   * reaches the disk walk itself. Go's module map reads its go.mod files
   * through it; absent, Go package matching stays GOPATH-shaped.
   */
  private readonly manifestFilesReader: ManifestFilesReader | undefined;
  /** The Rust external signature sources, injected for the same reason (bd s3i8m.7). */
  private readonly rustExternalSignatureSources: RustExternalSignatureSources | undefined;
  /** The rustc call-site index source, injected for the same reason (bd s3i8m T6). */
  private readonly rustcCallSiteSource: RustCallSiteSource | undefined;

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
   * @param options.crossRunParseCache Parse stores a long-lived process hands
   *   every factory it builds, run after run (the warm working-tree graph
   *   child). Threaded to the providers that parse.
   * @param options.manifestFilesReader The manifest walk the composition layer
   *   injects. Threaded to the providers that read location-bound manifests
   *   (Go's go.mod module map).
   * @param options.rustExternalSignatureSources The toolchain / Cargo.lock
   *   source locator and table cache the composition layer injects. Threaded
   *   to Rust's resolver, which loads the external signature table at pass start.
   * @param options.rustcCallSiteSource The rustc call-site driver acquisition the
   *   composition layer injects when the driver is on. Threaded to Rust's resolver,
   *   which awaits it before pass 2; absent, no call-site index is acquired.
   */
  constructor(
    options: {
      ambiguousResolveMode?: AmbiguousResolveMode;
      repoRoot?: string;
      isGrammarPackageInstalled?: (packageName: string) => boolean;
      crossRunParseCache?: CrossRunParseCache;
      manifestFilesReader?: ManifestFilesReader;
      rustExternalSignatureSources?: RustExternalSignatureSources;
      rustcCallSiteSource?: RustCallSiteSource;
    } = {},
  ) {
    this.manifestFilesReader = options.manifestFilesReader;
    this.rustExternalSignatureSources = options.rustExternalSignatureSources;
    this.rustcCallSiteSource = options.rustcCallSiteSource;
    this.ambiguousResolveMode = options.ambiguousResolveMode ?? DEFAULT_AMBIGUOUS_RESOLVE_MODE;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.isGrammarPackageInstalled = options.isGrammarPackageInstalled ?? isPackageResolvable;
    this.crossRunParseCache = options.crossRunParseCache;
  }

  /** The construction args threaded into every lazy-built provider. */
  private get constructionDeps(): ProviderConstructionDeps {
    return {
      ambiguousResolveMode: this.ambiguousResolveMode,
      repoRoot: this.repoRoot,
      ...(this.crossRunParseCache !== undefined ? { crossRunParseCache: this.crossRunParseCache } : {}),
      ...(this.manifestFilesReader !== undefined ? { manifestFilesReader: this.manifestFilesReader } : {}),
      ...(this.rustExternalSignatureSources !== undefined
        ? { rustExternalSignatureSources: this.rustExternalSignatureSources }
        : {}),
      ...(this.rustcCallSiteSource !== undefined ? { rustcCallSiteSource: this.rustcCallSiteSource } : {}),
    };
  }

  /**
   * Load the provider modules for `langs` (default: every supported language),
   * materializing the sync builders `create()` constructs from. Idempotent —
   * an already-loaded language is a map lookup; concurrent calls for the same
   * language share one module import. Unknown languages are skipped silently:
   * `create` reports them as unsupported. The composition root, worker entries
   * and test setups call this before the first `create`.
   */
  async preload(langs?: readonly string[]): Promise<void> {
    const wanted = langs ?? [...NATIVE_LANGUAGES];
    await Promise.all(
      [...new Set(wanted)].map(async (lang) => {
        if (this.builders.has(lang)) return;
        const existing = this.loading.get(lang);
        if (existing) return existing;
        const source = providerSources.get(lang);
        if (!source) return;
        const load = (async () => {
          this.builders.set(lang, await source(this.constructionDeps));
        })();
        this.loading.set(lang, load);
        try {
          await load;
        } finally {
          this.loading.delete(lang);
        }
      }),
    );
  }

  /**
   * Convenience for direct constructions (tests, scripts): construct and
   * preload every supported language in one await — the composition root and
   * worker entries preload explicitly instead.
   */
  static async preloaded(options?: ConstructorParameters<typeof LanguageFactory>[0]): Promise<LanguageFactory> {
    const factory = new LanguageFactory(options);
    await factory.preload();
    return factory;
  }

  /**
   * Build (or return the cached) provider for `lang`. Throws
   * `GrammarPackageNotInstalledError` when the provider's grammar package does
   * not resolve — nothing is cached then, so a call after `npm install`
   * re-checks — `LanguageModuleNotPreloadedError` for a supported language
   * whose module was not preloaded, and `UnsupportedLanguageError` for an
   * unknown language.
   */
  create(lang: string): LanguageProvider {
    const cached = this.cache.get(lang);
    if (cached) return cached;

    const builder = this.builders.get(lang);
    if (!builder) {
      if (providerSources.has(lang)) throw new LanguageModuleNotPreloadedError(lang);
      throw new UnsupportedLanguageError(lang);
    }
    const provider = builder();
    const { grammarPackage } = provider.kernel;
    if (grammarPackage !== undefined && !this.isGrammarPackageInstalled(grammarPackage)) {
      throw new GrammarPackageNotInstalledError(lang, grammarPackage);
    }
    this.cache.set(lang, provider);
    return provider;
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
   * appears here (the doc-only languages deliberately empty), which is what stops a new
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
      ["objc", objcSignalFloors],
      ["php", phpSignalFloors],
      ["kotlin", kotlinSignalFloors],
      ["markdown", markdownSignalFloors],
      ["yaml", yamlSignalFloors],
    ]);
  }
}
