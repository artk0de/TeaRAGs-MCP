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

import { FrameworkVocabularyRegistry } from "../../../kernel/framework-vocabulary.js";
import { DJANGO_VOCABULARY } from "./django.js";
import type { PythonFrameworkMemberTypes, PythonFrameworkVocabulary, PythonVocabularyFacet } from "./types.js";
import { WERKZEUG_VOCABULARY } from "./werkzeug.js";

export type {
  PythonFrameworkMemberTypes,
  PythonFrameworkModelAttribute,
  PythonFrameworkVocabulary,
  PythonVocabularyFacet,
} from "./types.js";

/** Every registered vocabulary. Adding one is a module plus a line here. */
export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[] = [DJANGO_VOCABULARY, WERKZEUG_VOCABULARY];

/** The facets active for one project — the only question a consumer asks. */
export interface PythonVocabularyCatalogue {
  readonly activeFacets: ReadonlySet<PythonVocabularyFacet>;
  readonly hasFacet: (facet: PythonVocabularyFacet) => boolean;
  /** The active frameworks' synthesized member returns, in registration order. */
  readonly memberTypes: readonly PythonFrameworkMemberTypes[];
  /** The active frameworks' qualified descriptor decorators, unioned. */
  readonly descriptorDecorators: ReadonlySet<string>;
}

/** {@link PYTHON_FRAMEWORKS} under the kernel activation rule (bd tea-rags-mcp-m99j1.1.8). */
const PYTHON_FRAMEWORK_REGISTRY = new FrameworkVocabularyRegistry(PYTHON_FRAMEWORKS);

/**
 * The vocabularies active for a declared-dependency set. `null` → every one of
 * them (gating off). Membership is EXACT against the PEP 503-normalized names,
 * never a prefix test.
 */
export function filterActivePythonFrameworks(
  frameworks: readonly PythonFrameworkVocabulary[],
  declared: ReadonlySet<string> | null,
): readonly PythonFrameworkVocabulary[] {
  return new FrameworkVocabularyRegistry(frameworks).active(declared);
}

export function composePythonVocabulary(declared: ReadonlySet<string> | null): PythonVocabularyCatalogue {
  const activeFacets = new Set<PythonVocabularyFacet>();
  const memberTypes: PythonFrameworkMemberTypes[] = [];
  const descriptorDecorators = new Set<string>();
  for (const framework of PYTHON_FRAMEWORK_REGISTRY.active(declared)) {
    for (const facet of framework.facets) activeFacets.add(facet);
    if (framework.memberTypes !== undefined) memberTypes.push(framework.memberTypes);
    if (framework.facets.has("descriptorDecorators")) {
      for (const decorator of framework.descriptorDecorators ?? []) descriptorDecorators.add(decorator);
    }
  }
  return { activeFacets, hasFacet: (facet) => activeFacets.has(facet), memberTypes, descriptorDecorators };
}

/**
 * The FULL catalogue (every vocabulary, gating off) — byte-identical to the
 * pre-gating behaviour, so a caller that threads no declared set is unchanged.
 */
export const FULL_PYTHON_VOCABULARY: PythonVocabularyCatalogue = composePythonVocabulary(null);

/**
 * Every module-qualified class a registered vocabulary ANSWERS with —
 * `modelAttributes` classes and the `relationClass` (bd tea-rags-mcp-m99j1.1.45).
 * Not gated on activation: the spelling can only have come from a vocabulary,
 * and where it is placed is a property of the spelling, not of the project.
 */
const PYTHON_FRAMEWORK_ANSWER_CLASSES: ReadonlySet<string> = new Set(
  PYTHON_FRAMEWORKS.flatMap((framework) =>
    framework.memberTypes === undefined
      ? []
      : [
          framework.memberTypes.relationClass,
          ...[...framework.memberTypes.modelAttributes.values()].map((attribute) => attribute.className),
        ],
  ),
);

/**
 * Is `typeName` a class a framework answer names by its module? Such a name is
 * placed the way an absolute import of that module is, never by its last
 * segment through the caller's imports.
 */
export function isPythonFrameworkAnswerClass(typeName: string): boolean {
  return PYTHON_FRAMEWORK_ANSWER_CLASSES.has(typeName);
}

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
