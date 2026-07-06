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
 */

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
  definesConcretely(type: string, member: string): boolean;
  /**
   * Concrete types related to `type` through ANY Ruby wiring channel — subclass
   * (`<`), includer (`include`), prepender (`prepend`), extender (`extend`).
   * Their union is the candidate concrete-definer set for the hook.
   */
  relatedConcreteTypes(type: string): readonly string[];
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
