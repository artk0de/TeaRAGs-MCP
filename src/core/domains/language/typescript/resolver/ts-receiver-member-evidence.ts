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
 * stands for ({@link calledMemberDeclarations}). The candidate is accounted for when
 * one of that symbol's declarations is the candidate's own — declared by the
 * candidate's owner in the candidate's file or in the `.d.ts` beside its
 * JavaScript ({@link declarationFileTypes}), or, having no named owner, lying
 * inside the candidate's lines — or when the member is declared on a supertype
 * (an interface, an abstract base) the candidate's owner descends from in the
 * run hierarchy (the hwwtw rule for an interface receiver's implementer, kept);
 * see {@link declarationAccountsFor}. Anything else declines: no locatable
 * property access, an `any` / `unknown` / error receiver whose property has no
 * symbol, or a declaration the candidate does not own. With no Program at all
 * (`CODEGRAPH_TS_TYPECHECKER=0`, heap admission's `typecheckerOff`) only
 * STRUCTURE remains: an import binding for a named receiver
 * ({@link importBindingAccountsFor}), the class hierarchy for `this`
 * ({@link thisHierarchyAccountsFor}) — which also answers a `this` member the
 * checker names no symbol for.
 *
 * Declining is not deciding: the call falls through to the checker passes,
 * which pin what the compiler resolved — a file-only edge to `copy.ts` where the
 * member is an object-literal arrow the table carries no symbol for.
 *
 * The two owner-rule arms are EXPORTED for the passes that own their own
 * short-name narrowing, so the rule lives here once (bd tea-rags-mcp-nj8i6):
 * {@link declarationAccountsFor} is what `typeCheckerReturnType`'s same-file
 * fallback filters its candidates through, and {@link thisHierarchyAccountsFor}
 * is what `thisMember`'s same-file fallback applies to its own.
 */

import ts from "typescript";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { lookupEcmascriptSymbols, lookupEcmascriptSymbolsByShortName } from "../../shared/ecmascript-symbol-lookup.js";
import { reexportOriginFile, type ResolverConfig } from "./strategies/shared.js";
import { calledMemberDeclarations, declarationOwnerName } from "./strategies/ts-type-checker-shared.js";
import { receiverTypeName } from "./ts-external-call.js";
import { mapImportToFile } from "./ts-path-mapper.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/** What the guard reads off a short-name candidate: where it lives, whose it is, which lines it spans. */
export type EvidenceCandidate = Pick<SymbolDefinition, "relPath" | "scope" | "startLine" | "endLine">;

/** The resolver config the import-evidence arm maps specifiers and barrels with. */
type EvidenceConfig = Pick<ResolverConfig, "tsOptions" | "mode" | "fileExists">;

/**
 * `true` when `call` has a receiver the walker did not type and the type
 * checker does not resolve its member to `candidate` — so committing the
 * candidate would rest on its short name alone.
 *
 * `false` for a bare call, for `super` (its pass is terminal), and for a
 * receiver the walker typed as a PROJECT type — one the table declares, or the
 * candidate's own owner — which the typed passes and their own guards decide
 * (`importNarrowedFallback`'s interface recovery among them). A walker type the
 * table does not know is no evidence: taxdome's `fetcher.request()` on a
 * generated `…Fetcher` kept landing on the lone free `request` until this said
 * so.
 *
 * `this` is NOT exempt. `thisMember` answers every member the enclosing class
 * declares in its own file, so a `this` call arriving here is one it could not
 * pin — inherited, or not the class's at all — and needs the same evidence: an
 * inherited project member is accepted through the checker's declaration (or,
 * where the checker is absent or silent, through the class hierarchy), while
 * taxdome's `this.state` (React declares it; the walker records the argument as
 * a call) used to land on the project's lone `state`, a nested function in a
 * `.mjs` artifact.
 */
export function memberCandidateLacksReceiverEvidence(
  call: CallRef,
  ctx: CallContext,
  cfg: EvidenceConfig,
  programCache: TSProgramCache | null,
  candidate: EvidenceCandidate,
): boolean {
  const { receiver } = call;
  if (!receiver || receiver === "super") return false;
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
  const handle = programCache?.acquire(ctx.callerFile) ?? null;
  if (programCache === null || handle === null) {
    if (receiver === "this") return !thisHierarchyAccountsFor(call.member, ctx, cfg, candidate);
    return !importBindingAccountsFor(receiver, call.member, ctx, cfg, candidate);
  }
  const declarations = calledMemberDeclarations(handle.sourceFile, handle.checker, call.startLine, call.member);
  if (declarations.length > 0) {
    return !declarations.some((declaration) => declarationAccountsFor(declaration, candidate, ctx, programCache));
  }
  // The checker is silent — no locatable member access, or a receiver whose
  // property it names no symbol for. Only `this` still has structure to ask.
  return receiver !== "this" || !thisHierarchyAccountsFor(call.member, ctx, cfg, candidate);
}

/** A class as the caller's structure pins it: its declared name and the file declaring it. */
interface AnchoredClass {
  readonly name: string;
  readonly file: string;
}

/**
 * The evidence `this` has when the checker gives none (bd tea-rags-mcp-t5cji):
 * the CLASS it sits in. The candidate must be the member `this`'s nearest
 * definer declares — the enclosing class in the caller's file, else the first
 * ancestor up the `extends` chain of the run hierarchy that declares it
 * ({@link nearestMemberDefiners}). Structural, so it holds with or without a
 * Program; a Program's own declaration, where it names one, is asked first and
 * never overruled.
 *
 * The hierarchy is keyed by class NAME, so a name is never the evidence: each
 * hop is anchored to a file ({@link anchorBaseClass}), and a class that merely
 * shares the enclosing class's or a base's name elsewhere — a project
 * `Component` beside React's, a second `BaseJob` in another package — declares
 * nothing this `this` can reach. Without it the checker-off mode lost every
 * inherited `this.initProcessing()` (`BaseIndexingPipeline`) and every
 * class-body `this.markContributed()`, where `thisMember` has no scope to read.
 *
 * The enclosing class is the caller's innermost scope; a CLASS-BODY chunk (a
 * field initializer) has none, and there the chunk's own id, which carries no
 * member separator, is the class.
 *
 * Exported for `TSThisMemberSymbolResolutionStrategy`, whose same-file
 * short-name fallback applies this same rule to its own candidates — without it
 * `Form`'s `this.setState` landed on `Panel#setState` when both classes sat in
 * one file (bd tea-rags-mcp-nj8i6).
 */
export function thisHierarchyAccountsFor(
  member: string,
  ctx: CallContext,
  cfg: EvidenceConfig,
  candidate: EvidenceCandidate,
): boolean {
  const owner = candidate.scope.at(-1);
  const enclosing = ctx.callerScope.at(-1) ?? classBodyChunkClass(ctx.callerSymbolId);
  if (owner === undefined || enclosing === undefined) return false;
  return nearestMemberDefiners(member, { name: enclosing, file: ctx.callerFile }, ctx, cfg, new Set()).some(
    (definer) => definer.name === owner && definer.file === candidate.relPath,
  );
}

/** A class-body chunk's id is the bare class name; a method's or function's carries `#` / `.`. */
export function classBodyChunkClass(callerSymbolId: string | undefined): string | undefined {
  return callerSymbolId === undefined || /[#.]/u.test(callerSymbolId) ? undefined : callerSymbolId;
}

/**
 * The classes whose `member` a `this` inside `cls` reaches: `cls` itself when it
 * declares the member in its file, else — walking every `extends` edge the run
 * hierarchy records for the name — the nearest definers above it. A base no hop
 * can anchor ends its path, which is what keeps a namesake off it. `implements`
 * edges are not followed: an implemented type contributes no member body.
 */
function nearestMemberDefiners(
  member: string,
  cls: AnchoredClass,
  ctx: CallContext,
  cfg: EvidenceConfig,
  seen: Set<string>,
): AnchoredClass[] {
  const key = `${cls.file}::${cls.name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const declares = [`${cls.name}#${member}`, `${cls.name}.${member}`].some((fqName) =>
    lookupEcmascriptSymbols(ctx, fqName).some((def) => def.relPath === cls.file),
  );
  if (declares) return [cls];
  return (ctx.hierarchy?.getAncestors(cls.name, { kinds: ["super"] }) ?? []).flatMap((edge) => {
    const base = anchorBaseClass(edge.ancestorFqName, cls.file, ctx, cfg);
    return base === null ? [] : nearestMemberDefiners(member, base, ctx, cfg, seen);
  });
}

/**
 * Pin the base class `written` in an `extends` clause of a class in `fromFile`
 * to the file that declares it, or `null` when nothing structural does.
 *
 *   - `fromFile` declares a top-level `written` itself: that class.
 *   - `fromFile` is the caller's file, and an import there binds the name: the
 *     file it maps to, through a barrel to the file that declares the EXPORTED
 *     name (`{ Base as B }` extends `B` and means `Base`) — the same hop
 *     `namedImport` makes. A specifier that maps to no project file is a
 *     package's class, and none of the project's namesakes is it.
 *   - anything else — a base another file imports — is `null`. The resolver
 *     sees the CALLER's import list only, and guessing the file by the name
 *     would be the coincidence this exists to refuse.
 */
function anchorBaseClass(
  written: string,
  fromFile: string,
  ctx: CallContext,
  cfg: EvidenceConfig,
): AnchoredClass | null {
  const segments = written.split(".");
  const root = segments[0];
  if (
    segments.length === 1 &&
    lookupEcmascriptSymbols(ctx, written).some((def) => def.relPath === fromFile && def.scope.length === 0)
  ) {
    return { name: written, file: fromFile };
  }
  if (fromFile !== ctx.callerFile) return null;
  const binding = ctx.imports.find((imp) => imp.importedNames?.includes(root));
  if (binding === undefined) return null;
  const mappedFile = mapImportToFile(binding.importText, ctx.callerFile, cfg.tsOptions, cfg.fileExists);
  if (mappedFile === null) return null;
  const name = segments.length > 1 ? (segments.at(-1) ?? root) : (binding.importedBindings?.[root] ?? root);
  return { name, file: reexportOriginFile(name, mappedFile, ctx, cfg.mode) ?? mappedFile };
}

/**
 * The evidence left when there is no Program to ask (`CODEGRAPH_TS_TYPECHECKER=0`,
 * heap admission's `typecheckerOff`, a file no Program serves): the receiver is
 * an IMPORT BINDING, and the file that declares what it binds declares the
 * candidate. Structural, never a name coincidence — a local value, a
 * parameter, an `any` and an object literal bind no import and decline; `this`
 * binds none either, and is asked about its class instead
 * ({@link thisHierarchyAccountsFor}).
 *
 *   - `import * as H`, a default import, `const H = require(…)`: the binding is
 *     the MODULE, so the candidate is a top-level declaration of the mapped
 *     file, or of the file its barrel re-exports the member from — the same
 *     symbol-table hop `namedImport` makes ({@link reexportOriginFile}, bound to
 *     the ECMAScript family's lookup). A default-imported class answers for its
 *     own members too: the candidate's owner is the binding's name.
 *   - `import { X }` / `{ X as Y }`: the binding is ONE exported class or module
 *     object, so the candidate must be X's member (by the EXPORTED name) in the
 *     file X is declared in, barrel hop included.
 *
 * It is deliberately NOT a return to name uniqueness, and it does not buy back
 * what the checker-off mode lost to this guard: on this repo's own sources that
 * was 951 edges over 915 sites (687 of them the checker's own answer), and
 * every one had a local, a parameter, a `this.field` chain or a `new X()`
 * expression for a receiver — none an import binding. What it answers is the
 * namespace-through-a-barrel shape, which no name-free pass reaches.
 *
 * A default import and a `* as` namespace are the same `ImportRef` shape, so the
 * barrel hop is taken for both. For a namespace it is sound — a member the
 * module does not declare must be one it re-exports. For a default-exported
 * INSTANCE it is not (`import api from "./api"; api.get()` enters the instance's
 * class), and what stands between that and a wrong edge is the candidate having
 * to be the project's unique short name AND the unique top-level declaration
 * the hop can name.
 */
function importBindingAccountsFor(
  receiver: string,
  member: string,
  ctx: CallContext,
  cfg: EvidenceConfig,
  candidate: EvidenceCandidate,
): boolean {
  const binding = ctx.imports.find((imp) => imp.importedNames?.includes(receiver));
  if (binding === undefined) return false;
  const mappedFile = mapImportToFile(binding.importText, ctx.callerFile, cfg.tsOptions, cfg.fileExists);
  if (mappedFile === null) return false;
  const declaringFileOf = (name: string): string => reexportOriginFile(name, mappedFile, ctx, cfg.mode) ?? mappedFile;
  const exportedName = binding.importedBindings?.[receiver];
  if (exportedName !== undefined) {
    return candidate.scope.at(-1) === exportedName && declaringFileOf(exportedName) === candidate.relPath;
  }
  if (candidate.scope.length === 0) return declaringFileOf(member) === candidate.relPath;
  return candidate.scope.at(-1) === receiver && declaringFileOf(receiver) === candidate.relPath;
}

/**
 * The checker's declaration of the called member is the candidate's, or a
 * supertype member the candidate's owner overrides or implements.
 *
 * The FILE is not enough, because a file declares more than one owner: a
 * receiver typed by `type Ev = { stopItNow(): void }` accepted the unrelated
 * `Panel#stopItNow` declared further down the same file. So:
 *
 *   - a declaration with a NAMED owner (a class, an interface) accounts for a
 *     candidate owned by that same name in the same file — or its sibling
 *     declaration file ({@link declarationFileTypes}) — and for one whose owner
 *     the run hierarchy records descending from it (the hwwtw implementer rule);
 *   - a declaration with NO named owner (a type literal, an object literal, an
 *     anonymous class, a top-level function) accounts only for the candidate
 *     whose own line range contains it ({@link candidateEnclosesDeclaration}).
 *
 * Exported for `TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy`'s
 * `pinSymbol`, whose same-file short-name fallback filtered by FILE alone and so
 * handed a type-literal receiver's member to the unrelated `Panel#stopItNow`
 * declared further down the same file (bd tea-rags-mcp-nj8i6). The same rule
 * filters its candidates before the cardinality pick.
 */
export function declarationAccountsFor(
  declaration: ts.Declaration,
  candidate: EvidenceCandidate,
  ctx: CallContext,
  programCache: TSProgramCache,
): boolean {
  const declaringFile = programCache.toProjectSourceRelPath(declaration.getSourceFile().fileName);
  const sameSite = declaringFile !== null && declarationFileTypes(declaringFile, candidate.relPath);
  const declaringOwner = declarationOwnerName(declaration);
  if (declaringOwner === null) {
    return sameSite && candidateEnclosesDeclaration(declaration, candidate, declaringFile === candidate.relPath);
  }
  const candidateOwner = candidate.scope.at(-1);
  if (candidateOwner === undefined) return false;
  if (sameSite && candidateOwner === declaringOwner) return true;
  return (
    ctx.hierarchy
      ?.getDescendants(declaringOwner, { transitive: true })
      .some((edge) => edge.sourceFqName === candidateOwner) ?? false
  );
}

/**
 * Is an ownerless declaration the candidate's own? In the candidate's file, its
 * line range must contain the declaration's name — the object literal it is a
 * member of, the function it is. A candidate with no recorded range cannot show
 * that and is declined. Across a `.d.ts` / `.js` pair lines mean nothing, so
 * there only a top-level declaration answers, and only for a top-level
 * candidate — `export declare function f()` for the `.js` file's `f`.
 */
function candidateEnclosesDeclaration(
  declaration: ts.Declaration,
  candidate: EvidenceCandidate,
  sameFile: boolean,
): boolean {
  if (!sameFile) return ts.isSourceFile(declaration.parent) && candidate.scope.length === 0;
  const { startLine, endLine } = candidate;
  if (startLine === undefined || endLine === undefined) return false;
  const sourceFile = declaration.getSourceFile();
  const anchor = ts.getNameOfDeclaration(declaration) ?? declaration;
  const line = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile)).line + 1;
  return startLine <= line && line <= endLine;
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
