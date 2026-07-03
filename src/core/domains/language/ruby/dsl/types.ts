/**
 * Ruby/Rails class-body DSL type contracts. Pure data — no tree-sitter. The
 * per-framework module files (`ruby-core.ts`, `activesupport.ts`, `rails.ts`)
 * each export a `RubyDslModule`; `catalogue.ts` composes them into `RUBY_DSL`.
 */

export type MethodKind = "instance" | "static";

/**
 * Declarative descriptor for `walker/macro-expansion.ts::extractOperands` —
 * names how the walker pulls base symbol names from a macro call's argument
 * list without the walker needing to know the macro's name.
 *
 *  - `'literal-name'`     — first arg, **symbol OR string** literal (define_method)
 *  - `'first-symbol'`     — first namedChild if `simple_symbol`, else `[]`
 *                           (alias_method, scope, attribute)
 *  - `'skip-first'`       — collect all `simple_symbol` args, drop the first
 *                           (store_accessor: first arg is the JSON store column)
 *  - `'leading-symbols'`  — collect all `simple_symbol` args, CONTINUE past
 *                           non-symbols (generic default: attr_*, associations, …)
 *  - object `{ kind: 'leading-symbols', stopAtKwarg: true }` — same as
 *                           `'leading-symbols'` but BREAK at the first non-symbol
 *                           (delegate: the `to:`/`prefix:` pair is a receiver, not
 *                           a name, and everything after it must be ignored)
 */
export type DslOperandsShape =
  | "literal-name"
  | "first-symbol"
  | "skip-first"
  | "leading-symbols"
  | { readonly kind: "leading-symbols"; readonly stopAtKwarg: true };

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

/**
 * Which synthetic call-graph edge(s) a class-body macro emits at walk time,
 * consumed by `walker/walker.ts::emitDslEdges` to pick the edge shape —
 * replacing the four former per-category `if` branches in `collectRubyCalls`.
 * The AST-walking emit loop lives in the WALKER layer; `dsl/` (pure data) only
 * names which shape applies. Each value's shape (built from the call's args):
 *   - `'self-instance'`      — per leading symbol → `{receiver:null, member:sym}`  (before_action :auth)
 *   - `'model-constant-ref'` — associated model  → `{receiver:C, member:C}`        (has_many :posts)
 *   - `'delegate-target'`    — per delegated sym  → `{receiver:to, member:sym}`     (delegate :a, to: :x)
 *   - `'alias-redirect'`     — old method name    → `{receiver:null, member:old}`   (alias_method :new, :old)
 *   - `'policy-dispatch'`    — Pundit policy method → `{receiver:<Record>Policy, member:<query>?}` (authorize :relay, :update?)
 *   - `'route-action'`       — routed controller action → `{receiver:<Ns::>Controller, member:action}` (get "x", to: "posts#index")
 */
export type RubyDslEmits =
  | "self-instance"
  | "model-constant-ref"
  | "delegate-target"
  | "alias-redirect"
  | "policy-dispatch"
  | "route-action";

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
   * Declarative descriptor for `walker/macro-expansion.ts::extractOperands`.
   * Absent → defaults to `'leading-symbols'` (collect all `simple_symbol` args,
   * skip non-symbols). Only set when the macro needs non-default extraction.
   */
  operands?: DslOperandsShape;
  /**
   * Only for `alias` / `alias_method`: how the walker locates the redirect
   * target (the OLD method name) to emit a new→old call edge.
   *   - `"second-symbol"`     → `alias_method :new, :old` (second positional symbol)
   *   - `"alias-keyword-old"` → `alias new old` (second identifier child)
   */
  redirectTarget?: "second-symbol" | "alias-keyword-old";
  /**
   * Which synthetic call-graph edge(s) this class-body macro emits at walk time
   * (see {@link RubyDslEmits}). Absent → the macro emits no synthetic edge. The
   * walker routes edge dispatch through this descriptor (`emitDslEdges`).
   */
  emits?: RubyDslEmits;
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
  /**
   * Gem names whose presence in the project's Gemfile ACTIVATES this vocabulary
   * (bd tea-rags-mcp-adx5p.1 gem-gating). A FAMILY set — any one present is
   * enough (`dry` → {dry-struct, dry-initializer, dry-schema, …}; a project using
   * dry-struct activates the whole dry grammar). Absent ⟺ UNCONDITIONAL: the
   * vocabulary always loads (ruby-core / activesupport / rails — the base stack
   * present in every project). `composeRubyCatalogue(activeGems)` filters on this.
   */
  readonly activatedBy?: ReadonlySet<string>;
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
  /** Background-job CLASS-method enqueue verbs and the INSTANCE entrypoint each
   *  routes to. sidekiq: perform_async/_in/_at/_bulk → "perform"; rails(ActiveJob):
   *  perform_later/_now → "perform". Consumed by enqueueEntrypoint. */
  readonly enqueueDispatch?: Readonly<Record<string, string>>;
}
