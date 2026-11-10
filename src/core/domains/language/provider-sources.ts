/**
 * Lazy per-language provider sources (bd tea-rags-mcp-zkd96).
 *
 * The registry maps each native language to a source that dynamic-imports its
 * vertical's facade and returns a SYNC builder. Every specifier below is a
 * dynamic `import()` on purpose: a static import here would restore the static
 * closure `factory.ts -> <lang>/index.ts -> <lang> resolver/walker` that put
 * every pipeline-booting test into `vitest related` for any resolver edit.
 * Dynamic imports are invisible to the static import graph, so only the
 * language verticals' own tests stay related to a vertical's edits.
 *
 * `LanguageFactory.preload(langs?)` resolves the sources it needs (idempotent,
 * deduped); `create(lang)` then constructs synchronously from the loaded
 * builder. Capability descriptors (`capability.ts`, `signal-floors.ts`) stay
 * STATICALLY imported by the factory — they are const-only modules with no
 * resolver/walker reach, and the language-compatibility generator reads them
 * without constructing providers.
 */

import type { AmbiguousResolveMode } from "../../contracts/types/codegraph.js";
import type {
  LanguageProvider,
  ManifestFilesReader,
  RustCallSiteSource,
  RustExternalSignatureSources,
} from "../../contracts/types/language.js";
// Type-only imports: erased at compile time, so they add NO module-graph
// edges — unlike the runtime dynamicImport below, which is the whole point.
import type { BashLanguage } from "./bash/index.js";
import type { CrossRunParseCache } from "./cross-run-parse-cache.js";
import type { GoLanguage } from "./go/index.js";
import type { JavaLanguage } from "./java/index.js";
import type { JavaScriptLanguage } from "./javascript/index.js";
import type { KotlinLanguage } from "./kotlin/index.js";
import type { MarkdownLanguage } from "./markdown/index.js";
import type { ObjcLanguage } from "./objc/index.js";
import type { PhpLanguage } from "./php/index.js";
import type { PythonLanguage } from "./python/index.js";
import type { RubyLanguage } from "./ruby/index.js";
import type { RustLanguage } from "./rust/index.js";
import type { SwiftLanguage } from "./swift/index.js";
import type { TypeScriptLanguage } from "./typescript/index.js";
import type { YamlLanguage } from "./yaml/index.js";

/** The construction arguments `LanguageFactory` threads into every provider. */
export interface ProviderConstructionDeps {
  ambiguousResolveMode: AmbiguousResolveMode;
  repoRoot: string;
  crossRunParseCache?: CrossRunParseCache;
  manifestFilesReader?: ManifestFilesReader;
  rustExternalSignatureSources?: RustExternalSignatureSources;
  rustcCallSiteSource?: RustCallSiteSource;
}

/**
 * A built provider constructor thunk — sync by design: `create()` stays
 * synchronous, the asynchrony lives entirely in `preload()`'s module load.
 */
export type ProviderBuilder = () => LanguageProvider;

/**
 * Loads the vertical's module and returns the sync builder bound to the
 * factory's construction deps. The module import is cached by the module
 * system, so repeated preloads cost one map lookup, not a re-import.
 */
export type ProviderSource = (deps: ProviderConstructionDeps) => Promise<ProviderBuilder>;

/**
 * Languages the factory builds NATIVELY from a `domains/language/<lang>`
 * provider. The registry owns the set (the factory and its tests read it);
 * `providerSources` keys mirror it exactly. ALL supported languages are native
 * (the legacy adapter was removed by tea-rags-mcp-jh40). bd tea-rags-mcp-cen6.
 */
export const NATIVE_LANGUAGES: ReadonlySet<string> = new Set<string>([
  "ruby",
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
  "rust",
  "bash",
  "swift",
  "objc",
  "php",
  "kotlin",
  "markdown",
  "yaml",
]);

/**
 * Indirection so bundler/dev-server static analysis (the vite module graph —
 * what `vitest related` walks) cannot see the specifier: a literal
 * `import("./x")` is a graph edge and would put every pipeline-booting test
 * back into a resolver edit's related set (bd tea-rags-mcp-zkd96). At runtime
 * the resolver (Node in production, the vite runner under vitest) resolves
 * the string exactly the same.
 */
const dynamicImport = async (specifier: string): Promise<Record<string, unknown>> =>
  (await import(specifier)) as Record<string, unknown>;

/**
 * The lazy registry itself. Each entry mirrors the construction branch the
 * factory's `build()` switch used to hold inline — one entry per language
 * vertical, same arguments threaded. Markdown and YAML are DOC-ONLY (no
 * resolver), so no mode is threaded.
 */
export const providerSources: ReadonlyMap<string, ProviderSource> = new Map<string, ProviderSource>([
  [
    "ruby",
    async (deps) => {
      const { RubyLanguage: RubyLanguageCtor } = (await dynamicImport("./ruby/index.js")) as {
        RubyLanguage: typeof RubyLanguage;
      };
      return () => new RubyLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "typescript",
    async (deps) => {
      const { TypeScriptLanguage: TypeScriptLanguageCtor } = (await dynamicImport("./typescript/index.js")) as {
        TypeScriptLanguage: typeof TypeScriptLanguage;
      };
      return () =>
        new TypeScriptLanguageCtor(deps.ambiguousResolveMode, deps.repoRoot, deps.crossRunParseCache?.typescript);
    },
  ],
  [
    "javascript",
    async (deps) => {
      const { JavaScriptLanguage: JavaScriptLanguageCtor } = (await dynamicImport("./javascript/index.js")) as {
        JavaScriptLanguage: typeof JavaScriptLanguage;
      };
      return () => new JavaScriptLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "python",
    async (deps) => {
      const { PythonLanguage: PythonLanguageCtor } = (await dynamicImport("./python/index.js")) as {
        PythonLanguage: typeof PythonLanguage;
      };
      return () => new PythonLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "go",
    async (deps) => {
      const { GoLanguage: GoLanguageCtor } = (await dynamicImport("./go/index.js")) as {
        GoLanguage: typeof GoLanguage;
      };
      return () => new GoLanguageCtor(deps.ambiguousResolveMode, deps.manifestFilesReader);
    },
  ],
  [
    "java",
    async (deps) => {
      const { JavaLanguage: JavaLanguageCtor } = (await dynamicImport("./java/index.js")) as {
        JavaLanguage: typeof JavaLanguage;
      };
      return () => new JavaLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "rust",
    async (deps) => {
      const { RustLanguage: RustLanguageCtor } = (await dynamicImport("./rust/index.js")) as {
        RustLanguage: typeof RustLanguage;
      };
      return () =>
        new RustLanguageCtor(
          deps.ambiguousResolveMode,
          deps.manifestFilesReader,
          deps.rustExternalSignatureSources,
          deps.rustcCallSiteSource,
        );
    },
  ],
  [
    "bash",
    async (deps) => {
      const { BashLanguage: BashLanguageCtor } = (await dynamicImport("./bash/index.js")) as {
        BashLanguage: typeof BashLanguage;
      };
      return () => new BashLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "swift",
    async (deps) => {
      const { SwiftLanguage: SwiftLanguageCtor } = (await dynamicImport("./swift/index.js")) as {
        SwiftLanguage: typeof SwiftLanguage;
      };
      return () => new SwiftLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "objc",
    async (deps) => {
      const { ObjcLanguage: ObjcLanguageCtor } = (await dynamicImport("./objc/index.js")) as {
        ObjcLanguage: typeof ObjcLanguage;
      };
      return () => new ObjcLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "php",
    async (deps) => {
      const { PhpLanguage: PhpLanguageCtor } = (await dynamicImport("./php/index.js")) as {
        PhpLanguage: typeof PhpLanguage;
      };
      return () => new PhpLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "kotlin",
    async (deps) => {
      const { KotlinLanguage: KotlinLanguageCtor } = (await dynamicImport("./kotlin/index.js")) as {
        KotlinLanguage: typeof KotlinLanguage;
      };
      return () => new KotlinLanguageCtor(deps.ambiguousResolveMode);
    },
  ],
  [
    "markdown",
    async () => {
      const { MarkdownLanguage: MarkdownLanguageCtor } = (await dynamicImport("./markdown/index.js")) as {
        MarkdownLanguage: typeof MarkdownLanguage;
      };
      return () => new MarkdownLanguageCtor();
    },
  ],
  [
    "yaml",
    async () => {
      const { YamlLanguage: YamlLanguageCtor } = (await dynamicImport("./yaml/index.js")) as {
        YamlLanguage: typeof YamlLanguage;
      };
      return () => new YamlLanguageCtor();
    },
  ],
]);
