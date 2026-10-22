/**
 * The Rust answer to the facade's `targetsExternalImport` — the miss
 * classifier's first gate (`.claude/rules/resolver-architecture.md`; Python's
 * `PythonExternalVocabulary` is the pilot this follows). A `true` verdict
 * removes the call from the resolve-rate denominator, so every arm is PROOF,
 * never absence: a std-prelude or external-crate reading wins only when a
 * `use` binding or a reserved name carries it, and a project definition of
 * the same name vetoes the std reading — a corpus that declares its own
 * `String` keeps its `String::new()` misses.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import { resolveLocalBinding, type CallContext, type CallRef } from "../../../../contracts/types/codegraph.js";
import { rustStdTerminalTargetsExternal } from "../resolver/std-type-hops.js";
import { rustReceiverChainType } from "../resolver/strategies/rust-type-receiver.js";
import {
  lookupRustSymbolsByShortName,
  parseRustImportPath,
  rustCallIsMacroInvocation,
  rustImportBindings,
  rustImportIsExternal,
  rustMacroPathIsExternal,
  rustMacroShortNameCandidates,
} from "../resolver/strategies/shared.js";
import {
  rustTextIsStdMacro,
  rustTextIsStdPreludeType,
  rustTextIsStdPreludeVariant,
  rustTextIsStdTrait,
} from "./std-prelude.js";

/** The receiver text names a project file or type — any in-project definition vetoes a std reading. */
function projectDeclares(ctx: CallContext, name: string): boolean {
  return lookupRustSymbolsByShortName(ctx, name).length > 0;
}

/**
 * A literal-headed receiver (`10`, `"fmt"`, `'x'`, `true`): its static type is
 * a primitive, and coherence forbids a project inherent impl on one. The call
 * is std unless the project implements a trait for the primitive — and that
 * trait method IS an in-project definition, which vetoes the reading.
 */
const RUST_LITERAL_HEAD = /^["']|^\d|^(?:true|false)$/;

function isRustLiteralReceiver(receiver: string): boolean {
  return RUST_LITERAL_HEAD.test(receiver);
}

/** The declared type spelling a binding carries, stripped to its nominal head (`&mut Vec<T>` → `Vec`). */
function bindingTypeName(type: string): string {
  return type
    .replace(/^[&*]+\s*(?:mut\s+)?/, "")
    .split("<")[0]
    .trim();
}

/**
 * Whether a binding's nominal type name PROVES an external target: a prelude
 * type, a std trait, or a name an external import binds. A project
 * definition of the same name vetoes the std readings.
 */
function typeNameIsExternal(name: string, ctx: CallContext): boolean {
  if (name.length === 0) return false;
  if ((rustTextIsStdPreludeType(name) || rustTextIsStdTrait(name)) && !projectDeclares(ctx, name)) return true;
  return ctx.imports.some((imp) => {
    const bindings = rustImportBindings(imp.importText);
    return (
      bindings?.some((binding) => binding.localName === name && !binding.globImport) === true &&
      rustImportIsExternal(imp.importText, ctx)
    );
  });
}

/**
 * A dotted receiver the chain fold types (bd tea-rags-mcp-2g2og.24): the fold
 * ends on a std type (`self.items: Vec<_>` → `Vec`) and the project
 * implements no such member on it, or its last hop is a field of a same-file
 * owner whose declared type an external import binds (`re: Regex` with
 * `use regex::Regex`). Every hop is the fold's declared evidence — an untyped
 * hop proves nothing and stays in the denominator.
 */
function chainTerminalIsExternal(call: CallRef, ctx: CallContext): boolean {
  const typed = rustReceiverChainType(call, ctx);
  if (typed !== undefined) return rustStdTerminalTargetsExternal(typed, call.member, ctx);
  const receiver = call.receiver?.replace(/\s+/g, "") ?? "";
  const lastDot = receiver.lastIndexOf(".");
  const field = receiver.slice(lastDot + 1);
  if (lastDot <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return false;
  const owner = rustReceiverChainType({ ...call, receiver: receiver.slice(0, lastDot) }, ctx);
  if (owner?.form !== "instance" || !owner.name.startsWith(`${ctx.callerFile}::`)) return false;
  const fieldTypeName = identifierEntry(identifierEntry(ctx.classFieldTypesByClassKey, owner.name), field);
  if (fieldTypeName === undefined || !typeNameIsExternal(bindingTypeName(fieldTypeName), ctx)) return false;
  return rustStdTerminalTargetsExternal({ form: "instance", name: fieldTypeName }, call.member, ctx);
}

export class RustExternalVocabulary {
  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    if (rustCallIsMacroInvocation(call)) return this.macroIsExternal(call, ctx);
    if (call.receiver === null) return this.bareCalleeIsExternal(call, ctx);
    return this.receiverIsExternal(call, ctx);
  }

  /**
   * A macro invocation is judged in the macro namespace (bd
   * tea-rags-mcp-s3i8m.2) — `format!` can never name `fn format`, so only a
   * project MACRO of the name vetoes the std reading. A path invocation is
   * external when its head is std or a crate the project does not hold
   * (`std::println!`, `log::debug!`); a bare one when an external `use` binds
   * it, or when std spells it and no `use` binds it to the project.
   */
  private macroIsExternal(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver !== null) {
      const head = call.receiver.split("::")[0] ?? call.receiver;
      return rustMacroPathIsExternal(head, rustMacroShortNameCandidates(ctx, call.member), ctx);
    }
    const binding = this.importBinding(call.member, ctx);
    if (binding !== undefined) return rustImportIsExternal(binding, ctx);
    return rustTextIsStdMacro(call.member) && rustMacroShortNameCandidates(ctx, call.member).length === 0;
  }

  /** The import text of the first non-glob `use` binding `name`, if any. */
  private importBinding(name: string, ctx: CallContext): string | undefined {
    return ctx.imports.find((imp) =>
      rustImportBindings(imp.importText)?.some((binding) => binding.localName === name && !binding.globImport),
    )?.importText;
  }

  /**
   * A receiver bound by an external import is external; an UNBOUND receiver
   * is external only when the prelude spells it (`String::new()` carries no
   * `use`) and no project definition shares the name. A receiver bound by a
   * project import, or spelled by nothing we can prove, is never external.
   */
  private receiverIsExternal(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null) return false;
    if (isRustLiteralReceiver(receiver) && !projectDeclares(ctx, call.member)) return true;
    const head = receiver.split("::")[0] ?? receiver;
    for (const imp of ctx.imports) {
      const parsed = parseRustImportPath(imp.importText, head);
      if (parsed?.receiverMatches && rustImportIsExternal(imp.importText, ctx)) return true;
    }
    const bound = ctx.imports.some((imp) => parseRustImportPath(imp.importText, head)?.receiverMatches);
    if (bound) return false;
    if (rustTextIsStdPreludeType(head) || rustTextIsStdTrait(head)) return !projectDeclares(ctx, head);
    // The receiver's local binding names an external type — `cx: &JSContext`
    // makes every `cx.…` call external however the chain declines it. Only
    // the call's own head binding answers; a chain head is the fold's evidence.
    const dotHead = receiver.split(".")[0] ?? receiver;
    if (dotHead !== receiver) return chainTerminalIsExternal(call, ctx);
    const binding = resolveLocalBinding(ctx.localBindings, dotHead, call.startLine);
    const typeName = binding?.typeRef === undefined ? binding?.type : undefined;
    return typeName !== undefined && typeNameIsExternal(bindingTypeName(typeName), ctx);
  }

  /**
   * A bare call is external when the name is bound by an external import,
   * or when it is a prelude variant constructor (`Ok(())`, `Some(x)`). Macro
   * invocations never reach here — {@link macroIsExternal} owns them.
   */
  private bareCalleeIsExternal(call: CallRef, ctx: CallContext): boolean {
    const binding = this.importBinding(call.member, ctx);
    if (binding !== undefined) return rustImportIsExternal(binding, ctx);
    return rustTextIsStdPreludeVariant(call.member) && !projectDeclares(ctx, call.member);
  }
}
