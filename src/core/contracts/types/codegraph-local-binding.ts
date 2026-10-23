/**
 * Flow-sensitive local-variable typing — one position-aware binding
 * (`LocalBinding`) plus the two lookups that read a variable's most-recent
 * binding at a call's line. Carried on `ChunkExtraction.localBindings` at
 * extraction time and on `CallContext.localBindings` at resolve time, which is
 * why it sits below both rather than inside either.
 *
 * The lookups live here, not in each language's resolver, so "most recent
 * binding at or before this line" is defined exactly once. Re-exported verbatim
 * by the `codegraph.ts` barrel.
 */

import { identifierEntry } from "../identifier-record.js";
import type { RubyTypeRef } from "./language.js";

/**
 * A single position-aware local-variable type binding: the variable's inferred
 * receiver type, tagged with the 1-based source line where the binding is
 * established. A variable accumulates an array of these (one per assignment /
 * annotation on its path); a call site resolves against the most-recent binding
 * at or before its own line via {@link resolveLocalBindingType}. This makes
 * `var.method()` resolution flow-sensitive — a reassignment to a different type
 * is the correct answer per call site, not a conflict.
 */
export interface LocalBinding {
  /** 1-based source line where this binding is established. */
  line: number;
  /** Inferred receiver type (class / constant name), e.g. "User" or "Acme::Post". */
  type: string;
  /**
   * Whether `type` is held as a CLASS (`var = User` → `var.find` resolves
   * `User.find`, a static method) or an INSTANCE (default; `var = User.new` →
   * `var.save` resolves `User#save`). Absent ⇒ `"instance"` so every existing
   * binding and every other language is unaffected (bd Increment B / var=CONST).
   *
   * `"iterationElement"` (bd tea-rags-mcp-m99j1.1.18): the variable is an
   * ELEMENT drawn from the iterable {@link LocalBinding.sourceExpression}
   * spells — a `for x in <expr>` target or a comprehension's — whose type
   * only the resolver can read, because the iterable's container type lives
   * in facts a per-file pass does not see. `type` is `""` on such a binding:
   * it names no type until the language's resolver folds the expression, and
   * a reader that does not know this kind sees an empty (falsy) type rather
   * than an expression masquerading as a class name.
   *
   * Two more DERIVED kinds share that contract (`type` is `""`, the
   * expression rides {@link LocalBinding.sourceExpression}), each folded by a
   * resolver path of its own (bd tea-rags-mcp-m99j1.1.18, Task 16b):
   *
   *   - `"contextEnter"` — a `with <expr> as name` target: what the context
   *     value's `__enter__` returns, not the value itself;
   *   - `"tupleElement"` — an unpacking target (`a, b = <expr>`): the value
   *     `<expr>` evaluates to, at {@link LocalBinding.tupleIndex} when set;
   *   - `"assignedValue"` (bd tea-rags-mcp-m99j1.1.91) — a plain assignment
   *     target (`name = <expr>`) whose value no per-file pass can type: the
   *     whole value `<expr>` evaluates to. Python records it for an attribute
   *     read or another name (`opts = self.model._meta`, `app = ctx.app`),
   *     scoped by {@link LocalBinding.scopeEndLine} to the line the def
   *     rebinds the name.
   *   - `"patternProjection"` (bd tea-rags-mcp-s3i8m, Task 1a) — a name a Rust
   *     pattern binds (`if let` / `while let` / match arm / `for` / closure
   *     parameter / destructuring `let`): the value reached by walking
   *     {@link LocalBinding.projection} into `<expr>`. With no projection the
   *     binding still SHADOWS the name for its scope, typed as nothing.
   *
   * {@link isDerivedLocalBinding} names the five.
   */
  valueKind?: "instance" | "class" | DerivedLocalBindingKind;
  /**
   * The expression a derived binding is drawn from, as written (whitespace
   * runs collapsed) — set only on a derived binding: the ITERATED expression
   * (`self.app_configs.values()`, `enumerate(ops)`), the CONTEXT expression
   * (`Lock()`), or the UNPACKED one (`make_pair()`). ABSENT on every other
   * binding.
   */
  sourceExpression?: string;
  /**
   * 0-based position inside a TUPLE-shaped value the binding destructures —
   * `for i, op in enumerate(ops)` binds `op` at index 1 of each element,
   * `a, b = make_pair()` binds `b` at index 1 of the value.
   * ABSENT when the binding takes the whole value.
   */
  tupleIndex?: number;
  /**
   * Richer receiver type when the bare `type` string can't represent it (union /
   * container); engine prefers `typeRef` when present. Added by INFRA-A so
   * union (`[A,B]`) and container (`Array<Post>`) receiver types ride the
   * EXISTING localBindings channel to the propagation engine at resolve time.
   * Absent for plain class/instance bindings (the string `type` is sufficient).
   */
  typeRef?: RubyTypeRef;
  /**
   * 1-based last line of the STATEMENT that establishes this binding — `line`
   * for a single-line one, the closing line of a multi-line right-hand side
   * otherwise (bd tea-rags-mcp-w205u, E4.6a).
   *
   * Python evaluates a right-hand side BEFORE it rebinds the name, so inside
   * `line..endLine` the variable still denotes whatever it denoted above the
   * statement. netbox's `layout = layout.Layout(\n    layout.Row(…))` is that
   * shape: the inner receivers name the imported MODULE, not the class being
   * constructed. Only a consumer that knows the extent can say so. Go's
   * walker sets it on a local a statement declares when that statement's
   * right-hand side names it (Go scopes the local from the statement's END; a
   * right-hand side that cannot refer to it leaves the local visible from its
   * line, which an `if e := New(); e.Ok() {` header needs), and Go reads it
   * through `goLocalBindingAt`.
   *
   * ABSENT means "unknown, treat as `line`" — every index written before this
   * field existed, and every binding that is not an establishing statement
   * (a `def` parameter hint records none).
   */
  endLine?: number;
  /**
   * 1-based LAST line the binding is visible on — for a binding scoped to a
   * block narrower than the chunk (bd tea-rags-mcp-e6xx: a Go function
   * literal's parameter, which shadows its name for the literal's lines only).
   * Past it the lookups skip the binding, so the name denotes whatever it
   * denoted before the block, or nothing.
   *
   * Not {@link LocalBinding.endLine}, which is where the ESTABLISHING statement
   * ends. ABSENT means visible to the end of the chunk — every binding every
   * other language records.
   */
  scopeEndLine?: number;
  /**
   * Where the CONDITION of a modifier guarding the establishing statement sits
   * (bd tea-rags-mcp-0qaht.55): `record = Status.new unless record.present?`.
   * Ruby evaluates the condition BEFORE the assignment, so a call positioned
   * inside this span still reads whatever the name denoted above the
   * statement — {@link resolveLocalBinding} skips the binding for it when the
   * call's column is known. ABSENT means no such modifier, or a walker that
   * does not record one.
   */
  conditionSpan?: ModifierConditionSpan;
  /**
   * The path from the value {@link LocalBinding.sourceExpression} evaluates to
   * down to the bound name — set only on a `"patternProjection"` binding whose
   * pattern the walker can unfold (bd tea-rags-mcp-s3i8m, Task 1a). `[]` binds
   * the whole value (`p @ Some(_)`). ABSENT on a shape no projection
   * describes (a callback parameter, disagreeing or-pattern arms, a slice):
   * the name is then untyped, never the outer binding's.
   */
  projection?: readonly PatternStep[];
  /**
   * The exact source region the binding is visible in, when narrower than its
   * lines (bd tea-rags-mcp-s3i8m, Task 1a): a Rust closure parameter is
   * visible inside the closure body only, so `x.map(|w| w.id()) == Some(w.id())`
   * reads the OUTER `w` after the closure on the same line. A call whose column
   * is known and falls outside the span skips the binding; a call without a
   * column falls back to {@link LocalBinding.scopeEndLine}. ABSENT on every
   * binding scoped by lines alone.
   */
  visibleSpan?: ModifierConditionSpan;
  /**
   * The inferred shape that typed this binding, when the walker read its type
   * off a shape whose typing must stay ADDITIVE (src/core/domains/language/CLAUDE.md):
   * where the spelled type does not place, the resolver reads the call as if
   * the binding did not exist. ABSENT on a declared, annotated or
   * associated-constructor binding — those read as they always did.
   */
  inferenceShape?: InferredBindingShape;
}

/**
 * One step of a {@link LocalBinding.projection}, outermost first:
 *
 *   - `variant` — the payload of the enum variant `path` (`Some`, `Self::A`)
 *     at position `index` (tuple variant) or named `field` (struct variant);
 *   - `tuple` — the element at `index` of a tuple value;
 *   - `field` — the named field of a struct value;
 *   - `element` — one element the iterable value yields (`for`);
 *   - `adapterParam` — parameter `index` of the closure passed as argument
 *     `argument` to the method `adapter` called on the value
 *     (`iter.map(|p| …)` → argument 0, index 0; `iter.fold(init, |acc, x| …)`
 *     binds `x` at argument 1, index 1).
 */
export type PatternStep =
  | { readonly kind: "variant"; readonly path: string; readonly index: number }
  | { readonly kind: "variant"; readonly path: string; readonly field: string }
  | { readonly kind: "tuple"; readonly index: number }
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "element" }
  | { readonly kind: "adapterParam"; readonly adapter: string; readonly argument: number; readonly index: number };

/**
 * The `LocalBinding`s that are EXACT constructions, per local name: the 1-based
 * `line` of each binding whose value is a direct construction of its `type`
 * (Ruby `x = X.new(…)`, TypeScript `const x = new X(…)`) and which is the
 * name's only binding in its scope — no second assignment, parameter,
 * memoization or loop target (bd tea-rags-mcp-0qaht.66). Such a local's runtime
 * class is `type` itself, never a subtype. A binding whose line is absent here
 * is only a static bound (declared, annotated, inferred from a finder, copied)
 * and may hold any subtype.
 *
 * A channel beside `localBindings` rather than a field on the binding, so every
 * binding a walker records keeps its shape.
 */
export type ConstructedLocalLines = Record<string, number[]>;

/**
 * Whether `binding`, the binding `varName` resolved to, is an exact
 * construction per {@link ConstructedLocalLines}.
 */
export function isConstructedLocalBinding(
  constructedLocals: ConstructedLocalLines | undefined,
  varName: string,
  binding: LocalBinding,
): boolean {
  return identifierEntry(constructedLocals, varName)?.includes(binding.line) ?? false;
}

/**
 * A source span of a modifier's condition (bd tea-rags-mcp-0qaht.55): lines
 * 1-based, columns 0-based, the end column EXCLUSIVE — tree-sitter's
 * positions, lines shifted to the codegraph's 1-based convention. When
 * modifiers nest (`x = a if b unless c`) the span runs from the innermost
 * condition to the outermost one, since every condition runs before the
 * assignment.
 */
export interface ModifierConditionSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * Whether the position `line`/`column` lies inside `span` — the test for "this
 * call runs before the binding the span guards". An absent `column` (or span)
 * is never inside: the reader cannot place the call, so it reads as before.
 */
export function isInsideModifierCondition(
  span: ModifierConditionSpan | undefined,
  line: number,
  column: number | undefined,
): boolean {
  if (span === undefined || column === undefined) return false;
  const afterStart = line > span.startLine || (line === span.startLine && column >= span.startColumn);
  const beforeEnd = line < span.endLine || (line === span.endLine && column < span.endColumn);
  return afterStart && beforeEnd;
}

/**
 * Resolve the most-recent local binding for `varName` at or before `atLine`
 * (the binding with the greatest `line <= atLine`). Returns undefined when the
 * variable has no binding established on or before that line — the resolver then
 * falls through (no local type), preserving the DROP-not-guess discipline.
 *
 * Shared by every language's local-binding resolver AND the language-neutral
 * cone dispatcher so the position-aware lookup is defined exactly once. `<=`
 * (not `<`): a variable's own calls are always on a strictly later line than its
 * binding statement, so `<=` is safe and tolerant of the rare same-line case.
 */
export function resolveLocalBindingType(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
  atColumn?: number,
): string | undefined {
  return resolveLocalBinding(bindings, varName, atLine, atColumn)?.type;
}

/**
 * Resolve the most-recent `LocalBinding` for `varName` at or before `atLine`,
 * returning the full binding (so callers can inspect `valueKind` and other
 * fields). Returns `undefined` when no binding is established on or before that
 * line. Position-aware lookup shared with `resolveLocalBindingType`.
 *
 * `atColumn` (0-based, the call's own column) places the call INSIDE a line: a
 * binding whose {@link LocalBinding.conditionSpan} contains the position is
 * skipped, so a modifier's condition reads exactly what it would read were the
 * guarded statement absent (bd tea-rags-mcp-0qaht.55). Omitted, every binding
 * reads as before.
 */
export function resolveLocalBinding(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
  atColumn?: number,
): LocalBinding | undefined {
  const list = identifierEntry(bindings, varName);
  if (!list || list.length === 0) return undefined;
  let best: LocalBinding | undefined;
  for (const binding of list) {
    // Out of its block's scope (bd tea-rags-mcp-e6xx) — `scopeEndLine` is
    // absent on every binding not scoped narrower than the chunk.
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < atLine) continue;
    if (binding.line > atLine) continue;
    if (isInsideModifierCondition(binding.conditionSpan, atLine, atColumn)) continue;
    if (binding.visibleSpan !== undefined && atColumn !== undefined) {
      if (!isInsideModifierCondition(binding.visibleSpan, atLine, atColumn)) continue;
    }
    if (best === undefined || binding.line > best.line || outranksOnSameLine(binding, best)) best = binding;
  }
  return best;
}

/**
 * An inferred binding shape whose typing is additive over the untyped read
 * (Rust walker): an enum variant constructor (`let d = Res::Ok(x)`), agreeing
 * `if` / `match` / block arms, a `*self` copy in an impl, and a call-result
 * `let` kept through reassignment.
 */
export type InferredBindingShape = "variantConstructor" | "initializerArms" | "selfCopy" | "reassignedLet";

/** The {@link LocalBinding.valueKind}s whose type only a resolver can fold out of `sourceExpression`. */
export type DerivedLocalBindingKind =
  | "iterationElement"
  | "contextEnter"
  | "tupleElement"
  | "assignedValue"
  | "patternProjection";

/**
 * Whether `binding` is DERIVED — it names an expression for the resolver to
 * fold, not a type (`type` is `""`). A reader that does not fold it must treat
 * the name as untyped, never fall back to a binding from above it.
 */
export function isDerivedLocalBinding(
  binding: LocalBinding | undefined,
): binding is LocalBinding & { valueKind: DerivedLocalBindingKind } {
  const kind = binding?.valueKind;
  return (
    kind === "iterationElement" ||
    kind === "contextEnter" ||
    kind === "tupleElement" ||
    kind === "assignedValue" ||
    kind === "patternProjection"
  );
}

/**
 * On ONE line, a binding that names a type outranks a derived binding, which
 * names only an expression (bd tea-rags-mcp-m99j1.1.18): a language may type a
 * loop or unpacking target at extraction time AND record the expression for
 * the resolver, and the read type is the stronger evidence. Every other tie
 * keeps the first binding, as before.
 */
function outranksOnSameLine(binding: LocalBinding, best: LocalBinding): boolean {
  return binding.line === best.line && isDerivedLocalBinding(best) && !isDerivedLocalBinding(binding);
}

/**
 * A local bound to the RESULT of a call, recorded as the callee SPELLING
 * because its type is not knowable in a per-file pass (bd tea-rags-mcp-z68v9).
 *
 * `repository = SubscriptionRepository.from_session(session)` types
 * `repository` as whatever `from_session` returns — a fact that lives in
 * ANOTHER file's `structuredReturnTypes` and on a class the caller reaches only
 * through the MRO. The walker therefore records
 * `callee: "SubscriptionRepository.from_session"` and the resolver folds it
 * once, at the one layer where the whole symbol table is in scope.
 *
 * Distinct from `localCallBindings` (`Record<string, string>`, bd
 * tea-rags-mcp-6g9c), which Go and Ruby pair with the bare-name-keyed
 * `functionReturnTypes` channel. Python DROPS that channel (one
 * `def get(self) -> Foo` would speak for every `get` in the corpus), so a
 * Python fold needs the whole callee expression, not a short name — hence a
 * second channel rather than a widening of the first.
 */
export interface CallResultBinding {
  /** 1-based line of the assignment. */
  readonly line: number;
  /** The callee as written, arguments stripped: `Repo.from_session`, `self.factory.build`, `make`. */
  readonly callee: string;
  /**
   * 1-based last line of the assigning statement — {@link LocalBinding.endLine}'s
   * meaning. Go's walker sets it (bd tea-rags-mcp-e6xx) when the right-hand
   * side names the declared identifier: a Go local is in scope only after its
   * declaring statement, so `config := config.Load()` still calls the package
   * on its own right-hand side. ABSENT (every Python binding, and a Go one
   * whose right-hand side cannot refer to it) means "treat as `line`".
   */
  readonly endLine?: number;
  /**
   * 1-based last line the binding is visible on — {@link LocalBinding.scopeEndLine}'s
   * meaning: set by Go's walker for a local declared in a block narrower than
   * the chunk. ABSENT means visible to the end of the chunk.
   */
  readonly scopeEndLine?: number;
  /**
   * Set when the binding is NOT the call's result but the 0-based N-th
   * parameter of a closure passed to `callee` (bd tea-rags-mcp-y99pg.13):
   * `state.write { state in … }` binds `state` to parameter 0 of the closure
   * `write` declares, whose type only the callee's declaration — often in
   * another file — says. Visible from its own line, since a closure's
   * parameters are in scope on the line that opens it. ABSENT on every
   * call-result binding.
   */
  readonly closureParameter?: number;
  /**
   * Set when the binding exists only through an inferred shape (a `let` whose
   * `if` / `match` arms agree on a constructor, or a `let` kept through a
   * later reassignment) that a reader must treat as ADDITIVE: where the
   * binding's value cannot be typed, the name reads as if the walker had
   * declined it. ABSENT on every plain call-result `let`.
   */
  readonly inferenceShape?: InferredBindingShape;
  /**
   * Set when the binding is the `index`-th payload slot of enum case
   * `caseName`, destructured from the value `callee` spells — the switch
   * SUBJECT rather than a callee (bd tea-rags-mcp-y99pg.16):
   * `switch unit { case .group(let g): … }` binds `g` to what the enum of
   * `unit`'s type declares `group` to carry. ABSENT on every other binding.
   */
  readonly enumPayload?: { readonly caseName: string; readonly index: number };
  /**
   * Set when the binding is an ELEMENT drawn from the sequence `callee`
   * spells rather than the value itself — a `for item in items` loop over a
   * local only the resolver can type (bd tea-rags-mcp-y99pg.37). Which type a
   * sequence yields as its element is the language's rule. ABSENT on every
   * other binding.
   */
  readonly sequenceElement?: true;
  /**
   * Set when the value the right-hand side produces is an OPTIONAL although
   * `callee` spells no sugar — the chain was optional-chained or the call
   * `try?`'d (bd tea-rags-mcp-y99pg.39). A reader that distinguishes
   * `Optional`'s own members from the wrapped type's needs it; one that reads
   * an optional as what it wraps may ignore it. ABSENT means no such marker
   * was seen, not that the value is proven non-optional.
   */
  readonly optional?: true;
  /**
   * The whole right-hand side, whitespace-collapsed, with a leading `&` /
   * `&mut` / parens stripped — `make()?`, `B::new().build(x).unwrap()` (bd
   * tea-rags-mcp-2g2og.24). Set by the Rust walker so a resolver can fold an
   * init `callee` cannot spell; ABSENT for every other language.
   */
  readonly initExpression?: string;
  /**
   * {@link LocalBinding.conditionSpan}'s meaning: the condition of a modifier
   * guarding the assignment, which runs before it (bd tea-rags-mcp-0qaht.55).
   * Set by the Ruby walker. ABSENT means no such modifier.
   */
  readonly conditionSpan?: ModifierConditionSpan;
}

/**
 * The most-recent {@link CallResultBinding} for `varName` at or before
 * `atLine` — the LAST entry whose `line <= atLine`, `undefined` when none.
 *
 * The rule is {@link resolveLocalBinding}'s verbatim, and it lives beside it so
 * the two position lookups cannot drift: a call site reads whichever binding
 * was established most recently above it, and a later reassignment shadows an
 * earlier one for every call below it.
 */
export function nearestCallResultBinding(
  bindings: Record<string, CallResultBinding[]> | undefined,
  varName: string,
  atLine: number,
): CallResultBinding | undefined {
  const list = identifierEntry(bindings, varName);
  if (!list || list.length === 0) return undefined;
  let best: CallResultBinding | undefined;
  for (const binding of list) {
    if (binding.line <= atLine && (best === undefined || binding.line > best.line)) best = binding;
  }
  return best;
}
