/**
 * Fail-fast guard for `--languages`: a selector naming a language the run
 * cannot reach is refused, not completed.
 *
 * A filter that selects zero points finishes "successfully" and reads as
 * "recomputed" to the operator — a validation run that silently measured
 * nothing (bd tea-rags-mcp-34v57). Whether a name is a language at all is
 * `validateLanguages`' question (synchronous, against what the build supports);
 * this guard answers the second one: does the INDEX (and, for a scoped force
 * that can introduce files, the working tree) hold it.
 */

import { normalizeLanguageSelector } from "../../../contracts/language-selector.js";
import { InputValidationError } from "../../public/errors.js";

/** I/O the guard needs; the caller binds it to the collection and the tree. */
export interface LanguagePresencePorts {
  /** Chunk points the index holds for `language`. */
  countIndexed: (language: string) => Promise<number>;
  /** Of `languages`, those with at least one indexable file in the working tree. */
  languagesInTree?: (languages: readonly string[]) => Promise<string[]>;
}

export interface LanguagePresenceOptions {
  /**
   * A scoped force re-chunks from the tree, so a language the index lacks is
   * still reachable when the tree holds files of it. A recompute only reads
   * stored points: the index alone decides.
   */
  scopeToTree: boolean;
}

export class LanguageNotInIndexError extends InputValidationError {
  constructor(
    readonly absent: readonly string[],
    readonly held: readonly string[],
    indexHolds: readonly string[],
  ) {
    const heldNote = held.length > 0 ? ` (requested and present: ${held.join(", ")})` : "";
    super({
      code: "INPUT_LANGUAGE_NOT_IN_INDEX",
      message:
        `Invalid parameter "languages": no files of ${absent.join(", ")} in the index${heldNote}. ` +
        `The index holds: ${indexHolds.length > 0 ? indexHolds.join(", ") : "(nothing)"}`,
      hint: "Drop the absent language from --languages, or index files of it first",
    });
  }
}

export async function assertRequestedLanguagesPresent(
  requested: readonly string[],
  supported: readonly string[],
  ports: LanguagePresencePorts,
  options: LanguagePresenceOptions,
): Promise<void> {
  const languages = [...new Set(requested.map(normalizeLanguageSelector))];
  const counts = await Promise.all(languages.map(async (language) => ports.countIndexed(language)));
  let absent = languages.filter((_, i) => counts[i] === 0);
  if (absent.length === 0) return;

  if (options.scopeToTree && ports.languagesInTree) {
    const inTree = new Set(await ports.languagesInTree(absent));
    absent = absent.filter((language) => !inTree.has(language));
    if (absent.length === 0) return;
  }

  // Failure path only: the held set costs one count per remaining language.
  const others = [...new Set(supported.map(normalizeLanguageSelector))].filter(
    (language) => !languages.includes(language),
  );
  const otherCounts = await Promise.all(others.map(async (language) => ports.countIndexed(language)));
  const heldByCount = (names: readonly string[], tally: readonly number[]): string[] =>
    names.filter((_, i) => (tally[i] ?? 0) > 0);
  const indexHolds = [...heldByCount(languages, counts), ...heldByCount(others, otherCounts)].sort();
  throw new LanguageNotInIndexError(
    absent,
    languages.filter((language) => !absent.includes(language)),
    indexHolds,
  );
}
