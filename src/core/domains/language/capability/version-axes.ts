import { SHARED_LANGUAGE } from "../kernel/capability.js";

/** The two axes a digest can stand behind; `codegraphSchema` stays hand-judged. */
export type PinnedVersionAxis = "chunking" | "walker";

export interface VersionAxisSources {
  readonly axis: PinnedVersionAxis;
  /** Directories or files, repo-relative. Missing entries are skipped. */
  readonly paths: readonly string[];
  /**
   * Repo-relative files or directories pruned back out of `paths`. Lets an axis
   * be stated as "this whole directory EXCEPT" — the only shape that survives a
   * new file being added to a language, which is exactly the change a digest
   * must not miss.
   */
  readonly exclude?: readonly string[];
}

const LANGUAGE_ROOT = "src/core/domains/language";
const HOOKS_ROOT = "src/core/domains/ingest/pipeline/chunker/hooks";
const CHUNKER_ROOT = "src/core/domains/ingest/pipeline/chunker";

/**
 * What the `*` pseudo-language's axes vouch for: the sources every language
 * runs through, where a change moves every language's output at once and no
 * `<lang>/capability.ts` number can say so. Bumped by
 * `.claude/rules/index-format-versions.md`; numbers in `kernel/capability.ts`.
 */
const SHARED_SOURCES: VersionAxisSources[] = [
  {
    // Every non-test `.ts` directly under the chunker, named one by one rather
    // than by directory: recursing would swallow `hooks/<lang>/`, which each
    // language's own `chunking` axis already owns. The list is kept in lockstep
    // with the rule's `chunker/*.ts` glob — a file matching the rule but
    // digested by nothing is a version number vouching for code it never saw.
    axis: "chunking",
    paths: [
      `${CHUNKER_ROOT}/base.ts`,
      `${CHUNKER_ROOT}/tree-sitter.ts`,
      `${CHUNKER_ROOT}/markdown-chunker.ts`,
      `${CHUNKER_ROOT}/character.ts`,
      `${CHUNKER_ROOT}/config.ts`,
      `${CHUNKER_ROOT}/materialize.ts`,
      `${CHUNKER_ROOT}/symbol-mass.ts`,
      `${CHUNKER_ROOT}/symbol-id-disambiguator.ts`,
      `${CHUNKER_ROOT}/chunk-navigation.ts`,
      `${CHUNKER_ROOT}/utils/chunk-id.ts`,
      "src/core/infra/symbolid",
      // `chunker/materialize.ts` is a seven-line re-export; the AST every
      // chunker and the codegraph provider actually walk is built here.
      "src/core/infra/materialize.ts",
    ],
  },
  {
    axis: "walker",
    paths: [
      `${LANGUAGE_ROOT}/kernel`,
      `${LANGUAGE_ROOT}/resolver-chain.ts`,
      `${LANGUAGE_ROOT}/cone-dispatch.ts`,
      // Shared resolution the verticals lean on: which file an import names,
      // whether a symbol is external, and the ECMAScript global vocabulary.
      `${LANGUAGE_ROOT}/import-file-edges.ts`,
      `${LANGUAGE_ROOT}/external-classifier.ts`,
      `${LANGUAGE_ROOT}/shared`,
      // The factory decides WHICH walker and resolver each language gets and
      // with which mode — a change here retargets edges without touching a
      // single per-language file.
      `${LANGUAGE_ROOT}/factory.ts`,
      "src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts",
    ],
    // Same exclusion as a language's own `capability.ts`, for the same reason:
    // `kernel/capability.ts` HOLDS `sharedVersions`, so digesting it would make
    // every bump invalidate the pin it just moved.
    exclude: [`${LANGUAGE_ROOT}/kernel/capability.ts`],
  },
];

/**
 * Which sources a language's `versions.<axis>` number vouches for. `chunking`
 * covers the language's chunking hooks on both sides of the chunker boundary;
 * `walker` covers everything else the vertical owns — walker, resolver chain,
 * DSL grammar, and the loose files beside them (`kernel.ts`, `index.ts`,
 * vocabularies, schemas), because a resolution change can land in any of them.
 * `capability.ts` is excluded: it holds the version numbers themselves, so
 * digesting it would make every bump invalidate its own pin.
 */
export function versionAxisSources(language: string): VersionAxisSources[] {
  if (language === SHARED_LANGUAGE) return SHARED_SOURCES;
  return [
    {
      axis: "chunking",
      paths: [`${LANGUAGE_ROOT}/${language}/chunking`, `${HOOKS_ROOT}/${language}`],
    },
    {
      axis: "walker",
      paths: [`${LANGUAGE_ROOT}/${language}`],
      exclude: [`${LANGUAGE_ROOT}/${language}/chunking`, `${LANGUAGE_ROOT}/${language}/capability.ts`],
    },
  ];
}
