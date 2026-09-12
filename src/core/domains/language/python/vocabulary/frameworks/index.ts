/**
 * The Python framework-vocabulary registry and the per-project catalogue it
 * composes (bd tea-rags-mcp-w205u.1) — the Python counterpart of
 * `ruby/dsl/catalogue.ts`, minus the tree-sitter parse, because the declared set
 * arrives already parsed (`infra/dependency-manifests.ts`).
 *
 * The composition rule is Ruby's, unchanged: an UNCONDITIONAL vocabulary always
 * loads; a gated one loads iff its `activatedBy` family intersects the project's
 * declared dependencies; and a project with NO manifest gets the full catalogue,
 * because absence of a manifest is absence of evidence and must never be read as
 * a denial.
 */

import { DJANGO_VOCABULARY } from "./django.js";
import type { PythonFrameworkVocabulary, PythonVocabularyFacet } from "./types.js";

export type { PythonFrameworkVocabulary, PythonVocabularyFacet } from "./types.js";

/** Every registered vocabulary. Adding one is a module plus a line here. */
export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[] = [DJANGO_VOCABULARY];

/** The facets active for one project — the only question a consumer asks. */
export interface PythonVocabularyCatalogue {
  readonly activeFacets: ReadonlySet<PythonVocabularyFacet>;
  readonly hasFacet: (facet: PythonVocabularyFacet) => boolean;
}

const setsIntersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * The vocabularies active for a declared-dependency set. `null` → every one of
 * them (gating off). Membership is EXACT against the PEP 503-normalized names,
 * never a prefix test.
 */
export function filterActivePythonFrameworks(
  frameworks: readonly PythonFrameworkVocabulary[],
  declared: ReadonlySet<string> | null,
): readonly PythonFrameworkVocabulary[] {
  if (declared === null) return frameworks;
  return frameworks.filter((f) => f.activatedBy === undefined || setsIntersect(f.activatedBy, declared));
}

export function composePythonVocabulary(declared: ReadonlySet<string> | null): PythonVocabularyCatalogue {
  const activeFacets = new Set<PythonVocabularyFacet>();
  for (const framework of filterActivePythonFrameworks(PYTHON_FRAMEWORKS, declared)) {
    for (const facet of framework.facets) activeFacets.add(facet);
  }
  return { activeFacets, hasFacet: (facet) => activeFacets.has(facet) };
}

/**
 * The FULL catalogue (every vocabulary, gating off) — byte-identical to the
 * pre-gating behaviour, so a caller that threads no declared set is unchanged.
 */
export const FULL_PYTHON_VOCABULARY: PythonVocabularyCatalogue = composePythonVocabulary(null);

/**
 * Per-declared-set catalogue cache, keyed by the set INSTANCE (weak → evicts
 * with the set). The run holds one instance for the whole run, so composition is
 * paid once and every per-file lookup is a map hit.
 */
const catalogueByDeclared = new WeakMap<ReadonlySet<string>, PythonVocabularyCatalogue>();

/**
 * The catalogue for a project's declared dependencies, memoised by the set
 * instance. `null` / `undefined` — no manifest anywhere — returns
 * {@link FULL_PYTHON_VOCABULARY}. An EMPTY set is a different answer: it is a
 * manifest that declares nothing, so it composes normally and every gated
 * vocabulary drops out.
 */
export function pythonVocabularyFor(declared: ReadonlySet<string> | null | undefined): PythonVocabularyCatalogue {
  if (declared === null || declared === undefined) return FULL_PYTHON_VOCABULARY;
  const cached = catalogueByDeclared.get(declared);
  if (cached !== undefined) return cached;
  const built = composePythonVocabulary(declared);
  catalogueByDeclared.set(declared, built);
  return built;
}
