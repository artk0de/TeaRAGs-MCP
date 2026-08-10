/**
 * "Is this bare call's callee a value the enclosing scope was HANDED, rather
 * than a symbol the project declares?" (bd tea-rags-mcp-5tatv).
 *
 * `globalShortName` keys on the member name, and for a free call the member IS
 * the callee identifier. That is fine when the identifier names a project
 * function; it is a fabrication when the identifier names a local binding, and
 * the resolver had no way to tell the two apart. A destructured component prop
 * (`function Row({ onRemove }: Props)`), a hook's returned setter
 * (`const [date, setDate] = useState()`), a destructured handler
 * (`const { remove } = useFieldArray()`), a callback parameter — every one of
 * them reached pass 9 invisible:
 *
 *   - the walker's `localBindings` builder skips destructuring patterns outright
 *     (there is no single receiver name to bind, and the only type in reach
 *     belongs to the CONTAINER — `Props`, the hook's return — not to the member
 *     pulled out of it);
 *   - `TSLocalBindingSymbolResolutionStrategy` bails on `!call.receiver`, because
 *     it resolves `param.method()`, never bare `fn()`;
 *   - every arm of {@link targetsExternalImport} that could have spoken inspects
 *     a RECEIVER, and returns early when there is none.
 *
 * So pass 9 matched the bare name against the whole symbol table and committed
 * to whatever single project symbol shared it — `onRemove(attachment)` onto an
 * unrelated `Tooltip#onRemove`, `setDate(next)` onto a `TableFilters/helpers`
 * module. React is what turns this from a corner case into the dominant shape:
 * props destructuring and hook returns are the idiom, which is also why this
 * repo's own JSX-free corpus never surfaced it.
 *
 * The answer comes from the type checker rather than from a new walker channel
 * because the compiler already knows it exactly. Teaching the walker to record
 * destructured names would either record a type that is not the binding's (the
 * container's) or add a name-only channel across the `ChunkExtraction` /
 * `CallContext` contract and its NDJSON spill — a five-language surface for an
 * approximation, where `getSymbolAtLocation` gives the declaration itself. It is
 * the same trade bd tea-rags-mcp-335eu made one pass over for receivers.
 */

import ts from "typescript";

import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import { findCallExpression } from "./strategies/ts-type-checker-fallback.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/**
 * `true` when `call` is a BARE call whose callee identifier is declared by a
 * local value binding — a parameter, or a binding element of a destructuring
 * pattern. Both are, by construction, values supplied at runtime: nothing the
 * `GlobalSymbolTable` names can be their target, so a short-name match on them
 * is always fabricated.
 *
 * Deliberately NOT part of {@link targetsExternalImport}. That predicate answers
 * "does this call leave the project?", and these calls mostly do not — the
 * function a parent component passes as `onRemove` is usually project code we
 * simply cannot pin without dataflow. Declining the edge is a precision fix;
 * calling it external as well would move a genuine internal miss out of the
 * `resolveSuccessRate` denominator and pay for precision with a flattered
 * metric. The two questions stay separate because they have different answers.
 *
 * Three cheap gates come first, and the symbol-table one is the load-bearing
 * cost gate: with no project symbol of that name, neither short-name pass can
 * produce anything (`pickSingleCandidate` of an empty list, and pass 10 requires
 * N>1), so the verdict cannot change an edge and is not worth a Program for.
 * That is what keeps the checker off the overwhelming majority of bare calls.
 *
 * Returns `false` whenever the evidence is absent — no Program, no locatable
 * node, a callee that is not a plain identifier, an unresolved symbol. An import
 * reaches exactly that path and keeps resolving: `import { formatDate }` declares
 * an `ImportSpecifier`, which is not a local value binding, so a bare
 * `formatDate(value)` is untouched.
 */
export function calleeIsLocalValueBinding(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): boolean {
  if (call.receiver !== null) return false;
  if (ctx.symbolTable.lookupByShortName(call.member).length === 0) return false;
  return classifyLocalCallee(call, ctx, programCache) !== "notLocalBinding";
}

/**
 * `true` when the callee is a local value binding AND every call signature of
 * its type is declared outside the project — a hook RETURN, which is a different
 * animal from a prop callback (bd tea-rags-mcp-qdjfu).
 *
 * {@link calleeIsLocalValueBinding} declines the edge for both, and that is
 * right: neither can be pinned to a project symbol. But the two calls belong in
 * different METRIC buckets, and lumping them together is what this predicate
 * fixes. React's `useState` setter, `useFieldArray`'s `remove`, i18n's `t`, the
 * router's `navigate` are declared in `node_modules` / `@types`, so the value
 * behind the binding provably never reaches project code — counting them as
 * internal misses penalises the resolver for calls nothing could have resolved.
 * A destructured PROP is the opposite: the function the parent passes is usually
 * project code we cannot dataflow-trace, so it stays an honest internal miss.
 *
 * Deliberately NOT gated on the symbol table, which is the one place this
 * diverges from its sibling. There, the lookup is a pure COST gate — with no
 * project symbol of that name the short-name passes could not have produced an
 * edge, so the verdict could not matter. Here it would be a correctness bug: a
 * hook-returned `t()` leaves the project whether or not something in the repo
 * happens to be named `t`, and gating on a collision would reclassify only the
 * accidental subset.
 */
export function calleeIsExternalLocalBinding(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): boolean {
  return classifyLocalCallee(call, ctx, programCache) === "externalSignature";
}

/**
 * What the checker can say about a bare call's callee identifier, in one
 * traversal.
 *
 *   - `notLocalBinding` — no evidence, or the callee is something the project
 *     may declare. The edge stands and the call is nobody's business here.
 *   - `unresolvable` — a local value binding whose target cannot be pinned and
 *     may well be project code: an internal miss, honestly counted.
 *   - `externalSignature` — a local value binding whose call signatures are all
 *     declared outside the project: an external call.
 *
 * One function rather than two predicates because the evidence is the same walk
 * — locate the call node, resolve the callee symbol, read its declarations —
 * and running it twice would double the AST scan on the dominant call shape in
 * React code for an answer already in hand.
 */
type TSLocalCalleeBinding = "notLocalBinding" | "unresolvable" | "externalSignature";

function classifyLocalCallee(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): TSLocalCalleeBinding {
  if (programCache === null || call.receiver !== null || call.member.length === 0) return "notLocalBinding";
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return "notLocalBinding";
  const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null || !ts.isIdentifier(node.expression)) return "notLocalBinding";
  const declarations = handle.checker.getSymbolAtLocation(node.expression)?.getDeclarations() ?? [];
  if (declarations.length === 0 || !declarations.every(isLocalValueBinding)) return "notLocalBinding";
  return signaturesDeclaredOutsideProject(handle.checker, node.expression, programCache)
    ? "externalSignature"
    : "unresolvable";
}

/**
 * Is every call signature of the type at `callee` declared outside the project's
 * own sources?
 *
 * The question is asked of the SIGNATURES rather than of the type's symbol,
 * because a callable binding often has no useful symbol of its own: the type
 * behind `setDate` is the alias `Dispatch<SetStateAction<Date>>`, and what pins
 * it to React is the function-type node the alias expands to. Signatures point
 * straight at that node.
 *
 * Two answers mean "no evidence" rather than "external", for the reason every
 * arm of this guard family shares — it may only ever ADD an external verdict.
 * No signature at all is an untyped or `any` callee, where the checker knows
 * nothing; a signature with no declaration is synthetic, built by the checker
 * with no source behind it. Both leave the call an internal miss.
 *
 * `isProjectSourceFile`, NOT a non-null `toRelPath`: `node_modules` sits INSIDE
 * the repo root, so a dependency's `.d.ts` maps to a perfectly ordinary
 * `RelPath` and would read as project code — the trap bd tea-rags-mcp-otm6n
 * documented after five call sites were written against the opposite promise.
 * Under a repo-relative test this predicate would answer `false` for every
 * dependency there is, which is to say it would do nothing at all.
 */
function signaturesDeclaredOutsideProject(
  checker: ts.TypeChecker,
  callee: ts.Identifier,
  programCache: TSProgramCache,
): boolean {
  const signatures = checker.getTypeAtLocation(callee).getCallSignatures();
  if (signatures.length === 0) return false;
  return signatures.every((signature) => {
    const { declaration } = signature;
    return declaration !== undefined && !programCache.isProjectSourceFile(declaration.getSourceFile().fileName);
  });
}

/**
 * A parameter, or an element of a destructuring pattern — the two declaration
 * kinds that bind a name to a value the scope receives.
 *
 * EVERY declaration of the symbol must be one of them, which is what makes a
 * merged declaration (a name that is also a project function elsewhere in the
 * file) keep its edge rather than lose it to one local shadow.
 */
function isLocalValueBinding(declaration: ts.Declaration): boolean {
  return ts.isParameter(declaration) || ts.isBindingElement(declaration);
}
