/**
 * The generic-name judgement (bd tea-rags-mcp-4p3sb): which names denote
 * nothing in particular (`result`, `data`, `item`). One pure function, called by
 * both `get_ontology_report` (the summary's `genericNames`, and the names every
 * section excludes) and `get_naming_lexicon` (the caveat on a draft named so),
 * so the two tools cannot disagree about a name.
 */
import type { OntologyGenericNameRow } from "../../../contracts/types/codegraph.js";
import type { IdentifierCasing } from "../../../contracts/types/language.js";
import { classifyNamingShape, spellsTypeName } from "./shapes.js";

/** The generic bar: bound to at least `minTypes` types, none holding `maxTopTypeShare` of the name's rows. */
export interface GenericNameThresholds {
  minTypes: number;
  maxTopTypeShare: number;
}

/** A name judged generic: the types it does not spell, and their rows. */
export interface JudgedGenericName {
  name: string;
  typeCount: number;
  n: number;
}

/**
 * Judges generic-name candidates (a name with its types, as the store reads
 * them). A type the name spells ({@link spellsTypeName} — EXACT, QUALIFIED or
 * TAIL, in `casingOf(relPath)`: the local casing of the type row's file
 * language) says nothing about the name being generic, so it is dropped —
 * `form` bound to 729 `*Form` classes is the role word of a type family. The
 * name stays generic only when its remaining types still clear `thresholds`;
 * `typeCount` and `n` count those types alone. Most frequent first, then by
 * name; uncapped.
 */
export function judgeGenericNames(
  candidates: readonly OntologyGenericNameRow[],
  casingOf: (relPath: string, name: string) => IdentifierCasing,
  thresholds: GenericNameThresholds,
): JudgedGenericName[] {
  const judged: JudgedGenericName[] = [];
  for (const candidate of candidates) {
    const unrelated = candidate.types.filter(
      (type) =>
        !spellsTypeName(
          classifyNamingShape({
            name: candidate.name,
            kind: "local",
            casing: casingOf(type.relPath, candidate.name),
            typeName: type.typeName,
          }),
        ),
    );
    const n = unrelated.reduce((s, type) => s + type.n, 0);
    const top = unrelated.reduce((max, type) => Math.max(max, type.n), 0);
    if (unrelated.length < thresholds.minTypes || top >= thresholds.maxTopTypeShare * n) continue;
    judged.push({ name: candidate.name, typeCount: unrelated.length, n });
  }
  return judged.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
