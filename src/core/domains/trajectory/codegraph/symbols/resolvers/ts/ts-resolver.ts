/**
 * TypeScript implementation of the `CallResolver` contract.
 *
 * Resolution strategy:
 *   1. If the call has a receiver, look it up in `ctx.imports`. If matched,
 *      `mapImportToFile` resolves the path; then `lookupByShortName(member)`
 *      restricted to that target file gives the symbolId.
 *   2. Fall back to a global `lookupByShortName(member)` — handles default
 *      exports, ambient declarations, and free calls.
 *   3. If neither resolves, return `null` (orphan calls are dropped by the
 *      provider; recording an edge with `targetSymbolId: null` only when the
 *      target file is known).
 */

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";

  constructor(private readonly tsOptions: TsCompilerOptions) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapImportToFile(match.importText, ctx.callerFile, this.tsOptions);
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

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.toLowerCase() === receiver.toLowerCase();
}
