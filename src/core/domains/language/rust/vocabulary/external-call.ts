/**
 * The Rust answer to the facade's `targetsExternalImport` — the miss
 * classifier's first gate (`.claude/rules/resolver-architecture.md`; Python's
 * `PythonExternalVocabulary` is the pilot this follows). A `true` verdict
 * removes the call from the resolve-rate denominator, so every arm is PROOF,
 * never absence: a std-prelude or external-crate reading wins only when a
 * `use` binding, a reserved name or a declared type carries it, and a project
 * definition of the same name vetoes the std reading — a corpus that declares
 * its own `String` keeps its `String::new()` misses.
 *
 * A std-typed site is terminal only while the project cannot reach the member
 * on that type (bd tea-rags-mcp-s3i8m.3): an extension-trait impl for the std
 * type (`impl MyExt for Vec<u8>`), a project trait whose provided method the
 * type may carry, or a blanket impl keeps the call in the denominator.
 */

import {
  resolveLocalBinding,
  type CallContext,
  type CallRef,
  type LocalBinding,
  type SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import {
  lookupRustSymbolsByShortName,
  parseRustImportPath,
  rustCalleeShortNameCandidates,
  rustImportBindings,
  rustImportIsExternal,
} from "../resolver/strategies/shared.js";
import {
  rustTextIsDerivableTraitMember,
  rustTextIsStdMacro,
  rustTextIsStdPathHead,
  rustTextIsStdPreludeType,
  rustTextIsStdPreludeVariant,
  rustTextIsStdSmartPointer,
  rustTextIsStdTrait,
  rustTextIsStdType,
} from "./std-prelude.js";

/** The receiver text names a project file, type or macro — any in-project definition vetoes a std reading. */
function projectDeclares(ctx: CallContext, name: string): boolean {
  return lookupRustSymbolsByShortName(ctx, name).length > 0;
}

/**
 * The walker names an `impl` block's chunk after its implementing type
 * (`impl Sink for Box<S>` → `Box`) with no symbol kind. It is no declaration:
 * a file whose declaration facts the run holds and that declares no such type
 * proves the row an impl container. Without the facts the row stays unproven.
 */
function isRustImplContainer(def: SymbolDefinition, ctx: CallContext): boolean {
  if (def.symbolKind !== undefined || ctx.typeDeclarations === undefined) return false;
  const facts = ctx.typeDeclarations[def.relPath] ?? [];
  return !facts.some((fact) => fact.typeId === def.symbolId);
}

const RUST_NOMINAL_KINDS: ReadonlySet<string> = new Set(["class", "enum", "type_alias"]);

/** A project declaration of the type name — a struct, enum, trait, alias or module, never an impl block. */
function projectDeclaresType(ctx: CallContext, name: string): boolean {
  return lookupRustSymbolsByShortName(ctx, name).some(
    (def) => def.symbolKind !== "method" && def.symbolKind !== "function" && !isRustImplContainer(def, ctx),
  );
}

type RustOwnerKind = "nominal" | "module" | "trait" | "unknown";

/** What a member's owner is in the project; anything not proven a struct / enum / module reads `unknown`. */
function rustOwnerKind(ctx: CallContext, owner: string): RustOwnerKind {
  const defs = lookupRustSymbolsByShortName(ctx, owner);
  if (defs.some((def) => def.symbolKind === "interface")) return "trait";
  if (defs.some((def) => def.symbolKind !== undefined && RUST_NOMINAL_KINDS.has(def.symbolKind))) return "nominal";
  if (defs.some((def) => def.symbolKind === "module")) return "module";
  return "unknown";
}

/** The project holds an `impl … for <typeName>` block. */
function projectImplementsFor(ctx: CallContext, typeName: string): boolean {
  return lookupRustSymbolsByShortName(ctx, typeName).some((def) => isRustImplContainer(def, ctx));
}

/**
 * Whether a project definition of `member` can be what a call on `typeName`
 * reaches: one owned by the type itself (an impl for it), a trait's provided
 * method the type may implement, or an owner no project type declares — an
 * impl for another std type the receiver derefs to, or a blanket impl over a
 * generic parameter. A member only a project struct / enum / module owns
 * cannot be called on a std type.
 */
function projectMemberReaches(ctx: CallContext, typeName: string, member: string, style: "path" | "method"): boolean {
  for (const def of rustCalleeShortNameCandidates(ctx, member)) {
    const owner = def.scope.at(-1);
    if (owner === undefined) continue;
    // A project struct that merely shares the name (`Error` vs `std::io::Error`)
    // owns its own members; only an impl block FOR the std type reaches it.
    const kind = rustOwnerKind(ctx, owner);
    if (kind === "nominal" || kind === "module") continue;
    if (owner === typeName) return true;
    if (kind === "trait") {
      if (style === "method" || projectImplementsFor(ctx, typeName)) return true;
      continue;
    }
    if (style === "method" || !rustTextIsStdType(owner)) return true;
  }
  return false;
}

/** A std type's member is external unless the project shadows the type or can reach the member on it. */
function stdTypeMemberIsExternal(
  ctx: CallContext,
  typeName: string,
  member: string,
  style: "path" | "method",
): boolean {
  return !projectDeclaresType(ctx, typeName) && !projectMemberReaches(ctx, typeName, member, style);
}

/**
 * A project type's derived std-trait member — `#[derive(Default)]` then
 * `Region::default()`. No hand-written body exists anywhere in the project,
 * the type implements no `Deref` that could forward the call, and no trait or
 * blanket owner of the member reaches it: the target is generated code.
 */
function derivedMemberIsExternal(ctx: CallContext, typeName: string, member: string): boolean {
  if (!rustTextIsDerivableTraitMember(member) || !projectDeclaresType(ctx, typeName)) return false;
  const ownsMember = (name: string) =>
    lookupRustSymbolsByShortName(ctx, name).some((def) =>
      ["#", "."].some((sep) => {
        const own = `${typeName}${sep}${name}`;
        return def.symbolId === own || def.symbolId.endsWith(`::${own}`);
      }),
    );
  if (ownsMember(member) || ownsMember("deref")) return false;
  return !projectMemberReaches(ctx, typeName, member, "method");
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
 * Whether a binding's nominal type name PROVES an external target: a std
 * trait, or a name an external import binds. A project definition of the
 * same name vetoes the std reading.
 */
function typeNameIsExternal(name: string, ctx: CallContext): boolean {
  if (name.length === 0) return false;
  if (rustTextIsStdTrait(name) && !projectDeclares(ctx, name)) return true;
  return ctx.imports.some((imp) => {
    const bindings = rustImportBindings(imp.importText);
    return (
      bindings?.some((binding) => binding.localName === name && !binding.globImport) === true &&
      rustImportIsExternal(imp.importText, ctx, name)
    );
  });
}

/**
 * The type a receiver's own binding names, smart pointers unwrapped to their
 * single argument (Rust auto-derefs `Box<T>` to `T`). `null` when the binding
 * names no single type (a generic bound, a pointer without its argument).
 */
function bindingReceiverType(binding: LocalBinding): string | null {
  const ref = binding.typeRef;
  if (ref !== undefined) {
    if (ref.form !== "instance" || ref.upperBound === true) return null;
    if (!rustTextIsStdSmartPointer(ref.name)) return ref.name;
    const inner = ref.args?.length === 1 ? ref.args[0] : undefined;
    return inner?.form === "instance" ? inner.name : null;
  }
  const name = bindingTypeName(binding.type);
  return name.length === 0 || rustTextIsStdSmartPointer(name) ? null : name;
}

const RUST_CAP_WORDS = /^[A-Z][A-Za-z0-9_]*$/;

export class RustExternalVocabulary {
  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver === null) return this.bareCalleeIsExternal(call, ctx);
    return this.receiverIsExternal(call, ctx);
  }

  /**
   * A receiver bound by an external import is external; an UNBOUND receiver
   * is external only when the prelude spells it (`String::new()` carries no
   * `use`) or a std path spells it (`std::env::current_dir()`), and no
   * project definition shares the name. A receiver bound by a project import,
   * or spelled by nothing we can prove, is never external.
   */
  private receiverIsExternal(call: CallRef, ctx: CallContext): boolean {
    const { receiver, member } = call;
    if (receiver === null) return false;
    if (isRustLiteralReceiver(receiver) && !projectDeclares(ctx, member)) return true;
    const path = receiver.replace(/^::/, "").split("::");
    const head = path[0] ?? receiver;
    if (path.length > 1 && rustTextIsStdPathHead(head)) {
      // `std::path::PathBuf::from` names a std type; `std::env::current_dir` a std module function.
      const typeName = path.at(-1) ?? "";
      return !RUST_CAP_WORDS.test(typeName) || !projectMemberReaches(ctx, typeName, member, "path");
    }
    for (const imp of ctx.imports) {
      const parsed = parseRustImportPath(imp.importText, head);
      if (parsed?.receiverMatches && rustImportIsExternal(imp.importText, ctx, head)) return true;
    }
    // `Region::default()` on a project type (imported or not) whose Default is derived.
    if (path.length === 1 && call.callText.startsWith(`${receiver}::`)) {
      const typeName = receiver === "Self" ? ctx.callerScope.at(-1) : receiver;
      if (typeName !== undefined && derivedMemberIsExternal(ctx, typeName, member)) return true;
    }
    const bound = ctx.imports.some((imp) => parseRustImportPath(imp.importText, head)?.receiverMatches);
    if (bound) return false;
    if (path.length === 1 && rustTextIsStdPreludeType(head)) {
      return stdTypeMemberIsExternal(ctx, head, member, "path");
    }
    if (rustTextIsStdPreludeType(head) || rustTextIsStdTrait(head)) return !projectDeclares(ctx, head);
    // The receiver's local binding names its type — `cx: &JSContext` makes
    // every `cx.…` call external however the chain declines it. Only the
    // call's own head binding answers; a chain head is the fold's evidence.
    const dotHead = receiver.split(".")[0] ?? receiver;
    if (dotHead !== receiver) return false;
    const binding = resolveLocalBinding(ctx.localBindings, dotHead, call.startLine);
    if (binding === undefined) return false;
    const typeName = bindingReceiverType(binding);
    if (typeName === null) return false;
    if (rustTextIsStdType(typeName)) return stdTypeMemberIsExternal(ctx, typeName, member, "method");
    if (binding.typeRef === undefined && typeNameIsExternal(typeName, ctx)) return true;
    return derivedMemberIsExternal(ctx, typeName, member);
  }

  /**
   * A bare call is external when the name is bound by an external import,
   * when it is a std macro invocation the project does not define
   * (`vec![]` — the walker emits the macro name as the member), or when it
   * is a prelude variant constructor (`Ok(())`, `Some(x)`).
   */
  private bareCalleeIsExternal(call: CallRef, ctx: CallContext): boolean {
    for (const imp of ctx.imports) {
      const bindings = rustImportBindings(imp.importText);
      if (bindings?.some((binding) => binding.localName === call.member && !binding.globImport)) {
        if (rustImportIsExternal(imp.importText, ctx, call.member)) return true;
        return false;
      }
    }
    const macroCall = call.callText.startsWith(`${call.member}!`);
    if (macroCall && rustTextIsStdMacro(call.member) && !projectDeclares(ctx, call.member)) return true;
    if (rustTextIsStdPreludeVariant(call.member) && !projectDeclares(ctx, call.member)) return true;
    return false;
  }
}
