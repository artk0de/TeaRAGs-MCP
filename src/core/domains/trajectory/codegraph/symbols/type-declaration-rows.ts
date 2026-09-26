/**
 * Sink-time row builder for `cg_type_declarations` (bd tea-rags-mcp-vi0wx,
 * spec §1b): a file's `typeDeclarations` as the naming lexicon persists them.
 *
 * Pure — one `FileExtraction` in, rows out, every language and every fact:
 * which resolver READS the facts is gated elsewhere (`CodegraphRunState#
 * readsTypeDeclarations`), and the naming read filters re-openings itself. A
 * file declaring nothing yields `[]`, which is what clears its stored rows.
 */

import type { FileExtraction, TypeDeclarationRow } from "../../../../contracts/types/codegraph.js";
import { lastSegment } from "./symbol-name.js";

export function buildTypeDeclarationRows(extraction: FileExtraction): TypeDeclarationRow[] {
  return (extraction.typeDeclarations ?? []).map((fact) => ({
    language: extraction.language,
    typeId: fact.typeId,
    shortName: lastSegment(fact.typeId),
    symbolKind: fact.symbolKind,
    line: fact.line,
    reopens: fact.reopens,
    supertypes: [...(fact.conforms ?? [])],
  }));
}
