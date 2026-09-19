/**
 * Go's ports into the kernel receiver fold (`kernel/receiver-type-propagation.ts`)
 * — what lets `c.writermem.reset(w)` type its receiver hop by hop (bd
 * tea-rags-mcp-e6xx): `c` from the local binding, `writermem` from `Context`'s
 * field declaration, and the call lands on `responseWriter#reset`.
 *
 *   - `singleHopType` — a plain identifier, typed exactly as the two binding
 *     passes type it: the local `goLocalAt` finds in scope — a value binding
 *     (an empty one is untyped), or a call binding typed through its callee's
 *     declared return type behind the same known-type gate. A bare call's
 *     result (`engine()`) is typed the same way, through the declaration it
 *     calls in the caller's own or a dot-imported package. Anything else
 *     (`xs[i]`, `f(a)(b)`) is untyped.
 *   - `seedHead` — none. A Go chain head is a value or a package, and a package
 *     is the import pass's business.
 *   - `memberTypeOf` — a FIELD hop only, read through `selectGoMember`, so a
 *     field promoted from an embedded struct types too and an opaque type stops
 *     the walk. A method hop answers nothing: the fold strips the call's
 *     arguments, and Go forbids a field and a method sharing a name, so a
 *     selected method is always a call whose result this port does not type.
 *   - `splitReceiverHops` — the bracket-aware scan, so the dots inside
 *     `template.New("").Delims(r.Delims.Left, …)` are not hops.
 *
 * A head typed through a declared function's result is PLACED in the package
 * that declares its type (G2-4) and crosses the fold as `goProjectTypeRef`
 * spells it, so the first member lookup stays in that package; a local's
 * declared type and every field hop's type cross unplaced (package-blind).
 *
 * Built ONCE per resolver (it closes over the resolver's config — the composer,
 * and the module map a package-qualified return type is checked against) and
 * frozen, so the fold allocates nothing per call site.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  splitReceiverHops,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import { goLocalAt } from "../local-scope.js";
import { goProjectTypeOfRefName, goProjectTypeRef } from "./go-project-type.js";
import { goCallResultType, type ResolverConfig } from "./strategies/shared.js";
import { selectGoMember } from "./struct-member-selection.js";

const GO_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const GO_IDENTIFIER_PREFIX = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** A type the resolver could not place in a package: a local's declared type, a struct field's. */
function unplacedTypeRef(typeName: string): TypeRef {
  return goProjectTypeRef({ typeName });
}

/**
 * The callee of a receiver that is ONE call of a bare identifier — `engine()`,
 * `load(cfg, "x")` → `engine` / `load` — else `undefined`: the argument list
 * must open right after the name and close at the receiver's last character,
 * so `f(a)(b)` (calling a call's result) and `f(a).x` are not one.
 */
export function goBareCallHead(receiver: string): string | undefined {
  const name = GO_IDENTIFIER_PREFIX.exec(receiver)?.[0];
  if (name === undefined || receiver[name.length] !== "(" || !receiver.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = name.length; i < receiver.length; i++) {
    const ch = receiver[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === receiver.length - 1 ? name : undefined;
  }
  return undefined;
}

/**
 * The type a bare call's result holds (bd tea-rags-mcp-e6xx): the callee's
 * recorded return type (`functionReturnTypes` — a declared function's, or what
 * calling a package-level func-valued var yields, like gin's
 * `var engine = sync.OnceValue(func() *gin.Engine {…})`), read exactly as a
 * call-bound local's is (`goCallResultType`): a bare call names the caller's
 * own package or a dot-imported one, never a local function value in scope nor
 * a namesake declared only elsewhere, and its result type counts only as a
 * project type of the callee's package.
 */
function goBareCallResultType(
  cfg: ResolverConfig,
  callee: string,
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  const returnType = goCallResultType(callee, cfg, ctx, atLine);
  return returnType ? goProjectTypeRef(returnType) : undefined;
}

function goIdentifierType(
  cfg: ResolverConfig,
  receiver: string,
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  const callee = goBareCallHead(receiver);
  if (callee !== undefined) return goBareCallResultType(cfg, callee, atLine, ctx);
  if (!GO_IDENTIFIER.test(receiver)) return undefined;
  // The local in scope speaks for the name even when its type is EMPTY — a
  // value no pass can type, shadowing any earlier binding of the name.
  const local = goLocalAt(ctx, receiver, atLine);
  if (local === undefined) return undefined;
  if (local.kind === "value") return local.binding.type ? unplacedTypeRef(local.binding.type) : undefined;
  const returnType = goCallResultType(local.callee, cfg, ctx, local.line ?? atLine);
  return returnType ? goProjectTypeRef(returnType) : undefined;
}

export function createGoReceiverTypePorts(cfg: ResolverConfig): ReceiverTypePorts {
  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      goIdentifierType(cfg, receiver, atLine, ctx),
    seedHead: () => undefined,
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined => {
      if (recv.form !== "instance") return undefined;
      const selected = selectGoMember(goProjectTypeOfRefName(recv.name), member, ctx, cfg.composer);
      return selected?.kind === "field" && selected.type !== "" ? unplacedTypeRef(selected.type) : undefined;
    },
    maxHops: () => CHAIN_MAX_HOPS_DEFAULT,
    splitReceiverHops,
  });
}
