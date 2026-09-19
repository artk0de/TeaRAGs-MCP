/**
 * "Does anything but the NAME say this member call reaches that symbol?" — the
 * question a receiver-bearing call must answer before a short-name pass may
 * commit it (bd tea-rags-mcp-t5cji).
 *
 * `globalShortName` and `importNarrowedFallback` look a member up by its bare
 * name, the receiver discarded. For a bare call that is the whole story — the
 * name IS the callee — and a walker-typed receiver never reaches them unguarded.
 * Every other receiver arrives with nothing but its member's spelling, and a
 * project symbol that happens to be the only one so spelled is a coincidence.
 * The family filter made the coincidences visible: once Ruby namesakes stopped
 * making `title`, `filter`, `request` and `body` ambiguous, taxdome's replay
 * showed ~89 call sites committed to the lone TypeScript symbol of that name —
 * `COPY.title(...)` on an object literal landing on `Message#title`,
 * `rows.filter(...)` on an untyped array landing on `TaskHelper.filter`,
 * `new …Fetcher().request()` on a generated class landing on a free function.
 * Every one reproduces with no Ruby file at all. JavaScript closed the same hole
 * by declining every receiver-bearing call (bd tea-rags-mcp-hwwtw); TypeScript
 * has a checker, so it can ask instead.
 *
 * The evidence is the checker's own resolution of the property NAME at the call
 * site (`getSymbolAtLocation`), which follows unions and inheritance the way the
 * compiler does; a re-export alias it stops at is followed on to the symbol it
 * stands for ({@link calledMemberSymbol}). The candidate is accounted for when
 * one of that symbol's declarations sits in the candidate's own file — or in the
 * `.d.ts` beside the candidate's JavaScript ({@link declarationFileTypes}) — or
 * when the member is declared on a supertype — an interface, an abstract base — that the
 * candidate's owner descends from in the run hierarchy (the hwwtw rule for an
 * interface receiver's implementer, kept). Anything else declines: no Program
 * (`CODEGRAPH_TS_TYPECHECKER=0`), no locatable property access, an `any` /
 * `unknown` / error receiver whose property has no symbol, or a declaration in a
 * file the candidate is not in.
 *
 * Declining is not deciding: the call falls through to the checker passes,
 * which pin what the compiler resolved — a file-only edge to `copy.ts` where the
 * member is an object-literal arrow the table carries no symbol for.
 */

import ts from "typescript";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { lookupEcmascriptSymbolsByShortName } from "../../shared/ecmascript-symbol-lookup.js";
import { declarationOwnerName, findReceiverExpression } from "./strategies/ts-type-checker-shared.js";
import { receiverTypeName } from "./ts-external-call.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/**
 * `true` when `call` has a receiver the walker did not type and the type
 * checker does not resolve its member to `candidate` — so committing the
 * candidate would rest on its short name alone.
 *
 * `false` for a bare call, for `this` / `super` (earlier passes own them), and
 * for a receiver the walker typed as a PROJECT type — one the table declares, or
 * the candidate's own owner — which the typed passes and their own guards decide
 * (`importNarrowedFallback`'s interface recovery among them). A walker type the
 * table does not know is no evidence: taxdome's `fetcher.request()` on a
 * generated `…Fetcher` kept landing on the lone free `request` until this said
 * so.
 */
export function memberCandidateLacksReceiverEvidence(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
  candidate: Pick<SymbolDefinition, "relPath" | "scope">,
): boolean {
  const { receiver } = call;
  if (!receiver || receiver === "this" || receiver === "super") return false;
  // A walker type the PROJECT declares belongs to the typed passes. One the
  // table has never heard of — a generated `…Fetcher`, an npm class — says
  // nothing about which members exist, so it needs the checker like any other.
  const walkerType = receiverTypeName(call, ctx);
  if (
    walkerType !== undefined &&
    (candidate.scope.at(-1) === walkerType || lookupEcmascriptSymbolsByShortName(ctx, walkerType).length > 0)
  ) {
    return false;
  }
  if (programCache === null) return true;
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return true;
  const node = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  const access = node?.parent;
  if (node === null || access === undefined || !ts.isPropertyAccessExpression(access) || access.expression !== node) {
    return true;
  }
  const declarations = calledMemberSymbol(handle.checker, access.name)?.getDeclarations() ?? [];
  return !declarations.some((declaration) => declarationAccountsFor(declaration, candidate, ctx, programCache));
}

/**
 * The symbol the called member NAME resolves to, with an import/export alias
 * followed to what it stands for.
 *
 * Through a named re-export barrel (`import * as H from "./helpers"`, where
 * `helpers/index.ts` says `export { f } from "./f"`) `getSymbolAtLocation`
 * answers the barrel's `ExportSpecifier` — an ALIAS whose only declaration sits
 * in the barrel, which declares nothing — so a correct candidate in `f.ts` was
 * declined. A `export *` barrel never showed it: the checker hands back the
 * function's own symbol there.
 */
function calledMemberSymbol(checker: ts.TypeChecker, name: ts.MemberName): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

/**
 * The checker's declaration of the called member is the candidate's — same
 * file, or its sibling declaration file — or a supertype member the candidate's
 * owner overrides or implements.
 */
function declarationAccountsFor(
  declaration: ts.Declaration,
  candidate: Pick<SymbolDefinition, "relPath" | "scope">,
  ctx: CallContext,
  programCache: TSProgramCache,
): boolean {
  const declaringFile = programCache.toProjectSourceRelPath(declaration.getSourceFile().fileName);
  if (declaringFile !== null && declarationFileTypes(declaringFile, candidate.relPath)) return true;
  const declaringOwner = declarationOwnerName(declaration);
  const candidateOwner = candidate.scope.at(-1);
  if (declaringOwner === null || candidateOwner === undefined) return false;
  return (
    ctx.hierarchy
      ?.getDescendants(declaringOwner, { transitive: true })
      .some((edge) => edge.sourceFqName === candidateOwner) ?? false
  );
}

/** `<stem>.d.ts` / `.d.mts` / `.d.cts` — a declaration file, captured by stem. */
const DECLARATION_FILE = /^(.*)\.d\.(?:ts|mts|cts)$/u;

/** The JavaScript sources a declaration file can stand beside. */
const TYPED_JAVASCRIPT_SUFFIXES: readonly string[] = [".js", ".jsx", ".mjs", ".cjs"];

/**
 * Does a declaration in `declaringFile` speak for a symbol in `candidateFile`?
 * The same file does, and so does a declaration file for the JavaScript beside
 * it: with `legacy.d.ts` next to `legacy.js` the checker reads the `.d.ts` and
 * never the `.js`, while the codegraph walks the `.js` — the only file with a
 * body to name — so the member is declared in the one and a symbol in the other.
 */
function declarationFileTypes(declaringFile: string, candidateFile: string): boolean {
  if (declaringFile === candidateFile) return true;
  const stem = DECLARATION_FILE.exec(declaringFile)?.[1];
  return stem !== undefined && TYPED_JAVASCRIPT_SUFFIXES.some((suffix) => candidateFile === `${stem}${suffix}`);
}
