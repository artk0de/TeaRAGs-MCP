import type { CallContext, CallRef, CallResultBinding } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  ChainTypeSymbolResolutionStrategy,
  propagateReceiverType,
  splitAtBracketDepthZero,
  type NominalTypeRef,
  type ReceiverTypePorts,
  type ReceiverTypingPorts,
} from "../../../kernel/index.js";
import { isCapWordsType, isRustConstructorAssocFn } from "../../associated-constructor.js";
import { rustCallResultBindingOf, rustDeclaredCallResultType } from "../declared-call-result-type.js";
import { rustDeclaredFieldType, rustLexicalSelfType } from "../declared-field-type.js";
import { resolveRustNominalType, rustDeclaredMemberReturnType } from "../declared-return-type.js";
import { rustPlaceTypeThroughDeclaringFile } from "../declaring-file-type.js";
import { rustExternalFieldType, rustStdDerefTarget } from "../external-type-hops.js";
import { rustPatternBindingType } from "../pattern-binding-type.js";
import { createRustTypeMemberLookup, rustTypedMissIsProven } from "../rust-type-member-lookup.js";
import { rustStdTypeRef, rustStdUnwrapType } from "../std-type-hops.js";
import { rustVisibleReceiverBinding } from "../visible-receiver-binding.js";
import { lookupRustSymbolsByShortName, rustImportMatchesReceiver, type ResolverConfig } from "./shared.js";

/** Import roots that are never this project's code. */
const STD_IMPORT_ROOT = /^(::)?(std|core|alloc)::/;
const RUST_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const RUST_IDENTIFIER_ONLY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A slice / array binding spelling over a named element type: `[Key]`, `[crate::Key]`. */
const RUST_SLICE_OF_NAMED_TYPE = /^\[([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\]$/;

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
  singleHopType: (receiver, atLine, ctx, atColumn) => {
    const visible = rustVisibleReceiverBinding(receiver, atLine, ctx, atColumn);
    // A later call-result `let` shadows the earlier local: its type or none (bd tea-rags-mcp-s3i8m).
    if (visible?.channel === "callResult" && visible.shadowsLocal) {
      return rustShadowingCallResultType(receiver, atLine, ctx, visible.binding);
    }
    if (visible?.channel === "constructor") {
      const declared = rustCallResultInitType(visible.callResult, ctx);
      if (declared !== undefined) return declared;
    }
    const binding = visible?.channel === "callResult" ? undefined : visible?.binding;
    // A pattern binding shadows the name: its fold answers, or nothing does.
    if (binding?.valueKind === "patternProjection") return rustPatternBindingType(binding, ctx, rustExpressionType);
    const local = binding?.typeRef ?? (binding?.type ? { form: "instance" as const, name: binding.type } : undefined);
    if (local !== undefined) return resolveRustNominalType(local, ctx) ?? rustStdBindingType(local, ctx);
    const produced =
      rustDeclaredCallResultType(receiver, atLine, ctx) ?? rustMethodCallResultType(receiver, atLine, ctx);
    if (produced !== undefined) return produced;
    if (receiver === "self") return rustLexicalSelfType(ctx);
    const named = rustNamedType(receiver, ctx);
    if (named === undefined) return undefined;
    const exact = resolveRustNominalType(named, ctx);
    if (exact === undefined) return undefined;
    const constructor = constructorCallHead(receiver);
    return constructor === undefined
      ? { ...exact, form: "class" }
      : rustAssociatedCallResult({ ...exact, form: "class" }, constructor, atLine, ctx);
  },
  seedHead: () => undefined,
  memberTypeOf: rustDeclaredMemberReturnType,
  memberAttributeTypeOf: rustFieldHopType,
  maxHops: () => 8,
  splitReceiverHops: rustReceiverHops,
};

/**
 * The type a call-result `let` gives a name it re-binds over an earlier local
 * (bd tea-rags-mcp-s3i8m): the callee's declared return, a method's declared
 * return, else the fold of the whole initializer. Undefined means the name is
 * untyped — never the shadowed local's type.
 */
export function rustShadowingCallResultType(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  callResult: CallResultBinding,
): TypeRef | undefined {
  return (
    rustDeclaredCallResultType(receiver, atLine, ctx) ??
    rustMethodCallResultType(receiver, atLine, ctx) ??
    rustCallResultInitType(callResult, ctx)
  );
}

/** Std calls that hand back their single argument's value: `test::black_box(x)`, `convert::identity(x)`. */
const RUST_IDENTITY_CALL =
  /^(?:(?:(?:::)?(?:std|core)::)?hint::black_box|test::black_box|(?:(?:::)?(?:std|core)::)?convert::identity)\((.+)\)$/;
const RUST_CLONE_CALL = /\.\s*clone\(\)$/;

/**
 * The fold of a call-result `let`'s whole initializer, read at its line
 * (bd tea-rags-mcp-s3i8m). A `let x = T::new(..)` local the walker typed as
 * `T` reads `T::new`'s declared return here first (`-> Option<Self>` makes it
 * an `Option<T>`); a builder chain (`T::new(..).with(..)`) folds hop by hop.
 * `Clone::clone` and the std identity calls keep their input's type even
 * when no declaration says so (a derived `Clone`, an external `black_box`).
 */
export function rustCallResultInitType(callResult: CallResultBinding, ctx: CallContext): TypeRef | undefined {
  const init = callResult.initExpression;
  if (init === undefined) return undefined;
  const folded = rustExpressionType(init, callResult.line, ctx) ?? rustAssociatedCallType(init, callResult.line, ctx);
  if (folded !== undefined) return folded;
  const source = rustValuePreservingSource(init);
  return source === undefined ? undefined : rustExpressionType(source, callResult.line, ctx);
}

/**
 * The expression whose value an initializer hands back unchanged in type:
 * `x.clone()` → `x` (`Clone::clone` returns `Self`), `test::black_box(&x)` →
 * `x` (a reference keeps the nominal type). Undefined for any other shape.
 */
export function rustValuePreservingSource(init: string): string | undefined {
  if (RUST_CLONE_CALL.test(init)) return init.replace(RUST_CLONE_CALL, "");
  const argument = RUST_IDENTITY_CALL.exec(init)?.[1];
  if (argument === undefined || splitAtBracketDepthZero(argument, ",").length !== 1) return undefined;
  return argument.replace(/^&(?:mut\s+)?/, "").trim();
}

/**
 * `Type::assoc(..)` for ANY associated fn an in-project type declares
 * (`KeyBuilder::from_vec(..)`): its declared return. The chain fold types only
 * constructor-named ones (`isRustConstructorAssocFn`); a `let` initializer
 * names its callee outright, so the declaration speaks for it.
 */
function rustAssociatedCallType(init: string, atLine: number, ctx: CallContext): TypeRef | undefined {
  const head = constructorCallHead(init);
  if (head === undefined) return undefined;
  const typeName = typeOfPathHead(head.type, ctx);
  if (typeName === null || !declaresInProjectType(typeName, ctx)) return undefined;
  const owner = resolveRustNominalType({ form: "class", name: typeName }, ctx);
  return owner === undefined ? undefined : rustAssociatedCallResult({ ...owner, form: "class" }, head, atLine, ctx);
}

/**
 * `Type::assoc(args)`'s declared return. When the return is the owner itself
 * with its generic arguments unfixed (`Trusted::new(ptr: &T) -> Trusted<T>`),
 * the owner's generic constructor fact binds them from the arguments' types
 * read at `atLine` (bd tea-rags-mcp-s3i8m): `Trusted::new(window)` with a
 * placed `window: &Window` is `Trusted<Window>`. Every generic parameter must
 * be bound by a placed project type, else the bare head stands, as before.
 */
function rustAssociatedCallResult(
  owner: NominalTypeRef,
  call: { readonly assocFn: string; readonly args: string },
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  const returned = rustDeclaredMemberReturnType(owner, call.assocFn, ctx);
  if (returned?.form !== "instance" || returned.name !== owner.name || returned.args !== undefined) return returned;
  const boundary = owner.name.indexOf(".rs::");
  if (boundary < 0) return returned;
  const fact = ctx.typeDeclarations?.[owner.name.slice(0, boundary + 3)]?.find(
    (declaration) => declaration.typeId === owner.name.slice(boundary + 5) && !declaration.reopens,
  );
  const constructors = fact?.genericInitializers?.filter((constructor) => constructor.name === call.assocFn) ?? [];
  if (fact?.genericParameters === undefined || constructors.length !== 1) return returned;
  const argumentTexts = call.args.trim() === "" ? [] : splitAtBracketDepthZero(call.args, ",").map((a) => a.trim());
  if (argumentTexts.at(-1) === "") argumentTexts.pop();
  const { binds } = constructors[0];
  if (argumentTexts.length !== binds.length) return returned;
  const bound = new Map<string, TypeRef>();
  for (const [index, parameter] of binds.entries()) {
    if (parameter === null) continue;
    const argumentText = argumentTexts[index].replace(/^&(?:mut\s+)?/, "").trim();
    const argument = rustExpressionType(argumentText, atLine, ctx) ?? rustImportedLocalType(argumentText, atLine, ctx);
    if (argument?.form !== "instance" || !argument.name.includes(".rs::")) return returned;
    const earlier = bound.get(parameter);
    if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(argument)) return returned;
    bound.set(parameter, argument);
  }
  const typeArguments = fact.genericParameters.map((parameter) => bound.get(parameter));
  return typeArguments.every((arg) => arg !== undefined) ? { ...returned, args: typeArguments } : returned;
}

/**
 * A local whose annotation names a type the lexical read cannot place —
 * `global: &GlobalScope` while `impl Trait for GlobalScope` blocks in other
 * files share the name — placed through the caller file's own `use` imports
 * (bd tea-rags-mcp-s3i8m). Only a plain, argument-free annotation.
 */
function rustImportedLocalType(name: string, atLine: number, ctx: CallContext): TypeRef | undefined {
  if (!RUST_IDENTIFIER_ONLY.test(name)) return undefined;
  const visible = rustVisibleReceiverBinding(name, atLine, ctx);
  if (visible?.channel !== "local") return undefined;
  const { typeRef } = visible.binding;
  if (typeRef !== undefined && (typeRef.form !== "instance" || typeRef.args !== undefined)) return undefined;
  const annotated = typeRef?.name ?? visible.binding.type;
  return annotated.length === 0 ? undefined : rustPlaceTypeThroughDeclaringFile(annotated, ctx.callerFile, ctx);
}

/**
 * A receiver's hops: whitespace dropped (rustfmt breaks long chains across
 * lines — `self\n    .ctx\n    .feature_gate`), split on `.` at bracket depth
 * zero so a call's arguments stay one hop, and a trailing `?` split into its
 * own `?` hop, which unwraps an `Option`/`Result` (bd tea-rags-mcp-2g2og.24).
 */
function rustReceiverHops(receiver: string): string[] {
  return splitAtBracketDepthZero(receiver.replace(/\s+/g, ""), ".").flatMap((hop) => {
    if (!hop.endsWith("?") || hop.length === 1) return [hop];
    return [hop.slice(0, -1), "?"];
  });
}

/**
 * A local annotated with a std type (`stack: Vec<Peer>`, `opt: Option<Bar>`)
 * travels as its std spelling with every argument placed, exactly like a std
 * field type (bd tea-rags-mcp-s3i8m Task 1b) — so `stack.pop()` and
 * `for p in &v` fold. An argument neither placed nor std drops the arguments.
 */
function rustStdBindingType(local: TypeRef, ctx: CallContext): TypeRef | undefined {
  if (local.form !== "instance") return undefined;
  // A slice / array binding reads `[<element>]`: a container of its placed element.
  const sliceElement = RUST_SLICE_OF_NAMED_TYPE.exec(local.name)?.[1];
  if (sliceElement !== undefined) {
    const element = resolveRustNominalType({ form: "instance", name: sliceElement }, ctx);
    return element === undefined ? undefined : { form: "container", element };
  }
  const typeArguments = local.args?.map((arg) => resolveRustNominalType(arg, ctx) ?? rustStdBindingType(arg, ctx));
  return rustStdTypeRef(local.name, typeArguments, ctx);
}

/** A non-call hop: `?` unwraps, a std smart pointer derefs to its target, else a declared struct field. */
function rustFieldHopType(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
  if (member === "?") return rustStdUnwrapType(recv, member);
  // A guard's field access auto-derefs to its table `Deref::Target` (bd s3i8m.7 T3b).
  const pointee = rustStdDerefTarget(recv, member, ctx, "field");
  const owner = pointee ?? recv;
  // A public field of a std/dependency struct reads the table (bd s3i8m.7 T3c).
  return rustDeclaredFieldType(owner, member, ctx) ?? rustExternalFieldType(owner, member, ctx);
}

export function rustReceiverChainType(call: CallRef, ctx: CallContext): TypeRef | undefined {
  return call.receiver === null ? undefined : rustExpressionType(call.receiver, call.startLine, ctx, call.startColumn);
}

/** The chain fold over an expression read at `atLine` (and `atColumn`, when the site has one). */
export function rustExpressionType(
  expression: string,
  atLine: number,
  ctx: CallContext,
  atColumn?: number,
): TypeRef | undefined {
  return propagateReceiverType(expression, atLine, ctx, RUST_RECEIVER_TYPE_PORTS, atColumn);
}

/**
 * A dotted call-result init (`let wb = e.write_batch();`): the receiver is
 * typed through the same fold the chain strategies use and the method's
 * declared return answers, auto-deref included. Recursion terminates because
 * a valid Rust init only names bindings declared EARLIER (use-before-declare
 * is E0425), so following untyped receivers walks strictly backwards through
 * the chunk's declarations (bd tea-rags-mcp-2g2og).
 */
export function rustMethodCallResultType(
  receiverName: string | null,
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  if (receiverName === null) return undefined;
  const binding = rustCallResultBindingOf(receiverName, atLine, ctx);
  if (binding === undefined) return undefined;
  const lastDot = binding.callee.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const receiverText = binding.callee.slice(0, lastDot);
  const memberName = binding.callee.slice(lastDot + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(memberName)) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(receiverText)) return undefined;
  const ownerType = rustReceiverChainType(
    {
      callText: `${binding.callee}(…)`,
      receiver: receiverText,
      member: memberName,
      startLine: binding.line,
    },
    ctx,
  );
  if (ownerType === undefined) return undefined;
  return rustDeclaredMemberReturnType(ownerType, memberName, ctx);
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
    super("typeReceiver", RUST_TYPE_RECEIVER_TYPING, createRustTypeMemberLookup(cfg.mode), {
      // A typed miss drops only when PROVEN; a hop the walk could not see
      // through defers to the prior read (bd tea-rags-mcp-s3i8m.5).
      dropOnTypedMiss: (receiverType, call, ctx) => rustTypedMissIsProven(receiverType, call.member, ctx),
    });
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
function constructorCallHead(receiver: string): { type: string; assocFn: string; args: string } | undefined {
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
      return i === receiver.length - 1
        ? { type: receiver.slice(0, typeEnd), assocFn, args: receiver.slice(open + 1, i) }
        : undefined;
    }
  }
  return undefined;
}

/**
 * A type symbol of that name, at the top level or inside a module
 * (`flags::Parser`). A type ALIAS owns no members — `type Range = Match;`
 * carries `Match`'s — so it never makes the call owned (bd tea-rags-mcp-sjego).
 */
function declaresInProjectType(typeName: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, typeName).some(
    (def) => def.symbolKind !== "type_alias" && (def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`)),
  );
}
