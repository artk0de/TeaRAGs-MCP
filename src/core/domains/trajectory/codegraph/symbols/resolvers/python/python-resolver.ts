/**
 * Python implementation of the `CallResolver` contract.
 *
 * Resolution strategy mirrors TSCallResolver:
 *   1. With a receiver: find the `import` whose last module segment
 *      matches the receiver name; map the module path to a file via
 *      `mapPythonImportToFile`; then look up the member in the symbol
 *      table restricted to that file.
 *   2. Without a receiver: fall back to a global short-name lookup —
 *      handles bare top-level function calls.
 *   3. If neither resolves, return null.
 *
 * Python's syntax differs from TS in import style (`from foo import
 * bar`), so the "receiver matches an import" check needs to also
 * consider import names imported via `from X import Y` — Y becomes a
 * locally-bound name even though X is the module file. This is
 * pragmatically handled by accepting both `importText` (module path)
 * AND the final segment as the receiver match.
 */

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";

export class PythonCallResolver implements CallResolver {
  readonly language = "python";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => pythonImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapPythonImportToFile(match.importText, ctx.callerFile);
        if (targetFile) {
          const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
          const target = candidates[0];
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return { targetRelPath: fallback[0].relPath, targetSymbolId: fallback[0].symbolId };
    }
    return null;
  }
}

function pythonImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip leading dots (relative-import marker) for the comparison —
  // `..foo.bar` should still match `bar` as a receiver. Compare
  // case-sensitively: Python is case-sensitive (User != user).
  const cleaned = importText.replace(/^\.+/, "");
  const segments = cleaned.split(".").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
