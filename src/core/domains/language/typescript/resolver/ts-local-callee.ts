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
  if (programCache === null || call.receiver !== null || call.member.length === 0) return false;
  if (ctx.symbolTable.lookupByShortName(call.member).length === 0) return false;
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return false;
  const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null || !ts.isIdentifier(node.expression)) return false;
  const declarations = handle.checker.getSymbolAtLocation(node.expression)?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(isLocalValueBinding);
}

/**
 * A parameter, or an element of a destructuring pattern — the two declaration
 * kinds that bind a name to a value the scope receives.
 *
 * EVERY declaration of the symbol must be one of them, which is what makes a
 * merged declaration (a name that is also a project function elsewhere in the
 * file) keep its edge rather than lose it to one local shadow.
 *
 * Shared with `./ts-local-receiver.ts` (bd tea-rags-mcp-z0zqd), which asks the
 * same question of the RECEIVER identifier. One definition, because "which
 * declaration kinds bind a name to a value the scope receives" has one answer —
 * the two guards differ in what they do with it, not in how they recognise it.
 */
export function isLocalValueBinding(declaration: ts.Declaration): boolean {
  return ts.isParameter(declaration) || ts.isBindingElement(declaration);
}
