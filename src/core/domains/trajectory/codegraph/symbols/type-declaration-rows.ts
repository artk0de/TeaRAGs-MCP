/**
 * Sink-time row builder for `cg_type_declarations` (bd tea-rags-mcp-vi0wx,
 * spec §1b): a file's `typeDeclarations` as the naming lexicon persists them.
 *
 * Pure — one `FileExtraction` in, rows out, every language and every fact:
 * which resolver READS the facts is gated elsewhere (`CodegraphRunState#
 * readsTypeDeclarations`), and the naming read filters re-openings itself. A
 * file declaring nothing yields `[]`, which is what clears its stored rows.
 *
 * A fact's member census (`typeMemberCensus`, bd tea-rags-mcp-ffxfc) joins it by
 * `typeId` AND `line` — a Ruby class body re-opened in the same file is a
 * second fact with its own members. A fact with no census row keeps both counts
 * absent: unknown, not zero.
 */

import type { FileExtraction, TypeDeclarationRow, TypeMemberCensus } from "../../../../contracts/types/codegraph.js";
import { lastSegment } from "./symbol-name.js";

const censusKey = (typeId: string, line: number): string => `${line}\u0000${typeId}`;

export function buildTypeDeclarationRows(extraction: FileExtraction): TypeDeclarationRow[] {
  const census = new Map<string, TypeMemberCensus>();
  for (const entry of extraction.typeMemberCensus ?? []) census.set(censusKey(entry.typeId, entry.line), entry);
  return (extraction.typeDeclarations ?? []).map((fact) => {
    const row: TypeDeclarationRow = {
      language: extraction.language,
      typeId: fact.typeId,
      shortName: lastSegment(fact.typeId),
      symbolKind: fact.symbolKind,
      line: fact.line,
      reopens: fact.reopens,
      supertypes: [...(fact.conforms ?? [])],
    };
    const members = census.get(censusKey(fact.typeId, fact.line));
    return members === undefined ? row : { ...row, methodCount: members.methodCount, fieldCount: members.fieldCount };
  });
}
