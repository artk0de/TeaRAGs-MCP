/**
 * The run-global Python class key — a zero-import leaf.
 *
 * `python-import-file-mapper.ts` spells class keys (`resolveExportedClassKey`)
 * and `python-type-addressing.ts` imports the mapper, so the key spelling lives
 * here where both can reach it without closing an import cycle.
 * `python-type-addressing.ts` re-exports both names, so existing import paths
 * keep working (same pattern as `short-name-lookup.ts`).
 */

/**
 * The run-global address of a Python class: `<relPath>::<dotted class FQ>` (bd
 * tea-rags-mcp-9fgdi). `classAncestors` is run-global, so a bare class name
 * cannot be the key — two `Base` classes in two files would conflate. `::` and
 * not a dot, because `Outer.Inner` is a legal class FQ and would not split.
 */
export function pythonClassKey(relPath: string, classFq: string): string {
  return `${relPath}::${classFq}`;
}

/** The inverse of {@link pythonClassKey}; `null` for anything not in that shape. */
export function parsePythonClassKey(classKey: string): { readonly relPath: string; readonly classFq: string } | null {
  const at = classKey.indexOf("::");
  if (at <= 0) return null;
  const classFq = classKey.slice(at + 2);
  return classFq.length === 0 ? null : { relPath: classKey.slice(0, at), classFq };
}

/**
 * Is `typeName` a class KEY a return-fact reader placed (`db/backends/utils.py::
 * CursorWrapper`, bd tea-rags-mcp-m99j1.1.55) rather than a written spelling?
 * The walker's `<module>::<Name>` never reaches a type consumer — the reader
 * re-spells or kills it — so the file extension is what tells the two apart.
 */
export function isPythonPlacedClassKey(typeName: string): boolean {
  const parsed = parsePythonClassKey(typeName);
  return parsed !== null && /\.pyi?$/.test(parsed.relPath);
}
