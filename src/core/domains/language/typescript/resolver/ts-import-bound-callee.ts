/**
 * "The caller imported this name — from where?" (bd tea-rags-mcp-d0xpr).
 *
 * `globalShortName` keys on the member name alone, and for a BARE call the
 * member IS the callee identifier. Strict mode refuses to pick when two project
 * symbols share that name, which reads like enough protection until the copies
 * are not in the symbol table at all.
 *
 * That is the measured shape. Each of taxdome's prototype galleries carries its
 * own `components/shared/tableHelpers.ts`, and every copy exports
 * `getRenderableContent = memoize(renderContent)` — a `const` initialised from a
 * CALL, which is not a declaration the walker names. So none of the copies
 * contributes a symbol, the single INDEXED `getRenderableContent` lives in an
 * unrelated `react-app` helper, N is 1, and the pass committed to it: 52
 * `wrongFile` rows pointing at a file the caller does not import.
 *
 * The caller's import statement settles it without any of that guesswork. It
 * names the file the identifier is bound to, so a candidate in a DIFFERENT file
 * is a same-name coincidence — at N=1 exactly as much as at N=5. Declining
 * leaves the earlier import park standing, and that park is a file-only edge
 * onto the file the caller genuinely imports: the right answer at file
 * granularity, where a fabricated symbol was the wrong answer at both.
 *
 * Scoped to bare calls on purpose. When a call HAS a receiver, the import binds
 * the receiver and the member is a method on whatever that receiver is — the
 * importing file has no obligation to declare it, and reading the two as one
 * name would decline every legitimate `helper.render()`.
 *
 * The import DISAGREEING with the index is not by itself proof of a
 * fabrication, and measuring it on this repo is what showed why: a barrel
 * (`.claude/rules/barrel-files.md` makes them mandatory here) binds the name to
 * `index.ts` while the declaration lives one hop behind the re-export, so the
 * two disagree on every legitimate cross-domain call — 202 of them, on `src`
 * alone. The symbol table cannot tell that hop from a same-name coincidence:
 * both are "the bound file does not declare it". The type checker can, and
 * {@link checkerDeclaresCalleeIn} is asked ONLY on the disagreement, which is
 * what keeps a checker query off the resolving path.
 */

import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import { findCallExpression } from "./strategies/ts-type-checker-fallback.js";
import { mapImportToFile, type ProjectFileProbe, type TsCompilerOptions } from "./ts-path-mapper.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/**
 * The project file the caller's own imports bind `call`'s bare callee name to,
 * or `null` when nothing in the import list binds it — or binds it to something
 * that leaves the project.
 *
 * Both `null` answers mean "this guard has no opinion", and they mean it for
 * different reasons. No import binding the name is the ordinary case for a call
 * to a same-file or ambient declaration, where the short-name match is the
 * intended mechanism. A binding whose specifier maps nowhere is an npm package
 * or a runtime module, which `targetsExternalImport` already owns; answering
 * here would duplicate that verdict in a pass that cannot express it.
 *
 * The FIRST binding import wins. A file that imports one name twice is either
 * re-importing the same module or is already ill-formed, and neither is worth a
 * cardinality rule of its own.
 */
export function importBoundProjectFile(
  call: CallRef,
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): string | null {
  if (call.receiver !== null || call.member.length === 0) return null;
  for (const imp of ctx.imports) {
    if (imp.importedNames?.includes(call.member) !== true) continue;
    return mapImportToFile(imp.importText, ctx.callerFile, tsOptions, fileExists);
  }
  return null;
}

/**
 * The PROJECT file the type checker says this call's selected signature is
 * declared in, or `null` when it names none.
 *
 * `null` is "no evidence" three times over, and every one of them must leave the
 * caller's previous answer standing: no Program (the checker tier is off), no
 * signature the checker could select, or a declaration outside the project's own
 * sources — that last one belongs to `targetsExternalImport`, which has already
 * spoken by the time this is asked.
 *
 * Deliberately the same query `TSTypeCheckerFallbackSymbolResolutionStrategy`
 * (pass 12) runs, read the same way through `toProjectSourceRelPath`. Pass 12
 * cannot answer this question in its place: it fires only for `generic` and
 * `overload` call sites, and it runs three passes too late — the short-name
 * match has already committed.
 */
export function checkerDeclaresCalleeIn(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): string | null {
  if (programCache === null) return null;
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return null;
  const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null) return null;
  const declaration = handle.checker.getResolvedSignature(node)?.declaration;
  if (declaration === undefined) return null;
  return programCache.toProjectSourceRelPath(declaration.getSourceFile().fileName);
}
