/**
 * Java implementation of the `CallResolver` contract.
 *
 * Java imports name fully-qualified types: `com.foo.Bar` →
 * `com/foo/Bar.java`. Wildcard imports (`com.foo.*`) point at a
 * package (directory) rather than a single file, so resolution
 * relies on the symbol table's short-name lookup restricted to that
 * directory.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class JavaCallResolver implements CallResolver {
  readonly language = "java";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => javaImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapJavaImportToFile(match.importText);
        if (targetFile) {
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath === targetFile || def.relPath.endsWith(`/${targetFile}`));
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }
}

export function mapJavaImportToFile(importText: string): string | null {
  // Strip wildcards — they point at directories, not specific files.
  if (importText.endsWith(".*")) return null;
  // Static import: drop trailing `.methodName` (the part after the
  // last segment whose first letter is uppercase signifies the class).
  const segments = importText.split(".");
  // Find the class segment (first uppercase-leading segment).
  let classIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    if (s.length > 0 && s[0] >= "A" && s[0] <= "Z") {
      classIdx = i;
      break;
    }
  }
  if (classIdx === -1) return null;
  const pathSegments = segments.slice(0, classIdx + 1);
  return `${pathSegments.join("/")}.java`;
}

function javaImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Wildcard imports — receiver might match any class in that package
  // but we can't pin a specific one here. Reject so caller falls
  // through to global lookup.
  if (importText.endsWith(".*")) return false;
  const segments = importText.split(".");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
