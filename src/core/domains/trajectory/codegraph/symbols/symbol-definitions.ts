/**
 * The ONE mapping from a file's walked chunks to the `SymbolDefinition`s the
 * symbol table and `cg_symbols` hold.
 *
 * A module of its own so every builder of a symbol table — the provider's two
 * node-write paths and the offline tally / oracle harnesses — shares it. A
 * harness copy that kept only the id fields silently dropped every call
 * signature (`arity`, `kwargs`, `acceptsBlock`), so the narrowers that read them
 * ran on nothing offline while production narrowed (bd tea-rags-mcp-y99pg.7).
 */

import type { FileExtraction, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { lastSegment } from "./symbol-name.js";

export function symbolDefinitionsOf(extraction: FileExtraction): SymbolDefinition[] {
  return extraction.chunks.map((c) => ({
    symbolId: c.symbolId,
    fqName: c.symbolId,
    shortName: lastSegment(c.symbolId),
    relPath: extraction.relPath,
    scope: c.scope,
    // Thread walker-captured arity + visibility into SymbolDefinition (bd xlnub)
    ...(c.arity !== undefined ? { arity: c.arity } : {}),
    ...(c.visibility !== undefined ? { visibility: c.visibility } : {}),
    // Thread walker-captured kwarg signature + block-acceptance (bd d9o7o)
    ...(c.kwargs !== undefined ? { kwargs: c.kwargs } : {}),
    ...(c.acceptsBlock !== undefined ? { acceptsBlock: c.acceptsBlock } : {}),
    // Abstract-stub marker (bd tea-rags-mcp-bcdfe) — set only when true, so the
    // self-dispatch probe can tell a declaration from a concrete definition.
    ...(c.isAbstractStub === true ? { isAbstractStub: true } : {}),
    // The declaration kind the walker saw (bd tea-rags-mcp-vi0wx) — absent when
    // the walker recorded none, so "unknown" never turns into a guessed kind.
    ...(c.symbolKind ? { symbolKind: c.symbolKind } : {}),
    // The symbol's AST range, persisted so the payload healer maps chunks to
    // owners by the same rule the deferred pass uses (bd tea-rags-mcp-9i2ow).
    ...(c.startLine !== undefined && c.endLine !== undefined ? { startLine: c.startLine, endLine: c.endLine } : {}),
  }));
}
