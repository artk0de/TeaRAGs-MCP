/** The two axes a digest can stand behind; `codegraphSchema` stays hand-judged. */
export type PinnedVersionAxis = "chunking" | "walker";

export interface VersionAxisSources {
  readonly axis: PinnedVersionAxis;
  /** Directories or files, repo-relative. Missing entries are skipped. */
  readonly paths: readonly string[];
}

const LANGUAGE_ROOT = "src/core/domains/language";
const HOOKS_ROOT = "src/core/domains/ingest/pipeline/chunker/hooks";

/**
 * Which sources a language's `versions.<axis>` number vouches for. `walker`
 * covers walker + resolver chain + DSL grammar (the rule's "walker pass,
 * resolver chain, dispatch narrowing" row); `chunking` covers the language's
 * chunking hooks on both sides of the chunker boundary.
 */
export function versionAxisSources(language: string): VersionAxisSources[] {
  return [
    {
      axis: "chunking",
      paths: [`${LANGUAGE_ROOT}/${language}/chunking`, `${HOOKS_ROOT}/${language}`],
    },
    {
      axis: "walker",
      paths: [
        `${LANGUAGE_ROOT}/${language}/walker`,
        `${LANGUAGE_ROOT}/${language}/resolver`,
        `${LANGUAGE_ROOT}/${language}/dsl`,
      ],
    },
  ];
}
