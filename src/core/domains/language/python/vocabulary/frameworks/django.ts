/**
 * Django's vocabulary (bd tea-rags-mcp-w205u.1).
 *
 * One facet today: `as_manager`, the classmethod Django's own QuerySet exposes.
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
  ["classBodyManagerFactory"],
  ["django"],
);
