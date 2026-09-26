import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolDefinition } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../../../infra/symbolid/index.js";
import { isCapWordsType, isRustConstructorAssocFn } from "../../associated-constructor.js";
import {
  lookupRustSymbolsByShortName,
  pickSameFileThenSingle,
  rustImportMatchesReceiver,
  type ResolverConfig,
} from "./shared.js";

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
export class RustTypeReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "typeReceiver";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const typeName = receiverTypeName(call, ctx);
    if (typeName === null || !declaresInProjectType(typeName, ctx)) return CONTINUE;
    const members = lookupRustSymbolsByShortName(ctx, call.member);
    // Instance first, then associated — the order `localBinding` probes in.
    for (const separator of [INSTANCE_METHOD_SEPARATOR, "."]) {
      const own = members.filter((def) => isTypeMember(def.symbolId, typeName, separator, call.member));
      const hit = pickSameFileThenSingle(own, ctx.callerFile, this.cfg.mode);
      if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    }
    return DROP;
  }
}

/** The type the receiver names, or `null` when it names none this pass can read. */
function receiverTypeName(call: CallRef, ctx: CallContext): string | null {
  const { receiver } = call;
  if (!receiver) return null;
  if (call.callText.startsWith(`${receiver}::${call.member}`)) return typeOfPathHead(receiver, ctx);
  const head = constructorCallHead(receiver);
  return head !== undefined && isRustConstructorAssocFn(head.assocFn) ? typeOfPathHead(head.type, ctx) : null;
}

/** `Self` → the enclosing impl type; a bare CapWords identifier → itself; anything else → `null`. */
function typeOfPathHead(head: string, ctx: CallContext): string | null {
  if (head === "Self") return ctx.callerScope.at(-1) ?? null;
  if (RUST_IDENTIFIER.exec(head)?.[0] !== head || !isCapWordsType(head)) return null;
  const imported = ctx.imports.find((imp) => rustImportMatchesReceiver(imp.importText, head));
  return imported !== undefined && STD_IMPORT_ROOT.test(imported.importText) ? null : head;
}

/**
 * `Type::assocFn(...)` when the receiver is exactly ONE such call — the argument
 * list opens right after the name and closes at the receiver's last character,
 * so `Type::f(a)(b)` and `Type::f(a).x` are not one (mirrors Go's
 * `goBareCallHead`).
 */
function constructorCallHead(receiver: string): { type: string; assocFn: string } | undefined {
  const type = RUST_IDENTIFIER.exec(receiver)?.[0];
  if (type === undefined || !receiver.startsWith("::", type.length)) return undefined;
  const assocFn = RUST_IDENTIFIER.exec(receiver.slice(type.length + 2))?.[0];
  if (assocFn === undefined) return undefined;
  const open = type.length + 2 + assocFn.length;
  if (receiver[open] !== "(" || !receiver.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = open; i < receiver.length; i++) {
    const ch = receiver[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === receiver.length - 1 ? { type, assocFn } : undefined;
  }
  return undefined;
}

/** A type symbol of that name, at the top level or inside a module (`flags::Parser`). */
function declaresInProjectType(typeName: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, typeName).some(
    (def) => def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`),
  );
}

function isTypeMember(
  symbolId: SymbolDefinition["symbolId"],
  typeName: string,
  separator: string,
  member: string,
): boolean {
  const own = `${typeName}${separator}${member}`;
  return symbolId === own || symbolId.endsWith(`::${own}`);
}
