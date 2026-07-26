/**
 * Interprocedural discovery of **self-dispatch templates** (bd tea-rags-mcp-dt9l3,
 * DEFECT 2a). Spec: docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md.
 *
 * A method `M` in type `A` is a self-dispatch template when its body reaches a
 * hook `H` on `self` — a bare implicit-self call (`H`), `self.H`, or a
 * class-method template that instantiates self and dispatches (`self.new.H` /
 * `self.class.new.H`), all normalized to the bare member `H` by the caller —
 * where `A` does NOT concretely define `H` but a related concrete type (subclass
 * / includer / prepender / extender) DOES.
 *
 * The entry-anchored resolver (2c) uses the resulting `templateSymbolId → H` map:
 * at a call site `Const.member` that resolves to a template `M`, the concrete
 * constant `Const` narrows `H` to exactly `Const#H` — no fan-out, no cone. The
 * pattern the shared template collapses (200 includers) is an artefact of
 * resolving where `self` is abstract; resolving at the concrete entry is 1-to-1.
 *
 * This function is PURE over an injected {@link SelfDispatchProbe} so it is
 * unit-testable free of provider / symbol-table internals; the provider supplies
 * the probe (concrete-definition + wiring-channel lookups) and the method view.
 *
 * The provider-facing adapters below (`extractSelfDispatchMethods`,
 * `buildSelfDispatchProbe`, `foldSelfDispatchTemplates`) build the discovery's
 * inputs/output from the two-pass extraction so the risky glue (self-call
 * filtering, FQ-matched concrete-definition lookup, multi-hook fold) stays pure
 * and unit-testable — the provider only sequences them at the pass-1→pass-2
 * barrier.
 */

import type {
  ChunkExtraction,
  GlobalSymbolTable,
  HierarchyView,
  InheritanceKind,
} from "../../../../contracts/types/codegraph.js";

/** One method's self-reach: the members it invokes on `self`, normalized to bare names. */
export interface SelfDispatchMethod {
  /** symbolId of the method, e.g. `KindOfService#call` or `BaseProcessor.process_result`. */
  readonly symbolId: string;
  /** the enclosing type FQ, e.g. `KindOfService`. */
  readonly enclosingType: string;
  /** members this method invokes on `self` (bare / `self.X` / `self.new.X`), bare-normalized. */
  readonly selfHookCandidates: readonly string[];
}

/** Structural lookups the discovery folds over — supplied by the provider. */
export interface SelfDispatchProbe {
  /**
   * Does `type` **concretely** define `member` — a real body, NOT an abstract
   * stub? A `raise NotImplementedError` / empty / bare-`super` stub counts as
   * NOT concretely defined (so the template's hook is still abstract-in-A and the
   * terminal is a REDIRECT from the stub to the concrete override).
   */
  definesConcretely: (type: string, member: string) => boolean;
  /**
   * Concrete types related to `type` through ANY Ruby wiring channel — subclass
   * (`<`), includer (`include`), prepender (`prepend`), extender (`extend`).
   * Their union is the candidate concrete-definer set for the hook.
   */
  relatedConcreteTypes: (type: string) => readonly string[];
}

/** A discovered self-dispatch template: `templateSymbolId` reaches abstract `hook` on self. */
export interface SelfDispatchTemplate {
  readonly templateSymbolId: string;
  readonly enclosingType: string;
  readonly hook: string;
}

/**
 * Fold the structural predicate over every method × self-hook-candidate. Emits one
 * {@link SelfDispatchTemplate} per (method, hook) where the hook is abstract in the
 * enclosing type yet concretely defined by a related concrete type.
 */
export function discoverSelfDispatchTemplates(
  methods: readonly SelfDispatchMethod[],
  probe: SelfDispatchProbe,
): SelfDispatchTemplate[] {
  const templates: SelfDispatchTemplate[] = [];
  for (const method of methods) {
    for (const hook of method.selfHookCandidates) {
      // Abstract-in-A: the enclosing type must NOT concretely define the hook.
      if (probe.definesConcretely(method.enclosingType, hook)) continue;
      // Concrete-in-subtypes: at least one related concrete type must define it —
      // else it is a genuine miss (gem/core/typo), not a template hook.
      const definedByRelated = probe
        .relatedConcreteTypes(method.enclosingType)
        .some((related) => probe.definesConcretely(related, hook));
      if (definedByRelated) {
        templates.push({ templateSymbolId: method.symbolId, enclosingType: method.enclosingType, hook });
      }
    }
  }
  return templates;
}

// ── Provider-facing pure adapters (slice 2d) ──────────────────────────────────

/** The four Ruby wiring channels a template relates to its concrete definers through. */
const SELF_DISPATCH_CHANNELS: readonly InheritanceKind[] = ["super", "include", "extend", "prepend"];

/**
 * A self-shaped receiver — the hook is invoked on `self` or a fresh instance of
 * self's class:
 *   - implicit self: a bare call (`H` → `null`) or explicit `self.H` (`"self"`);
 *   - self-instantiation: implicit `new.H` / `new(args).H` (the Ruby walker emits
 *     the receiver text `"new"` / `"new(...)"` for an implicit-self `new`), or
 *     explicit `self.new.H` / `self.class.new.H` (with optional args).
 * The Ruby walker keeps these verbatim on the normal method-call path;
 * normalizing to the bare hook member happens here, provider-side. A deeper chain
 * off `new` (`new.foo.H`) is out of scope (single-hop only, v1).
 */
function isSelfReceiver(receiver: string | null): boolean {
  if (receiver === null || receiver === "self") return true;
  return (
    receiver === "new" ||
    receiver.startsWith("new(") ||
    receiver === "self.new" ||
    receiver.startsWith("self.new(") ||
    receiver === "self.class.new" ||
    receiver.startsWith("self.class.new(")
  );
}

/**
 * A method-shaped symbolId (`Type#m` / `Type.m` / `Ns::Type.m`). Excludes
 * type-body chunks (`Type` / `Ns::Type`) whose bare calls are DSL macros, not
 * self-dispatch templates — `::` is the namespace separator, so only `#` / `.`
 * denote a method.
 */
function isMethodSymbolId(symbolId: string): boolean {
  return symbolId.includes("#") || symbolId.includes(".");
}

/**
 * Per-method self-dispatch candidates from a file's method chunks: each method
 * that self-calls (`H` / `self.H` / `self.new.H` / `self.class.new.H`) one or
 * more members, deduped and normalized to bare names. Type-body chunks are
 * skipped (only methods can be templates). `enclosingType` is the chunk's lexical
 * scope joined — the FQ of the declaring class/module.
 */
export function extractSelfDispatchMethods(chunks: readonly ChunkExtraction[]): SelfDispatchMethod[] {
  const methods: SelfDispatchMethod[] = [];
  for (const chunk of chunks) {
    if (!isMethodSymbolId(chunk.symbolId)) continue;
    const hooks = new Set<string>();
    for (const call of chunk.calls) {
      if (isSelfReceiver(call.receiver)) hooks.add(call.member);
    }
    if (hooks.size > 0) {
      methods.push({ symbolId: chunk.symbolId, enclosingType: chunk.scope.join("::"), selfHookCandidates: [...hooks] });
    }
  }
  return methods;
}

/**
 * Build the structural {@link SelfDispatchProbe} the discovery folds over:
 *
 *   - `definesConcretely(type, member)` — the symbol table holds a method-level
 *     def of `member` whose enclosing type matches `type` by scope tail (FQ or
 *     bare last segment — the resolver's own type-match convention, mirroring
 *     `resolveTypeMethodInternal`) AND that def is not an abstract STUB. The
 *     walker marks stubs (`SymbolDefinition.isAbstractStub`, bd
 *     tea-rags-mcp-bcdfe) for exactly three shapes — empty body, single
 *     `raise NotImplementedError`, single `super` — so both terminals are
 *     covered: an ABSENT hook (CREATE, the dominant service-object shape) and a
 *     hook DECLARED as a stub in the template's own type (REDIRECT). The same
 *     rule applies to the related types, so a subtype whose override is itself a
 *     stub does not count as a concrete definer.
 *
 *     One caveat, by design: the flag lives on the in-memory symbol table and is
 *     NOT persisted in `cg_symbols`, so a def hydrated from disk (an unchanged
 *     file during an incremental run) reads as non-stub. That degrades discovery
 *     to the pre-flag behaviour for those files — under-coverage, never a wrong
 *     target.
 *   - `relatedConcreteTypes(type)` — the transitive descendants across all four
 *     wiring channels (`super`/`include`/`extend`/`prepend`) from the hierarchy
 *     view. Empty when no hierarchy is present.
 */
export function buildSelfDispatchProbe(
  symbolTable: GlobalSymbolTable,
  hierarchy: HierarchyView | undefined,
): SelfDispatchProbe {
  // Memoize the transitive descendant walk per enclosing type: the discovery
  // fold calls `relatedConcreteTypes(enclosingType)` once per (method, hook), so
  // a type is re-walked for every hook of every method sharing it — on deep/wide
  // Rails concern hierarchies that transitive `getDescendants` dominates the
  // barrier. The hierarchy view is immutable for the whole discovery pass, so the
  // per-type result is stable → memoizing is behavior-preserving (same set, and
  // the fold only `.some()`s over it, order-independent).
  const relatedCache = new Map<string, readonly string[]>();
  return {
    definesConcretely(type, member) {
      const bare = type.split("::").pop();
      return symbolTable.lookupByShortName(member).some((def) => {
        // A stub DECLARES the member without implementing it — the hook stays
        // abstract in this type (bd tea-rags-mcp-bcdfe).
        if (def.isAbstractStub === true) return false;
        const tail = def.scope[def.scope.length - 1];
        return tail === type || tail === bare;
      });
    },
    relatedConcreteTypes(type) {
      if (hierarchy === undefined) return [];
      const cached = relatedCache.get(type);
      if (cached !== undefined) return cached;
      const related = hierarchy
        .getDescendants(type, { kinds: SELF_DISPATCH_CHANNELS, transitive: true })
        .map((edge) => edge.sourceFqName);
      relatedCache.set(type, related);
      return related;
    },
  };
}

/**
 * Fold discovered templates into the run-global `templateSymbolId → hook` map for
 * `CallContext.selfDispatchTemplates`. Single-hook only: a template that reaches
 * MULTIPLE distinct hooks is a genuine fan-out (one entry call invokes both
 * hooks) that the single-target entry strategy cannot express, so it is EXCLUDED
 * here (deferred to the fan-out follow-up) rather than silently truncated to one
 * hook. The exclusion is intentional and tested — never a silent cap.
 */
export function foldSelfDispatchTemplates(templates: readonly SelfDispatchTemplate[]): Record<string, string> {
  const hooksBySymbol = new Map<string, Set<string>>();
  for (const t of templates) {
    const set = hooksBySymbol.get(t.templateSymbolId) ?? new Set<string>();
    set.add(t.hook);
    hooksBySymbol.set(t.templateSymbolId, set);
  }
  const map: Record<string, string> = {};
  for (const [symbolId, hooks] of hooksBySymbol) {
    if (hooks.size === 1) map[symbolId] = [...hooks][0];
  }
  return map;
}

/**
 * The DELEGATING half of the `self.call → new.call` service idiom (DEFECT 2 v2):
 * the class-form methods that self-INSTANTIATE (invoke `new` on self). The real
 * KindOfService service entry is two hops — a CLASS method `self.call` that does
 * `instance = new(*args); instance.call` and delegates to the SAME-named INSTANCE
 * method, where that instance method is the actual self-dispatch template (its
 * bare `perform` self-call is captured; the `instance.call` delegation is on a
 * local var, so the class method's ONLY self-hook is `new`). Such a class method
 * is therefore NOT itself a template — but it bridges the entry constant to the
 * instance template, so the entry strategy's v2 branch needs to recognise it.
 *
 * A method qualifies iff its symbolId is CLASS-form (`Type.m` / `Ns::Type.m`,
 * i.e. contains `.` but not `#`) AND it self-instantiates (`new` ∈
 * `selfHookCandidates`). Returns the list of such class-method symbolIds, built
 * at the pass-1→pass-2 barrier from the same `SelfDispatchMethod[]` the template
 * discovery folds over.
 */
export function collectSelfInstantiatingClassMethods(methods: readonly SelfDispatchMethod[]): string[] {
  const result: string[] = [];
  for (const method of methods) {
    const isClassForm = method.symbolId.includes(".") && !method.symbolId.includes("#");
    if (isClassForm && method.selfHookCandidates.includes("new")) result.push(method.symbolId);
  }
  return result;
}
