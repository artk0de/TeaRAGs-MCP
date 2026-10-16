import { resolveLocalBinding, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  ChainTypeSymbolResolutionStrategy,
  propagateReceiverType,
  type ReceiverTypePorts,
  type ReceiverTypingPorts,
} from "../../../kernel/index.js";
import { isCapWordsType, isRustConstructorAssocFn } from "../../associated-constructor.js";
import { rustDeclaredFieldType, rustLexicalSelfType } from "../declared-field-type.js";
import { resolveRustNominalType, rustDeclaredMemberReturnType } from "../declared-return-type.js";
import { createRustTypeMemberLookup } from "../rust-type-member-lookup.js";
import { lookupRustSymbolsByShortName, rustImportMatchesReceiver, type ResolverConfig } from "./shared.js";

/** Import roots that are never this project's code. */
const STD_IMPORT_ROOT = /^(::)?(std|core|alloc)::/;
const RUST_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * bd tea-rags-mcp-7266 — a receiver that statically NAMES a type:
 *
 *   - a type path, `Parser::new()` / `Self::helper()` — the receiver is the
 *     type (`Self` is the enclosing impl's);
 *   - a constructor's result, `Parser::new().parse(args)` — one associated
 *     constructor call (`isRustConstructorAssocFn`), typed the way the walker
 *     types `let p = Parser::new();`.
 *
 * Once the type is an in-project one the call is owned, exactly like
 * `localBinding`: the type's own member resolves (instance `#` then associated
 * `.`, the same-file declaration first, bd tea-rags-mcp-p8wz), and a member the
 * type does not declare DROPS — a derived / trait-provided `LowArgs::default()`
 * must not fall to a sole `default` on an unrelated type (the c5by garbage).
 *
 * The pass CONTINUEs, leaving the call exactly as the chain treated it before,
 * when the receiver is not one of those shapes, when the project declares no
 * type of that name, and when a `use` import binds the name to std / core /
 * alloc (`use std::io::Error;` next to an in-project `Error`). A CapWords
 * VALUE receiver (`P.get_or_init()` on a `static P`) is not a type path: the
 * call text must spell `Receiver::member`, which only a scoped path does.
 */
const RUST_RECEIVER_TYPE_PORTS: ReceiverTypePorts = {
  singleHopType: (receiver, atLine, ctx) => {
    const binding = resolveLocalBinding(ctx.localBindings, receiver, atLine);
    const local = binding?.typeRef ?? (binding?.type ? { form: "instance" as const, name: binding.type } : undefined);
    if (local !== undefined) return resolveRustNominalType(local, ctx);
    if (receiver === "self") return rustLexicalSelfType(ctx);
    const named = rustNamedType(receiver, ctx);
    if (named === undefined) return undefined;
    const exact = resolveRustNominalType(named, ctx);
    if (exact === undefined) return undefined;
    const constructor = constructorCallHead(receiver);
    return constructor === undefined
      ? { ...exact, form: "class" }
      : rustDeclaredMemberReturnType({ ...exact, form: "class" }, constructor.assocFn, ctx);
  },
  seedHead: () => undefined,
  memberTypeOf: rustDeclaredMemberReturnType,
  memberAttributeTypeOf: rustDeclaredFieldType,
  maxHops: () => 8,
};

export function rustReceiverChainType(call: CallRef, ctx: CallContext): TypeRef | undefined {
  return call.receiver === null
    ? undefined
    : propagateReceiverType(call.receiver, call.startLine, ctx, RUST_RECEIVER_TYPE_PORTS, call.startColumn);
}

const RUST_TYPE_RECEIVER_TYPING: ReceiverTypingPorts = {
  typeOfReceiver: (call, ctx) => {
    // A CapWords receiver with dot syntax may be a Rust value (`static P`),
    // not a type path. Only scoped `::` calls and constructor-result receivers
    // enter this typed strategy; the legacy chain then keeps its fallback.
    if (call.receiver?.includes(".")) return rustReceiverChainType(call, ctx) ?? null;
    if (!isTypeReceiverCall(call)) return null;
    return rustNamedType(call.receiver, ctx) ?? null;
  },
};

function isTypeReceiverCall(call: CallRef): boolean {
  const { receiver } = call;
  if (!receiver) return false;
  return call.callText.startsWith(`${receiver}::${call.member}`) || constructorCallHead(receiver) !== undefined;
}

function rustNamedType(receiver: string, ctx: CallContext): TypeRef | undefined {
  const typeName = receiverTypeNameFromCall(receiver, ctx);
  if (typeName === null || !declaresInProjectType(typeName, ctx)) return undefined;
  return { form: "class", name: typeName };
}

function receiverTypeNameFromCall(receiver: string, ctx: CallContext): string | null {
  if (receiver === "Self") return ctx.callerScope.at(-1) ?? null;
  const qualified = qualifiedReceiverType(receiver);
  if (qualified !== null) return typeOfPathHead(qualified, ctx);
  const head = constructorCallHead(receiver);
  if (head !== undefined && isRustConstructorAssocFn(head.assocFn)) return typeOfPathHead(head.type, ctx);
  return typeOfPathHead(receiver, ctx);
}

/** `<Type as Trait>` is a qualified path: the local type owns the impl method,
 * while `Trait` may be external and therefore need not be indexed. */
function qualifiedReceiverType(receiver: string): string | null {
  const match = receiver.match(/^<\s*([^<>]+?)\s+as\s+[^<>]+\s*>$/);
  return match?.[1]?.trim() ?? null;
}

export class RustTypeReceiverSymbolResolutionStrategy extends ChainTypeSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    super("typeReceiver", RUST_TYPE_RECEIVER_TYPING, createRustTypeMemberLookup(cfg.mode), { dropOnTypedMiss: true });
  }
}

/** `Self` → the enclosing impl type; a bare CapWords identifier → itself; anything else → `null`. */
function typeOfPathHead(head: string, ctx: CallContext): string | null {
  if (head === "Self") return ctx.callerScope.at(-1) ?? null;
  const bareHead = rustGenericTypeHead(head);
  if (bareHead === null || !isCapWordsType(bareHead)) return null;
  const imported = ctx.imports.find((imp) => rustImportMatchesReceiver(imp.importText, bareHead));
  return imported !== undefined && STD_IMPORT_ROOT.test(imported.importText) ? null : bareHead;
}

/** Strip a Rust turbofish from a nominal path (`Parser::<Token>` → `Parser`). */
function rustGenericTypeHead(path: string): string | null {
  const match = RUST_IDENTIFIER.exec(path);
  if (match === null) return null;
  const bare = match[0];
  if (path === bare) return bare;
  if (!path.startsWith(`${bare}::<`) || !path.endsWith(">")) return null;
  return bare;
}

/**
 * `Type::assocFn(...)` when the receiver is exactly ONE such call — the argument
 * list opens right after the name and closes at the receiver's last character,
 * so `Type::f(a)(b)` and `Type::f(a).x` are not one (mirrors Go's
 * `goBareCallHead`).
 */
function constructorCallHead(receiver: string): { type: string; assocFn: string } | undefined {
  const head = RUST_IDENTIFIER.exec(receiver)?.[0];
  if (head === undefined) return undefined;
  let typeEnd = head.length;
  if (receiver.startsWith("::<", typeEnd)) {
    let angleDepth = 0;
    let close = -1;
    for (let i = typeEnd + 2; i < receiver.length; i++) {
      const ch = receiver[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">" && --angleDepth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0 || receiver.slice(close + 1, close + 3) !== "::") return undefined;
    typeEnd = close + 1;
  } else if (!receiver.startsWith("::", typeEnd)) {
    return undefined;
  }
  const assocStart = typeEnd + 2;
  const assocFn = RUST_IDENTIFIER.exec(receiver.slice(assocStart))?.[0];
  if (assocFn === undefined) return undefined;
  const open = assocStart + assocFn.length;
  if (receiver[open] !== "(" || !receiver.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = open; i < receiver.length; i++) {
    const ch = receiver[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      return i === receiver.length - 1 ? { type: receiver.slice(0, typeEnd), assocFn } : undefined;
    }
  }
  return undefined;
}

/** A type symbol of that name, at the top level or inside a module (`flags::Parser`). */
function declaresInProjectType(typeName: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, typeName).some(
    (def) => def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`),
  );
}
