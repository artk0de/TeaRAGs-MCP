/**
 * Django's vocabulary (bd tea-rags-mcp-w205u.1).
 *
 * The synthesized model members and query verbs (`memberTypes`, bd
 * tea-rags-mcp-m99j1.1.21) are answered by the resolver's `frameworkReturnType`
 * port. `associationFields` / `descriptorDecorators` are declared for the
 * walker, which owns reading a field's constructor argument.
 *
 * The extraction facet: `as_manager`, the classmethod Django's own QuerySet exposes.
 * `objects = SiteQuerySet.as_manager()` types `Site.objects.<m>` on hop 1 of the
 * chain fold, and reading class-body manager bindings is what closed 141 of
 * netbox's 148 `chain` misses (bd tea-rags-mcp-xpl83). The verb is the claim, so
 * where Django is not a dependency the dotted call carries none.
 *
 * It activates on `django` alone. Not `djangorestframework`, not `django-filter`:
 * those depend on Django and therefore never appear without it, so listing them
 * would widen the family without widening what it matches.
 */

import { definePythonFrameworkVocabulary, type PythonFrameworkVocabulary } from "./types.js";

export const DJANGO_VOCABULARY: PythonFrameworkVocabulary = definePythonFrameworkVocabulary(
  "django",
  [
    "classBodyManagerFactory",
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
    modelAttributes: new Map([
      ["objects", { className: "Manager", carriesModel: true }],
      ["_default_manager", { className: "Manager", carriesModel: true }],
      ["_base_manager", { className: "Manager", carriesModel: true }],
      ["_meta", { className: "Options", carriesModel: false }],
    ]),
    // `Manager` proxies every `QuerySet` verb through `from_queryset`.
    relationClasses: new Set(["Manager", "BaseManager", "QuerySet"]),
    relationClass: "QuerySet",
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
    descriptorDecorators: new Set(["cached_property"]),
  },
);
