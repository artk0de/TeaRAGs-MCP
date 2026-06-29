import { DEFAULT_AMBIGUOUS_RESOLVE_MODE, type AmbiguousResolveMode } from "../../contracts/types/codegraph.js";
import type {
  LanguageCapability,
  LanguageFactoryDescriptor,
  LanguageProvider,
} from "../../contracts/types/language.js";
import { capability as bashCapability } from "./bash/capability.js";
import { BashLanguage } from "./bash/index.js";
import { UnsupportedLanguageError } from "./errors.js";
import { capability as goCapability } from "./go/capability.js";
import { GoLanguage } from "./go/index.js";
import { capability as javaCapability } from "./java/capability.js";
import { JavaLanguage } from "./java/index.js";
import { capability as javascriptCapability } from "./javascript/capability.js";
import { JavaScriptLanguage } from "./javascript/index.js";
import { capability as markdownCapability } from "./markdown/capability.js";
import { MarkdownLanguage } from "./markdown/index.js";
import { capability as pythonCapability } from "./python/capability.js";
import { PythonLanguage } from "./python/index.js";
import { capability as rubyCapability } from "./ruby/capability.js";
import { RubyLanguage } from "./ruby/index.js";
import { capability as rustCapability } from "./rust/capability.js";
import { RustLanguage } from "./rust/index.js";
import { capability as typescriptCapability } from "./typescript/capability.js";
import { TypeScriptLanguage } from "./typescript/index.js";

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
  "markdown",
]);

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
  private readonly cache = new Map<string, LanguageProvider>();

  /**
   * @param options.ambiguousResolveMode Threaded into native resolvers
   *   (`RubyLanguage`, `TypeScriptLanguage`, …). Defaults to the codegraph
   *   default (`strict`).
   */
  constructor(options: { ambiguousResolveMode?: AmbiguousResolveMode } = {}) {
    this.ambiguousResolveMode = options.ambiguousResolveMode ?? DEFAULT_AMBIGUOUS_RESOLVE_MODE;
  }

  create(lang: string): LanguageProvider {
    const cached = this.cache.get(lang);
    if (cached) return cached;

    const provider = this.build(lang);
    this.cache.set(lang, provider);
    return provider;
  }

  /** Construct (never cache) — `create` owns the cache. */
  private build(lang: string): LanguageProvider {
    // Native switch — extend with one branch per language vertical.
    if (lang === "ruby") return new RubyLanguage(this.ambiguousResolveMode);
    if (lang === "typescript") return new TypeScriptLanguage(this.ambiguousResolveMode);
    if (lang === "javascript") return new JavaScriptLanguage(this.ambiguousResolveMode);
    if (lang === "python") return new PythonLanguage(this.ambiguousResolveMode);
    if (lang === "go") return new GoLanguage(this.ambiguousResolveMode);
    if (lang === "java") return new JavaLanguage(this.ambiguousResolveMode);
    if (lang === "rust") return new RustLanguage(this.ambiguousResolveMode);
    if (lang === "bash") return new BashLanguage(this.ambiguousResolveMode);
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
    return new Map<string, LanguageCapability>([
      ["ruby", rubyCapability],
      ["typescript", typescriptCapability],
      ["javascript", javascriptCapability],
      ["python", pythonCapability],
      ["go", goCapability],
      ["java", javaCapability],
      ["rust", rustCapability],
      ["bash", bashCapability],
      ["markdown", markdownCapability],
    ]);
  }
}
