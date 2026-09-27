/**
 * Type-name heads (bd tea-rags-mcp-i569j): how many type declarations a type
 * WORD heads — the word their names end in (`…Helper`, `…Concern`). This is the
 * other half of what `types` asks. The value half — how values of a type are
 * named — reads `cg_identifiers`, where a word that no value is typed as
 * (`Helper`, a Ruby mixin nobody annotates) answers nothing; the declarations
 * that carry it as a suffix live in `cg_type_declarations`. Live on taxdome,
 * `types: ["Helper", "Concern"]` under `app/lib/**` answered two local
 * variables, while 151 `*_helper.rb` declarations and one `*_concern.rb` stood
 * there — so "rename this Concern to a Helper" was not decidable.
 *
 * A carrier is a declaration whose head — read by the population's own
 * {@link typeNameParser}, the reading roles and verdicts share — is the word, in
 * either number. A NAMESPACE module ({@link isNamespaceDeclaration}) carries
 * nothing: it wraps its file's subject, so `module Helpers` around a worker
 * locates the worker and names no helper. A mixin module named for its file IS a
 * declaration with a suffix, and counts.
 *
 * Only single-word asks are read: a multi-word type (`TaxAutomationDocument`)
 * is a type whose values are named, not a word names end in.
 */
import type { SymbolDefinitionKind } from "../../../contracts/types/codegraph-symbols.js";
import { singularizeIdentifierWord, typeNameWords } from "./casing.js";
import { isNamespaceDeclaration, typeNameParser, type TypeNameRow } from "./type-roles.js";

/** Examples listed per head. */
const MAX_HEAD_CARRIER_EXAMPLES = 3;

/** The declarations one asked word heads. */
export interface TypeNameHeadCarriers {
  /** The word as asked. */
  head: string;
  /** Declarations carrying it. */
  n: number;
  /** Files they are declared in. */
  files: number;
  /** Declarations per kind. */
  kinds: Partial<Record<SymbolDefinitionKind, number>>;
  /** Up to three carrier short names, in path order. */
  examples: string[];
}

/**
 * The carriers of each single-word `words` entry among `rows` (the type
 * declarations of one scope, in path order), in ask order.
 */
export function typeNameHeadCarriers(rows: readonly TypeNameRow[], words: readonly string[]): TypeNameHeadCarriers[] {
  const asked = words.flatMap((head) => {
    const split = typeNameWords(head);
    return split.length === 1 ? [{ head, word: singularizeIdentifierWord(split[0]) }] : [];
  });
  if (asked.length === 0) return [];
  const parse = typeNameParser(rows);
  const carriers = new Map<string, TypeNameRow[]>();
  for (const row of rows) {
    if (isNamespaceDeclaration(row)) continue;
    const { head } = parse(row.shortName);
    if (head === undefined) continue;
    const word = singularizeIdentifierWord(head);
    carriers.set(word, [...(carriers.get(word) ?? []), row]);
  }
  return asked.map(({ head, word }) => {
    const carried = carriers.get(word) ?? [];
    const kinds: Partial<Record<SymbolDefinitionKind, number>> = {};
    for (const { symbolKind } of carried) {
      if (symbolKind !== null) kinds[symbolKind] = (kinds[symbolKind] ?? 0) + 1;
    }
    return {
      head,
      n: carried.length,
      files: new Set(carried.map((row) => row.relPath)).size,
      kinds,
      examples: [...new Set(carried.map((row) => row.shortName))].slice(0, MAX_HEAD_CARRIER_EXAMPLES),
    };
  });
}
