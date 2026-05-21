/**
 * JavaScript implementation of the `CallResolver` contract.
 *
 * Plain JS (no tsconfig paths, no .ts extension games). Imports are
 * either:
 *   - relative paths: `./foo`, `../foo/bar` — resolved against the
 *     caller's directory, with `.js`/`.jsx`/`.mjs`/`.cjs` extension
 *     guessing.
 *   - bare specifiers (`react`, `lodash`) — out of scope; only matter
 *     for node_modules which codegraph excludes.
 *
 * Receiver matching: same heuristic as TS — the import's last path
 * segment must match the receiver case-insensitively. The walker
 * already filters require/import from the calls collection so the
 * receiver list here only contains real method calls.
 */

import { posix } from "node:path";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];

export class JavascriptCallResolver implements CallResolver {
  readonly language = "javascript";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // Intra-class `this.X()` / `super.X()` — instance method dispatch.
    // Target symbolId composes as `<EnclosingClass>#<member>` per the
    // project convention (`.claude/rules/symbolid-convention.md`).
    // Falls back to `.` (static) and same-file short-name only when
    // the instance lookup misses.
    if (call.receiver === "this" || call.receiver === "super") {
      if (ctx.callerScope.length > 0) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const fqName = `${enclosing}#${call.member}`;
        const direct = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
        if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
        const staticFqName = `${enclosing}.${call.member}`;
        const staticHit = ctx.symbolTable.lookup(staticFqName).find((def) => def.relPath === ctx.callerFile);
        if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
        const sameFile = ctx.symbolTable.lookupByShortName(call.member).find((def) => def.relPath === ctx.callerFile);
        if (sameFile) return { targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId };
      }
    }
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapJavascriptImportToFile(match.importText, ctx.callerFile);
        if (targetFile) {
          const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
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

export function mapJavascriptImportToFile(importText: string, callerFile: string): string | null {
  // Only relative imports resolve to project-local files. Bare
  // specifiers (npm packages) are out of scope — codegraph excludes
  // node_modules from the walk.
  if (!importText.startsWith(".")) return null;
  const callerDir = posix.dirname(callerFile);
  const joined = posix.normalize(posix.join(callerDir, importText));
  // If the import already carries an extension, keep it (Node modern
  // ESM requires explicit extensions). Otherwise default to `.js`.
  for (const ext of JS_EXTS) {
    if (joined.endsWith(ext)) return joined;
  }
  return `${joined}.js`;
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  // Strip extension if any so `./foo.js` matches receiver `foo`.
  const cleaned = last.replace(/\.(js|jsx|mjs|cjs)$/, "");
  return cleaned.toLowerCase() === receiver.toLowerCase();
}
