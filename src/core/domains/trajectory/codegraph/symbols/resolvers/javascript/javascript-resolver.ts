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

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];

export class JavascriptCallResolver implements CallResolver {
  readonly language = "javascript";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapJavascriptImportToFile(match.importText, ctx.callerFile);
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
