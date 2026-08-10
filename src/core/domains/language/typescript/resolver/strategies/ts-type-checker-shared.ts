/**
 * symbolId composition mechanics shared by the TypeScript type-checker passes
 * (bd tea-rags-mcp-un8mv).
 *
 * Every checker pass ends the same way: the compiler hands back a
 * `ts.Declaration`, and the pass has to phrase it as a project symbolId before
 * the run's `GlobalSymbolTable` will confirm it. Which separator goes between an
 * owner and its member, which enclosing `namespace` names prefix it, what the
 * owner is called — that is one question with one answer, and
 * `.claude/rules/symbolid-convention.md` says so directly: a resolver writing
 * `join(".")` for itself is an anti-pattern, the separator belongs in a helper.
 *
 * The passes nevertheless carried their own copies through the epic's Wave 2,
 * when they were authored on concurrent branches and any shared edit would have
 * collided on every merge. The duplication bought merge throughput, never
 * design; this module is where the copies converge now that the tier has
 * settled.
 *
 * What deliberately does NOT live here is the policy each pass layers on top —
 * where the member name comes from, and what to do when the owner has no name at
 * all. `composeSymbolId` degrades to the bare short name there, while
 * `composeMemberSymbolId` declines outright, and each behaviour is load-bearing
 * for its own pass's contract. Sharing the mechanics does not make the policies
 * one policy.
 *
 * Kept apart from `./shared.ts` along the dependency seam: that module holds
 * `ResolverConfig` and the import mapper that EVERY strategy needs, and it
 * reaches for nothing from the compiler. Everything here takes a `ts` AST node,
 * which only a pass already holding a checker result ever has.
 */

import ts from "typescript";

import { INSTANCE_METHOD_SEPARATOR } from "../../../../../infra/symbolid/index.js";

/** TypeScript joins namespaces and static members with a dot. */
export const TS_SCOPE_SEPARATOR = ".";

/**
 * What the passes need to know about one `(line, member)` coordinate: the call
 * node itself, and the receiver — kept as two slots because they are answers to
 * two questions and do not always come from the same node.
 *
 * `run(); helper.run();` is the shape that forces the split. Both calls sit on
 * one line under one member name; the bare one is what a signature question
 * resolves, and only the second has a receiver to type at all.
 */
export interface TSCallSiteEntry {
  /** First call on the line whose callee names `member`, whatever its shape. */
  readonly call: ts.CallExpression;
  /** Receiver of the first PROPERTY-ACCESS call among those, if any. */
  receiver: ts.Expression | null;
}

/** Every call site of one SourceFile, keyed `${startLine}:${member}`. */
type TSCallSiteIndex = Map<string, TSCallSiteEntry>;

/**
 * One index per SourceFile, discarded with it (bd tea-rags-mcp-skzu9).
 *
 * A `WeakMap` rather than a keyed cache because `TSProgramCache` already owns
 * SourceFile lifetime: it drops a file's parse when the file's mtime moves and
 * clears everything at a run boundary, so a re-parse yields a NEW SourceFile
 * object and the stale index becomes unreachable on its own. Keying by file NAME
 * would instead hand a changed file the previous revision's coordinates.
 */
const callSiteIndexes = new WeakMap<ts.SourceFile, TSCallSiteIndex>();

/** Rightmost identifier of a callee — `fetch` in `repo.fetch(…)`, `run` in `run(…)`. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return null;
}

/**
 * Index every call in the file by `(start line, member)`, first occurrence in
 * traversal order winning each slot.
 *
 * First-write-wins over a FULL pre-order walk is what makes this exactly the
 * answer the two finders used to compute by walking until their first match and
 * stopping. Pre-order visits a parent before its children, so in
 * `outer.run(inner.run())` the outer call claims the key before the inner one is
 * reached — the same node the old early-exit returned. The two slots fill
 * independently, which is what preserves the mixed-shape line.
 */
function buildCallSiteIndex(sourceFile: ts.SourceFile): TSCallSiteIndex {
  const index: TSCallSiteIndex = new Map();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = calleeName(node);
      if (member !== null) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const key = `${line}:${member}`;
        const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : null;
        const existing = index.get(key);
        if (existing === undefined) index.set(key, { call: node, receiver });
        else if (existing.receiver === null) existing.receiver = receiver;
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return index;
}

/**
 * The indexed call site at `(startLine, member)` — 1-based line, matching
 * `CallRef.startLine` — or `undefined` when the file has none.
 *
 * Both coordinates are matched because one line routinely holds several calls;
 * matching on the line alone would hand back a neighbour's node.
 *
 * The index exists because this question is asked about the same file thousands
 * of times in a run and the file never changes between them. The external guard
 * asks it, then passes 12, 13 and 14 each ask it again for the same call, and
 * `scripts/ts-codegraph-typechecker-oracle.ts` asks once more per call site — up
 * to five full walks of one SourceFile per call, where the answers were always
 * going to agree. Now the file is walked once and every later question is a map
 * lookup (bd tea-rags-mcp-skzu9).
 */
export function callSiteAt(sourceFile: ts.SourceFile, startLine: number, member: string): TSCallSiteEntry | undefined {
  let index = callSiteIndexes.get(sourceFile);
  if (index === undefined) {
    index = buildCallSiteIndex(sourceFile);
    callSiteIndexes.set(sourceFile, index);
  }
  return index.get(`${startLine}:${member}`);
}

/**
 * The RECEIVER expression of the call to `member` on `startLine` (1-based, to
 * match `CallRef.startLine`) — `x` in `x.process()`.
 *
 * Only a property access has a receiver at all: a bare `process()` yields `null`
 * rather than the enclosing expression.
 *
 * The two passes that need this are the two whose question is "what IS the
 * receiver": {@link TSStructuralTypingSymbolResolutionStrategy} asks the checker
 * for its apparent type and reads the member off that, and
 * `TSTypeCheckerUnionReceiverDispatchResolver` asks whether that type is a
 * union. They carried byte-identical copies through the epic's Wave 2 — one
 * returning the `PropertyAccessExpression` and the other its `.expression` —
 * which read like two helpers but was one, since neither ever used the access
 * node for anything but reaching that child (bd tea-rags-mcp-un8mv). Handing
 * back the receiver directly is what makes it honestly one function.
 *
 * Still not the same function as `findCallExpression` in
 * `./ts-type-checker-fallback.ts`, which matches BARE calls too and returns the
 * `CallExpression`, because its pass asks the checker to select a signature
 * rather than to type a receiver. What the two now share is the TRAVERSAL, via
 * {@link callSiteAt} — one walk answering both questions, which is honest
 * precisely because the index keeps their two answers in separate slots.
 */
export function findReceiverExpression(
  sourceFile: ts.SourceFile,
  startLine: number,
  member: string,
): ts.Expression | null {
  return callSiteAt(sourceFile, startLine, member)?.receiver ?? null;
}

/** `#` for instance members, `.` for `static` ones — the universal convention. */
export function memberSeparator(declaration: ts.Declaration): string {
  const isStatic = ts.canHaveModifiers(declaration)
    ? (ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    : false;
  return isStatic ? TS_SCOPE_SEPARATOR : INSTANCE_METHOD_SEPARATOR;
}

/** Prepend the enclosing `namespace` / `module` names, outermost first. */
export function prefixWithNamespaces(node: ts.Node, name: string): string {
  const scopes: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isModuleDeclaration(cursor) && ts.isIdentifier(cursor.name)) scopes.unshift(cursor.name.text);
    cursor = cursor.parent;
  }
  return scopes.length === 0 ? name : `${scopes.join(TS_SCOPE_SEPARATOR)}${TS_SCOPE_SEPARATOR}${name}`;
}

/**
 * The class or interface a declaration is a member of, or `null` for the
 * structural containers — an object literal, a type literal, a mapped type —
 * which is precisely the case that has no name to look up. An anonymous class
 * expression reaches the same `null` through its missing name.
 */
export function declarationOwnerName(declaration: ts.Declaration): string | null {
  const owner = declaration.parent as ts.Node | undefined;
  if (owner === undefined) return null;
  if (!ts.isClassLike(owner) && !ts.isInterfaceDeclaration(owner)) return null;
  return owner.name?.text ?? null;
}
