/**
 * The shape of one Python framework vocabulary (bd tea-rags-mcp-w205u.1).
 *
 * Mirrors `ruby/dsl/types.ts` in the one respect that matters: activation is
 * DATA on the module, never a branch at the consumer. A vocabulary declares the
 * distributions that switch it on and the extraction facets it contributes, and
 * the next arm costs a new module plus one line in the registry.
 */

/**
 * An extraction behaviour a framework vocabulary can switch on.
 *
 * `classBodyManagerFactory` — reading `objects = SomeQuerySet.as_manager()` in a
 * class body as a field of type `SomeQuerySet`. `as_manager` is Django's OWN
 * verb: the name in front of it is evidence only because Django says that
 * classmethod exposes the queryset's members, so outside Django the dotted call
 * means nothing and the fact must not be emitted.
 *
 * Deliberately NOT the whole class-body pass. The BARE form
 * (`objects = SomeManager()`, where the name is a class the file declares or an
 * import bound) rests on project-class evidence alone, with no framework in it,
 * and gating it on Django cost polar 8 real edges when measured — so it stays
 * language-level, exactly as `python-class-body-fields.ts` was written.
 */
export type PythonVocabularyFacet = "classBodyManagerFactory";

export interface PythonFrameworkVocabulary {
  readonly framework: string;
  /**
   * The PEP 503-normalized distributions that activate this vocabulary, matched
   * EXACTLY against the project's declared set — `django-filter` is a different
   * distribution from `django`. A family rather than a single name because one
   * grammar can arrive under several distributions.
   *
   * `undefined` means UNCONDITIONAL: the vocabulary is part of the language and
   * no manifest can gate it off.
   */
  readonly activatedBy?: ReadonlySet<string>;
  readonly facets: ReadonlySet<PythonVocabularyFacet>;
}

/** Build a vocabulary. A factory, not a container — each module calls it with
 *  its own data, so the storage shape is stated once. */
export function definePythonFrameworkVocabulary(
  framework: string,
  facets: readonly PythonVocabularyFacet[],
  activatedBy?: readonly string[],
): PythonFrameworkVocabulary {
  return {
    framework,
    facets: new Set(facets),
    ...(activatedBy === undefined ? {} : { activatedBy: new Set(activatedBy) }),
  };
}
