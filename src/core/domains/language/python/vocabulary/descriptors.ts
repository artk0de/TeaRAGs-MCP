/**
 * Python's descriptor decorators (P3, bd tea-rags-mcp-m99j1.1.20) — the
 * decorators that turn a `def` into an ATTRIBUTE holding its return.
 *
 * Python reads `obj.name` and `obj.name()` differently: on a plain method the
 * first is a bound method and only the second yields the return, while on a
 * `@property` / `@cached_property` the first IS the return. The walker's
 * descriptor pass records such a def as the field it reads as, and the
 * resolver's attribute hop reads fields only — so which decorators qualify is
 * the whole precision question, and it is answered here.
 *
 * Every spelling is the QUALIFIED name the decorator's import binds, never the
 * bare last segment: a project's own `cached_property` is a different object
 * and not evidence. `property` is a builtin, so its unbound spelling is the
 * qualified one. The language's set is unconditional; a framework contributes
 * its own descriptor (`django.utils.functional.cached_property`) through the
 * `descriptorDecorators` facet, only where the project declares it.
 */

import { pythonVocabularyFor, type PythonVocabularyCatalogue } from "./frameworks/index.js";

/** The language's own descriptor decorators — part of Python, never gated. */
export const PYTHON_LANGUAGE_DESCRIPTOR_DECORATORS: ReadonlySet<string> = new Set([
  "property",
  "functools.cached_property",
]);

const decoratorsByCatalogue = new WeakMap<PythonVocabularyCatalogue, ReadonlySet<string>>();

/**
 * Every qualified descriptor decorator active for a declared-dependency set:
 * the language's, plus each active framework's. Cached per catalogue, which is
 * itself cached per declared set, so a run composes it once.
 */
export function pythonDescriptorDecorators(declared: ReadonlySet<string> | null | undefined): ReadonlySet<string> {
  const catalogue = pythonVocabularyFor(declared);
  const cached = decoratorsByCatalogue.get(catalogue);
  if (cached !== undefined) return cached;
  const built = new Set([...PYTHON_LANGUAGE_DESCRIPTOR_DECORATORS, ...catalogue.descriptorDecorators]);
  decoratorsByCatalogue.set(catalogue, built);
  return built;
}
