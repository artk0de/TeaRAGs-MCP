/**
 * Go's ports into the kernel receiver fold (`kernel/receiver-type-propagation.ts`)
 * — what lets `c.writermem.reset(w)` type its receiver hop by hop (bd
 * tea-rags-mcp-e6xx): `c` from the local binding, `writermem` from `Context`'s
 * field declaration, and the call lands on `responseWriter#reset`.
 *
 *   - `singleHopType` — a plain identifier, typed exactly as the two binding
 *     passes type it: the local `goLocalAt` finds in scope — a value binding
 *     (an empty one is untyped), or a call binding typed through its callee's
 *     declared return type behind the same known-type gate. Anything else
 *     (`f()`, `xs[i]`) is untyped.
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
 * Built ONCE per resolver (the composer is the only thing it closes over) and
 * frozen, so the fold allocates nothing per call site.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer, TypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  splitReceiverHops,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import { goLocalAt } from "../local-scope.js";
import { goCallResultType } from "./strategies/shared.js";
import { selectGoMember } from "./struct-member-selection.js";

const GO_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function instanceOf(name: string): TypeRef {
  return { form: "instance", name };
}

function goIdentifierType(receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined {
  if (!GO_IDENTIFIER.test(receiver)) return undefined;
  // The local in scope speaks for the name even when its type is EMPTY — a
  // value no pass can type, shadowing any earlier binding of the name.
  const local = goLocalAt(ctx, receiver, atLine);
  if (local === undefined) return undefined;
  if (local.kind === "value") return local.binding.type ? instanceOf(local.binding.type) : undefined;
  const returnType = goCallResultType(local.callee, ctx);
  return returnType ? instanceOf(returnType) : undefined;
}

export function createGoReceiverTypePorts(composer: SymbolIdComposer): ReceiverTypePorts {
  return Object.freeze({
    singleHopType: goIdentifierType,
    seedHead: () => undefined,
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined => {
      if (recv.form !== "instance") return undefined;
      const selected = selectGoMember(recv.name, member, ctx, composer);
      return selected?.kind === "field" && selected.type !== "" ? instanceOf(selected.type) : undefined;
    },
    maxHops: () => CHAIN_MAX_HOPS_DEFAULT,
    splitReceiverHops,
  });
}
