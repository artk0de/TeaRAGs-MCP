/**
 * Django's vocabulary (bd tea-rags-mcp-w205u.1).
 *
 * The synthesized model members and query verbs (`memberTypes`, bd
 * tea-rags-mcp-m99j1.1.21) are answered by the resolver's `frameworkReturnType`
 * port. `associationFields` is read by the walker's class-body pass, which owns
 * reading a field's constructor argument (bd tea-rags-mcp-m99j1.1.51):
 * `author = ForeignKey(Author)` types `book.author` as `Author`.
 * `ManyToManyField` is absent on purpose — its attribute is a related manager,
 * not the model. `descriptorDecorators` is read by the walker's
 * descriptor pass (bd tea-rags-mcp-m99j1.1.20): a `@cached_property` def is an
 * attribute holding its return.
 *
 * The extraction facet: `as_manager`, the classmethod Django's own QuerySet exposes.
 * `objects = SiteQuerySet.as_manager()` types `Site.objects.<m>` on hop 1 of the
 * chain fold, and reading class-body manager bindings is what closed 141 of
 * netbox's 148 `chain` misses (bd tea-rags-mcp-xpl83). The verb is the claim, so
 * where Django is not a dependency the dotted call carries none.
 *
 * The base-factory facet: `from_queryset`, the classmethod Django's BaseManager
 * exposes. Django's own `Manager` is declared through it, so without it the
 * manager's MRO stops at the call and every verb on a typed manager misses.
 *
 * It activates on `django` alone. Not `djangorestframework`, not `django-filter`:
 * those depend on Django and therefore never appear without it, so listing them
 * would widen the family without widening what it matches.
 */

import { definePythonFrameworkVocabulary, type PythonFrameworkVocabulary } from "./types.js";

const DJANGO_MANAGER = "django.db.models.manager.Manager";

export const DJANGO_VOCABULARY: PythonFrameworkVocabulary = definePythonFrameworkVocabulary(
  "django",
  [
    "classBodyManagerFactory",
    "baseClassFactory",
    "modelAttributes",
    "relationReturning",
    "instanceReturning",
    "associationFields",
    "descriptorDecorators",
  ],
  ["django"],
  {
    modelBases: new Set(["Model"]),
    // `ModelBase` installs these on every model class; none is declared on it.
    // The underscored three are Django's spelling alone, so they type even an
    // owner the fold lost (`self.model._meta`); `objects` is everyone's.
    // Each answer is spelled by the module that declares it (bd
    // tea-rags-mcp-m99j1.1.45): django-11039 declares two `class Options`.
    modelAttributes: new Map([
      ["objects", { className: DJANGO_MANAGER, carriesModel: true, nameUniqueToFramework: false }],
      ["_default_manager", { className: DJANGO_MANAGER, carriesModel: true, nameUniqueToFramework: true }],
      ["_base_manager", { className: DJANGO_MANAGER, carriesModel: true, nameUniqueToFramework: true }],
      ["_meta", { className: "django.db.models.options.Options", carriesModel: false, nameUniqueToFramework: true }],
    ]),
    // `Manager` proxies every `QuerySet` verb through `from_queryset`.
    relationClasses: new Set(["Manager", "BaseManager", "QuerySet"]),
    relationClass: "django.db.models.query.QuerySet",
    relationReturning: new Set([
      "all",
      "filter",
      "exclude",
      "order_by",
      "distinct",
      "using",
      "select_related",
      "prefetch_related",
      "annotate",
      "select_for_update",
      "defer",
      "only",
      "reverse",
      "none",
      "complex_filter",
      "union",
      "intersection",
      "difference",
      "extra",
      "alias",
    ]),
    // `Manager.db_manager(using, hints)` returns a copy of the manager, same type.
    // `using` stays in `relationReturning`: it is a QuerySet verb that Manager proxies.
    selfReturning: new Set(["db_manager"]),
    instanceReturning: new Set(["get", "first", "last", "create", "earliest", "latest"]),
    associationFields: new Set(["ForeignKey", "OneToOneField"]),
  },
  ["django.utils.functional.cached_property"],
  // `class Manager(BaseManager.from_queryset(QuerySet))` (bd tea-rags-mcp-m99j1.1.46):
  // `from_queryset` returns `type(name, (cls,), <queryset's public methods>)`, so
  // BaseManager's own members win and QuerySet's follow — the order the walker
  // records them in.
  ["from_queryset"],
);
