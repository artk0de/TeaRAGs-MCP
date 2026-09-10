/**
 * The file extensions a Python symbol may be DECLARED in (bd tea-rags-mcp-w205u).
 *
 * The codegraph builds ONE symbol table per run over every extension in
 * `CODEGRAPH_LANGUAGES` — production and both offline harnesses alike — and
 * `SymbolDefinition` carries no `language` field, so a short-name lookup
 * answers with whatever file in the repo happens to spell the name. Measured on
 * polar: `range(...)` resolved to
 * `clients/packages/ui/src/components/atoms/Paginator.tsx#range` and `GitHub()`
 * to `Icons.tsx#GitHub` — 46 of its 155 phantoms, every one a TypeScript file.
 * A Python resolver therefore gates candidates on the path, exactly as Ruby's
 * `isRubyPath` does for the same reason (bug pl7k).
 *
 * A LITERAL rather than a read of the registry: `CODEGRAPH_LANGUAGES` lives in
 * `domains/trajectory/`, and `language` is a leaf domain that may not import a
 * sibling (`.claude/rules/domain-boundaries.md`). This is the single place the
 * list is written down — it mirrors the registry's one Python entry, `.py`.
 */
export const PYTHON_SOURCE_EXTENSIONS: readonly string[] = [".py"];

/** Whether a symbol-table `relPath` is a Python file a Python edge may point at. */
export function isPythonSourcePath(relPath: string): boolean {
  return PYTHON_SOURCE_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}
