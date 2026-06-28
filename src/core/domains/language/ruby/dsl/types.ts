/**
 * Ruby/Rails class-body DSL type contracts. Pure data — no tree-sitter. The
 * per-framework module files (`ruby-core.ts`, `activesupport.ts`, `rails.ts`)
 * each export a `RubyDslModule`; `catalogue.ts` composes them into `RUBY_DSL`.
 */

export type MethodKind = "instance" | "static";

export type DslCategory =
  // method-declaring macros (carry `declares`; alias also `redirectTarget`)
  | "accessor"
  | "delegation"
  | "alias"
  | "dynamic-method"
  // group-only Rails declaration keywords (no `declares`)
  | "association"
  | "validation"
  | "scope"
  | "callback"
  | "include"
  | "enum"
  | "state-machine"
  | "concern-hook"
  | "nested-attrs"
  | "other";

/** A method a macro declares, given an already-parsed base symbol name. */
export type DeclaredMethodSpec = { name: string; kind: MethodKind };

export interface RubyDslEntry {
  /** Intrinsic category. Drives the chunker's class-body group (`CATEGORY_TO_GROUP`). */
  category: DslCategory;
  /**
   * Methods this macro synthesises at runtime (no source `def`): `attr_accessor`
   * → `name`/`name=`, `has_many` → `posts`/`post_ids`, `scope` → the named class
   * method, etc. Consumed by the CODEGRAPH alone (`walker/name-of.ts` → the
   * `cg_symbols` call-graph, so bare calls resolve onto them). The chunker does
   * NOT read this — it represents DSL declarations through category grouping, not
   * per-method chunks. The AST argument extraction that produces `base` lives in
   * `walker/macro-expansion.ts`, not here.
   */
  declares?: (base: string) => DeclaredMethodSpec[];
  /**
   * Only for `alias` / `alias_method`: how the walker locates the redirect
   * target (the OLD method name) to emit a new→old call edge.
   *   - `"second-symbol"`     → `alias_method :new, :old` (second positional symbol)
   *   - `"alias-keyword-old"` → `alias new old` (second identifier child)
   */
  redirectTarget?: "second-symbol" | "alias-keyword-old";
}

/**
 * A per-framework slice of the external vocabulary. Each framework owns its
 * class-body declaring macros (`entries`) AND its non-declaring runtime / kernel
 * helpers (`runtimeBuiltins`) in its own file; `catalogue.ts` composes their
 * `entries` into `RUBY_DSL` and folds `hasExternalMember` into
 * `isExternalBareCall`. Adding a framework = a new module file + one line in
 * `catalogue.ts`'s `FRAMEWORKS`.
 */
export interface RubyFrameworkVocabulary {
  readonly framework: string; // "ruby-core" | "activesupport" | "rails"
  readonly entries: Record<string, RubyDslEntry>;
  /** Non-declaring framework/runtime/kernel helpers (params/render; puts/raise/require). */
  readonly runtimeBuiltins?: ReadonlySet<string>;
  /** Is `member` part of this framework's external-callable surface? */
  hasExternalMember: (member: string) => boolean;
  /** Methods that, on a class-CONSTANT receiver, return an INSTANCE of that
   *  constant (constructor + factory + finder). ruby-core: {new}; rails(AR):
   *  find/create!/build/finders. Consumed by ast-inference constInstanceType. */
  readonly instanceReturning?: ReadonlySet<string>;
  /** AR::Relation-returning query methods (where/order/…) — chaining preserves
   *  element type; a terminal instanceReturning on a relation yields one
   *  instance. Consumed by ast-inference relationRootConst. */
  readonly relationReturning?: ReadonlySet<string>;
}
