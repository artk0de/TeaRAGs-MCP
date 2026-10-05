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
 *
 * `baseClassFactory` — reading a class base that is a CALL to one of the
 * framework's subclass factories (`BaseManager.from_queryset(QuerySet)`) as the
 * two classes the produced class carries: the receiver it subclasses, then the
 * first argument whose methods it copies. Same claim shape as the facet above —
 * the method name is evidence only because the framework defines it.
 */
export type PythonVocabularyFacet =
  | "classBodyManagerFactory"
  | "baseClassFactory"
  | "modelAttributes"
  | "relationReturning"
  | "instanceReturning"
  | "associationFields"
  | "descriptorDecorators";

/** One attribute a framework synthesizes on every model, and the class it yields. */
export interface PythonFrameworkModelAttribute {
  /**
   * The class, spelled by the MODULE that declares it
   * (`django.db.models.options.Options`), never by its short name — see
   * {@link PythonFrameworkMemberTypes.relationClass}.
   */
  readonly className: string;
  /** Thread the model into `args`, so a later verb can return it. */
  readonly carriesModel: boolean;
  /**
   * The NAME is the framework's alone (bd tea-rags-mcp-m99j1.1.37): no other
   * library spells an attribute this way, so on an owner the fold could NOT
   * type it still yields `className` — with no model in `args`, because the
   * owner is exactly what is unknown. `_meta` qualifies; `objects` never does,
   * since every ORM and half the projects that use one say `objects`. A typed
   * owner ignores the flag: it answers through the model-base gate or not at
   * all.
   */
  readonly nameUniqueToFramework: boolean;
}

/**
 * The member returns a framework SYNTHESIZES — no project line declares them,
 * so no fact channel can answer for them (bd tea-rags-mcp-m99j1.1.21). Read by
 * the resolver's `frameworkReturnType` port, AFTER every declaration on the
 * owner and its ancestors: a declared fact always beats vocabulary.
 *
 * A relation is spelled as the framework's own class carrying the model in
 * `args` (`QuerySet[Book]`), never as a `container`: Python's read side
 * declines containers, and the class name is what the next hop resolves on.
 */
export interface PythonFrameworkMemberTypes {
  /** Bases (by last segment) whose descendants are models: `Model`. */
  readonly modelBases: ReadonlySet<string>;
  /**
   * Attribute → the framework class it yields on a model. `carriesModel`
   * threads the model into `args` so a later verb can return it.
   */
  readonly modelAttributes: ReadonlyMap<string, PythonFrameworkModelAttribute>;
  /** The framework classes the query verbs below are read on. */
  readonly relationClasses: ReadonlySet<string>;
  /**
   * What a `relationReturning` verb yields, carrying the same model — spelled
   * by the MODULE that declares it, as every class an answer names is (bd
   * tea-rags-mcp-m99j1.1.45). The resolver places that spelling the way an
   * absolute import of the module would: a project file only where the corpus
   * IS the framework, external everywhere else. A short name would be placed
   * through the caller's imports instead, which drops the edge where the
   * framework declares two namesakes and lets a project namesake capture it
   * where the corpus merely uses the framework (bd tea-rags-mcp-m99j1.1.40).
   */
  readonly relationClass: string;
  /** Verbs on a relation class that yield another relation of the same model. */
  readonly relationReturning: ReadonlySet<string>;
  /**
   * Verbs on a relation class that yield the receiver ITSELF, same class and
   * same model — `Manager.db_manager(alias)` copies the manager, so the next
   * hop must resolve on the manager it started from. Distinct from
   * `relationReturning`, which always lands on `relationClass`.
   */
  readonly selfReturning: ReadonlySet<string>;
  /** Verbs on a relation class that yield ONE instance of the model. */
  readonly instanceReturning: ReadonlySet<string>;
  /** Field constructors whose attribute holds an instance of their FIRST argument. */
  readonly associationFields: ReadonlySet<string>;
}

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
  /** Synthesized member returns, when the framework has any. */
  readonly memberTypes?: PythonFrameworkMemberTypes;
  /**
   * Decorators turning a def into an attribute holding its return, spelled by
   * the QUALIFIED name the decorator's import binds (`werkzeug.utils.cached_property`),
   * so a project's own namesake never matches. Read by the walker's descriptor
   * pass under the `descriptorDecorators` facet; the language's own set lives in
   * `vocabulary/descriptors.ts`.
   */
  readonly descriptorDecorators?: ReadonlySet<string>;
  /**
   * Classmethod names whose call, written as a class base, produces a subclass
   * of the RECEIVER that also carries the FIRST ARGUMENT's methods
   * (`BaseManager.from_queryset(QuerySet)`). The walker records the two as the
   * class's bases, receiver first, under the `baseClassFactory` facet.
   */
  readonly baseClassFactories?: ReadonlySet<string>;
}

/** Build a vocabulary. A factory, not a container — each module calls it with
 *  its own data, so the storage shape is stated once. */
export function definePythonFrameworkVocabulary(
  framework: string,
  facets: readonly PythonVocabularyFacet[],
  activatedBy?: readonly string[],
  memberTypes?: PythonFrameworkMemberTypes,
  descriptorDecorators?: readonly string[],
  baseClassFactories?: readonly string[],
): PythonFrameworkVocabulary {
  return {
    framework,
    facets: new Set(facets),
    ...(activatedBy === undefined ? {} : { activatedBy: new Set(activatedBy) }),
    ...(memberTypes === undefined ? {} : { memberTypes }),
    ...(descriptorDecorators === undefined ? {} : { descriptorDecorators: new Set(descriptorDecorators) }),
    ...(baseClassFactories === undefined ? {} : { baseClassFactories: new Set(baseClassFactories) }),
  };
}
