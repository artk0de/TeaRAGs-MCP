/**
 * Java's receiver typing port for the reusable kernel receiver fold.
 *
 * Java's walker already publishes position-aware local bindings and
 * class-field types. This adapter turns those facts into nominal `TypeRef`s;
 * the kernel owns the typed-receiver strategy and miss verdict.
 */
import { identifierEntry } from "../../../../contracts/identifier-record.js";
import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../kernel/index.js";

const JAVA_RECEIVER_TYPE_PORTS: ReceiverTypePorts = {
  singleHopType: (receiver, atLine, ctx, atColumn) => {
    const local = resolveLocalBinding(ctx.localBindings, receiver, atLine, atColumn);
    if (local !== undefined && local.type.length > 0) {
      return nominalType(local.type, local.valueKind === "class" ? "class" : "instance");
    }
    return undefined;
  },
  seedHead: () => undefined,
  memberTypeOf: () => undefined,
  maxHops: () => 0,
  splitReceiverHops: (receiver) => [receiver],
};

export const JAVA_LOCAL_RECEIVER_TYPE_PORTS = JAVA_RECEIVER_TYPE_PORTS;

export function javaLocalReceiverType(
  call: { receiver: string; startLine: number; startColumn?: number },
  ctx: CallContext,
): TypeRef | undefined {
  return propagateReceiverType(call.receiver, call.startLine, ctx, JAVA_LOCAL_RECEIVER_TYPE_PORTS, call.startColumn);
}

export const JAVA_FIELD_RECEIVER_TYPE_PORTS: ReceiverTypePorts = {
  ...JAVA_RECEIVER_TYPE_PORTS,
  singleHopType: (receiver, _atLine, ctx) => {
    if (!receiver.startsWith("this.") || ctx.callerScope.length === 0) return undefined;
    const field = receiver.slice("this.".length);
    if (field.includes(".")) return undefined;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = identifierEntry(identifierEntry(ctx.classFieldTypes, enclosing), field);
    return typeName === undefined ? undefined : nominalType(typeName, "instance");
  },
};

export function javaFieldReceiverType(
  call: { receiver: string; startLine: number; startColumn?: number },
  ctx: CallContext,
): TypeRef | undefined {
  return propagateReceiverType(call.receiver, call.startLine, ctx, JAVA_FIELD_RECEIVER_TYPE_PORTS, call.startColumn);
}

function nominalType(name: string, form: "class" | "instance"): TypeRef {
  return { form, name };
}
