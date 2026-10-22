/**
 * The std types a Rust receiver chain may pass through or end on (bd
 * tea-rags-mcp-2g2og.24). The chain fold places PROJECT types by file; a std
 * type has no file, so it travels as its bare spelling (`Vec`, `Option`) or
 * its full std path (`std::fs::Metadata`) — a name no project symbol id ends
 * with unless the project itself implements a member on that std type, which
 * is exactly the edge Rust method resolution would take.
 *
 * Three hops are typed, each from the declaration alone:
 *   - `Option<T>` / `Result<T, E>` unwrap to `T` ONLY through `?`, `unwrap`,
 *     `expect` — every other member (`map`, `ok`, `as_ref`) is a std
 *     combinator whose result we do not model, so the walk stops there;
 *   - `Box<T>` / `Arc<T>` / `Rc<T>` auto-deref to `T` for every member the
 *     pointer does not answer itself (`clone`, `as_ref`, …): Rust probes the
 *     pointer type first, then its `Deref` target;
 *   - any other std type is a TERMINAL: a member on it is std unless the
 *     project implements that member on that std type.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { rustTextIsStdPreludeType, rustTextIsStdUnwrappingType } from "../vocabulary/std-prelude.js";
import { lookupRustSymbolsByShortName, rustImportBindings, rustImportIsExternal } from "./strategies/shared.js";

const RUST_STD_ROOTS: ReadonlySet<string> = new Set(["std", "core", "alloc"]);
const RUST_UNWRAP_MEMBERS: ReadonlySet<string> = new Set(["?", "unwrap", "expect", "unwrap_unchecked"]);
const RUST_STD_SMART_POINTERS: ReadonlySet<string> = new Set(["Box", "Arc", "Rc"]);
/** Members a smart pointer answers before its target: its own std trait impls and inherent methods. */
const RUST_SMART_POINTER_OWN_MEMBERS: ReadonlySet<string> = new Set([
  "clone",
  "as_ref",
  "as_mut",
  "as_ptr",
  "borrow",
  "borrow_mut",
  "deref",
  "deref_mut",
  "eq",
  "ne",
  "cmp",
  "partial_cmp",
  "fmt",
  "hash",
  "into",
  "to_owned",
  "to_string",
]);

/** The project declares a type of this short name — it shadows any std reading. */
function projectDeclaresType(ctx: CallContext, shortName: string): boolean {
  return lookupRustSymbolsByShortName(ctx, shortName).some(
    (def) =>
      (def.symbolKind === undefined || def.symbolKind === "class" || def.symbolKind === "enum") &&
      (def.symbolId === shortName || def.symbolId.endsWith(`::${shortName}`)),
  );
}

/**
 * The std type a declared spelling names, or `undefined`. A bare spelling must
 * be a std prelude type (`Option` / `Result` among them) the project does not shadow; a
 * path spelling must be rooted at `std` / `core` / `alloc`. Arguments are kept
 * only when every one is known — a partial argument list would misalign.
 */
export function rustStdTypeRef(
  name: string,
  args: readonly (TypeRef | undefined)[] | undefined,
  ctx: CallContext,
): TypeRef | undefined {
  const known = args?.every((arg) => arg !== undefined) ? args : undefined;
  const withArgs = (spelling: string): TypeRef =>
    known === undefined || known.length === 0
      ? { form: "instance", name: spelling }
      : { form: "instance", name: spelling, args: known };
  if (name.includes("::")) {
    const head = name.replace(/^::/, "").split("::")[0];
    return RUST_STD_ROOTS.has(head) ? withArgs(name.replace(/^::/, "")) : undefined;
  }
  if (!rustTextIsStdPreludeType(name)) return undefined;
  return projectDeclaresType(ctx, name) ? undefined : withArgs(name);
}

/** A `use` of the caller's file binds `name` to a crate outside the project. */
export function rustNameBoundByExternalImport(name: string, ctx: CallContext): boolean {
  return ctx.imports.some(
    (imp) =>
      rustImportBindings(imp.importText)?.some((binding) => binding.localName === name) === true &&
      rustImportIsExternal(imp.importText, ctx, name),
  );
}

/** A declared type spelling that provably names no project type: std, or bound by an external `use`. */
function rustTypeNameIsForeign(name: string, ctx: CallContext): boolean {
  if (name.includes("::")) {
    const head = name.replace(/^::/, "").split("::")[0];
    return RUST_STD_ROOTS.has(head) || rustNameBoundByExternalImport(head, ctx);
  }
  return rustStdTypeRef(name, undefined, ctx) !== undefined || rustNameBoundByExternalImport(name, ctx);
}

/**
 * Whether a declared field type PROVES no project member answers a call on
 * the field (bd tea-rags-mcp-s3i8m.5): its head is foreign, and when the head
 * is a smart pointer (`Arc<Url>`) — whose `Deref` hands members to its target
 * — every argument is known and foreign too. `Arc<Core>` with a project
 * `Core`, or an argument the walker could not spell, proves nothing.
 */
export function rustDeclaredTypeIsForeign(
  head: string,
  typeArguments: readonly (string | null)[] | undefined,
  ctx: CallContext,
): boolean {
  if (!rustTypeNameIsForeign(head, ctx)) return false;
  if (!RUST_STD_SMART_POINTERS.has(head.split("::").at(-1) ?? head)) return true;
  return (
    typeArguments !== undefined &&
    typeArguments.length > 0 &&
    typeArguments.every((arg) => arg !== null && rustTypeNameIsForeign(arg, ctx))
  );
}

/** A std type in the fold's channel — never a placed project type. */
function isStdTypeRef(recv: TypeRef): boolean {
  return recv.form === "instance" && !recv.name.includes(".rs::");
}

/** `opt?` / `opt.unwrap()` / `res.expect(..)` on a std `Option`/`Result` → its first argument. */
export function rustStdUnwrapType(recv: TypeRef, member: string): TypeRef | undefined {
  if (!isStdTypeRef(recv) || recv.form !== "instance" || !rustTextIsStdUnwrappingType(recv.name)) return undefined;
  if (!RUST_UNWRAP_MEMBERS.has(member)) return undefined;
  return recv.args?.[0];
}

/** The `Deref` target a std smart pointer hands `member` to, or `undefined` when the pointer answers it. */
export function rustStdSmartPointerTarget(recv: TypeRef, member: string): TypeRef | undefined {
  if (recv.form !== "instance" || !isStdTypeRef(recv) || !RUST_STD_SMART_POINTERS.has(recv.name)) return undefined;
  if (RUST_SMART_POINTER_OWN_MEMBERS.has(member) || recv.args?.length !== 1) return undefined;
  return recv.args[0];
}

/**
 * Whether `member` on the typed std receiver `recv` is proven std: the
 * receiver is a std type, the member is not one the pointer hands to a
 * project target, and no project symbol implements `member` on that std type.
 */
export function rustStdTerminalTargetsExternal(recv: TypeRef, member: string, ctx: CallContext): boolean {
  if (recv.form !== "instance" || !isStdTypeRef(recv)) return false;
  if (rustStdSmartPointerTarget(recv, member) !== undefined) return false;
  const typeName = recv.name.split("::").at(-1) ?? recv.name;
  const projectImpl = lookupRustSymbolsByShortName(ctx, member).some(
    (def) =>
      def.symbolId === `${typeName}#${member}` ||
      def.symbolId === `${typeName}.${member}` ||
      def.symbolId.endsWith(`::${typeName}#${member}`) ||
      def.symbolId.endsWith(`::${typeName}.${member}`),
  );
  return !projectImpl;
}
