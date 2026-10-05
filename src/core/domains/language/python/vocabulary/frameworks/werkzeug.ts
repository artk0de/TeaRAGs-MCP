/**
 * Werkzeug's vocabulary (bd tea-rags-mcp-m99j1.1.20).
 *
 * One facet: `werkzeug.utils.cached_property`, the descriptor Flask and every
 * Werkzeug application decorate attributes with. It is Werkzeug's own class,
 * not `functools.cached_property`, so the language's descriptor set cannot
 * answer for it, and where Werkzeug is not a dependency the spelling means
 * nothing.
 *
 * It activates on `werkzeug` alone: Flask depends on it, so a Flask project
 * declares or locks it and listing `flask` would widen nothing.
 */

import { definePythonFrameworkVocabulary, type PythonFrameworkVocabulary } from "./types.js";

export const WERKZEUG_VOCABULARY: PythonFrameworkVocabulary = definePythonFrameworkVocabulary(
  "werkzeug",
  ["descriptorDecorators"],
  ["werkzeug"],
  undefined,
  ["werkzeug.utils.cached_property"],
);
