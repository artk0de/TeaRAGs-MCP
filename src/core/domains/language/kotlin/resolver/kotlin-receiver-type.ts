/**
 * Type of a receiver the walker already recorded in this file.
 *
 * A bare name is a local or parameter (`ctx.localBindings`), then a property
 * of the enclosing type (`ctx.classFieldTypes`), walking outward through
 * nested types. `this.field` is that property. `this` itself, a label
 * (`this@Outer`), and any longer chain stay untyped: this pass does not
 * invent a type.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";

export function kotlinReceiverType(
  call: { receiver: string; startLine: number; startColumn?: number },
  ctx: CallContext,
): TypeRef | null {
  const { receiver } = call;
  if (receiver.length === 0 || receiver === "this" || receiver.includes("@")) return null;
  if (receiver.startsWith("this.")) {
    const field = receiver.slice("this.".length);
    if (field.length === 0 || field.includes(".")) return null;
    const typeName = fieldType(ctx, field);
    return typeName === undefined ? null : { form: "instance", name: typeName };
  }
  if (receiver.includes(".")) return null;
  const local = resolveLocalBinding(ctx.localBindings, receiver, call.startLine, call.startColumn);
  if (local !== undefined && local.type.length > 0) return { form: "instance", name: local.type };
  const typeName = fieldType(ctx, receiver);
  return typeName === undefined ? null : { form: "instance", name: typeName };
}

function fieldType(ctx: CallContext, name: string): string | undefined {
  for (let depth = ctx.callerScope.length; depth > 0; depth--) {
    const key = ctx.callerScope.slice(0, depth).join(".");
    const typeName = identifierEntry(identifierEntry(ctx.classFieldTypes, key), name);
    if (typeName !== undefined && typeName.length > 0) return typeName;
  }
  return undefined;
}
