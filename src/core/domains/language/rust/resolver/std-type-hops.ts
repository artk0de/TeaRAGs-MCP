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

/*
 * Std collections and iterators (bd tea-rags-mcp-s3i8m Task 1b). The closed
 * tables below type what a loop, an iterator adapter's closure, or an element
 * accessor hands out — every other member stays untyped.
 */

/** Collections whose element is their first type argument. `Option` iterates its payload. */
const RUST_STD_SEQUENCES: ReadonlySet<string> = new Set([
  "Vec",
  "VecDeque",
  "HashSet",
  "BTreeSet",
  "BinaryHeap",
  "LinkedList",
  "Option",
]);
/** Maps: `K` keys, `V` values, `(K, V)` entries. */
const RUST_STD_MAPS: ReadonlySet<string> = new Set(["HashMap", "BTreeMap"]);
/** Members turning a collection into an iterator over its elements (a map's entries). */
const RUST_ITERATOR_SOURCES: ReadonlySet<string> = new Set(["iter", "iter_mut", "into_iter", "drain"]);
const RUST_MAP_VALUE_SOURCES: ReadonlySet<string> = new Set(["values", "values_mut", "into_values"]);
const RUST_MAP_KEY_SOURCES: ReadonlySet<string> = new Set(["keys", "into_keys"]);
/** Iterator adapters whose item is their input's item. */
const RUST_PASS_THROUGH_ADAPTERS: ReadonlySet<string> = new Set([
  "iter",
  "iter_mut",
  "into_iter",
  "rev",
  "skip",
  "take",
  "filter",
  "cloned",
  "copied",
  "peekable",
  "chain",
  "skip_while",
  "take_while",
  "step_by",
  "fuse",
  "inspect",
]);
/** Every member {@link rustStdElementType} reads in an iterator chain. */
export const RUST_ITERATOR_CHAIN_MEMBERS: ReadonlySet<string> = new Set([
  ...RUST_ITERATOR_SOURCES,
  ...RUST_MAP_VALUE_SOURCES,
  ...RUST_MAP_KEY_SOURCES,
  ...RUST_PASS_THROUGH_ADAPTERS,
  "enumerate",
]);
/** Element accessors answering `Option<element>`, per sequence. */
const RUST_SEQUENCE_ACCESSORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Vec", new Set(["pop", "first", "last", "get", "get_mut", "first_mut", "last_mut"])],
  ["slice", new Set(["first", "last", "get", "get_mut", "first_mut", "last_mut"])],
  ["VecDeque", new Set(["pop_front", "pop_back", "front", "back", "front_mut", "back_mut", "get", "get_mut"])],
  ["BinaryHeap", new Set(["pop", "peek"])],
  ["HashSet", new Set(["get", "take"])],
  ["BTreeSet", new Set(["get", "take", "first", "last", "pop_first", "pop_last"])],
  ["Option", new Set(["take", "as_ref", "as_mut", "cloned", "copied", "replace"])],
]);
/** Map members answering `Option<V>`; `remove_entry` answers `Option<(K, V)>`. */
const RUST_MAP_VALUE_ACCESSORS: ReadonlySet<string> = new Set(["get", "get_mut", "remove", "insert"]);

/** The bare std name of a std type ref (`std::collections::HashMap` → `HashMap`), else `undefined`. */
function rustStdShortName(recv: TypeRef): string | undefined {
  if (recv.form !== "instance" || !isStdTypeRef(recv)) return undefined;
  if (recv.name.includes("::") && !RUST_STD_ROOTS.has(recv.name.split("::")[0])) return undefined;
  return recv.name.split("::").at(-1);
}

function rustOptionOf(element: TypeRef): TypeRef {
  return { form: "instance", name: "Option", args: [element] };
}

/** A std smart pointer's target, a std container through any number of them. */
function rustThroughSmartPointers(recv: TypeRef): TypeRef {
  let current = recv;
  for (let hop = 0; hop < 3; hop++) {
    const name = rustStdShortName(current);
    if (name === undefined || !RUST_STD_SMART_POINTERS.has(name)) return current;
    if (current.form !== "instance" || current.args?.length !== 1) return current;
    current = current.args[0];
  }
  return current;
}

/**
 * `Option<element>` of a std element accessor (`stack.pop()`, `map.get(k)`,
 * `map.insert(k, v)`, `opt.take()`), or `undefined` for any other member.
 */
export function rustStdAccessorReturnType(recv: TypeRef, member: string): TypeRef | undefined {
  // `Clone::clone` answers `Self`, for every std type and a slice alike.
  if (member === "clone" && (recv.form === "container" || rustStdShortName(recv) !== undefined)) return recv;
  if (recv.form === "container") {
    return RUST_SEQUENCE_ACCESSORS.get("slice")?.has(member) === true ? rustOptionOf(recv.element) : undefined;
  }
  const name = rustStdShortName(recv);
  if (name === undefined || recv.form !== "instance") return undefined;
  const { args: typeArguments } = recv;
  if (RUST_STD_MAPS.has(name)) {
    if (typeArguments?.length !== 2) return undefined;
    if (member === "remove_entry") {
      return rustOptionOf({ form: "tuple", elements: [typeArguments[0], typeArguments[1]] });
    }
    return RUST_MAP_VALUE_ACCESSORS.has(member) ? rustOptionOf(typeArguments[1]) : undefined;
  }
  if (RUST_SEQUENCE_ACCESSORS.get(name)?.has(member) !== true || typeArguments?.length !== 1) return undefined;
  return rustOptionOf(typeArguments[0]);
}

/** What iterating `recv` directly yields: a sequence's element, a map's `(K, V)` entry. */
function rustStdCollectionItem(recv: TypeRef): TypeRef | undefined {
  const collection = rustThroughSmartPointers(recv);
  if (collection.form === "container") return collection.element;
  const name = rustStdShortName(collection);
  if (name === undefined || collection.form !== "instance") return undefined;
  const { args: typeArguments } = collection;
  if (RUST_STD_SEQUENCES.has(name)) return typeArguments?.length === 1 ? typeArguments[0] : undefined;
  if (RUST_STD_MAPS.has(name) && typeArguments?.length === 2) {
    return { form: "tuple", elements: [typeArguments[0], typeArguments[1]] };
  }
  return undefined;
}

/**
 * The item a std collection `recv` yields through the iterator chain
 * `adapters` (`["iter", "enumerate"]`): sources (`iter`, `values`, `keys`,
 * `drain`) open the iterator, pass-through adapters keep its item,
 * `enumerate` pairs it with a `usize`. An empty chain iterates `recv` itself
 * (`for x in vec`). Any other member, or a non-std receiver, is `undefined`.
 */
export function rustStdElementType(recv: TypeRef, adapters: readonly string[]): TypeRef | undefined {
  let item: TypeRef | undefined;
  for (const adapter of adapters) {
    if (item === undefined) item = rustStdIteratorSourceItem(recv, adapter);
    else if (adapter === "enumerate") item = { form: "tuple", elements: [{ form: "instance", name: "usize" }, item] };
    else if (!RUST_PASS_THROUGH_ADAPTERS.has(adapter)) return undefined;
    if (item === undefined) return undefined;
  }
  return item ?? rustStdCollectionItem(recv);
}

/** The item of the iterator `adapter` opens on the collection `recv`. */
function rustStdIteratorSourceItem(recv: TypeRef, adapter: string): TypeRef | undefined {
  if (RUST_ITERATOR_SOURCES.has(adapter)) return rustStdCollectionItem(recv);
  const collection = rustThroughSmartPointers(recv);
  const name = rustStdShortName(collection);
  if (name === undefined || !RUST_STD_MAPS.has(name) || collection.form !== "instance") return undefined;
  if (collection.args?.length !== 2) return undefined;
  if (RUST_MAP_VALUE_SOURCES.has(adapter)) return collection.args[1];
  return RUST_MAP_KEY_SOURCES.has(adapter) ? collection.args[0] : undefined;
}

/** A std collection's closure-taking members, and which closure parameter gets which item. */
const RUST_SEQUENCE_CLOSURE_MEMBERS: ReadonlySet<string> = new Set([
  "retain",
  "retain_mut",
  "sort_by",
  "sort_by_key",
  "sort_by_cached_key",
  "sort_unstable_by",
  "sort_unstable_by_key",
  "dedup_by",
  "dedup_by_key",
]);
/** Iterator adapters whose closure takes the item, keyed to the closure's argument position. */
const RUST_ITERATOR_CLOSURE_ARGUMENT: ReadonlyMap<string, number> = new Map([
  ...[
    "map",
    "filter",
    "for_each",
    "any",
    "all",
    "find",
    "position",
    "rposition",
    "filter_map",
    "flat_map",
    "find_map",
    "map_while",
    "inspect",
    "take_while",
    "skip_while",
    "max_by_key",
    "min_by_key",
    "max_by",
    "min_by",
    "partition",
    "try_for_each",
  ].map((adapter): [string, number] => [adapter, 0]),
  ["fold", 1],
  ["try_fold", 1],
]);
/** `Option` / `Result` combinators whose closure takes the `Ok`/`Some` payload, keyed to the closure's argument. */
const RUST_PAYLOAD_COMBINATORS: ReadonlyMap<string, number> = new Map([
  ["map", 0],
  ["and_then", 0],
  ["filter", 0],
  ["inspect", 0],
  ["is_some_and", 0],
  ["is_none_or", 0],
  ["is_ok_and", 0],
  ["take_if", 0],
  ["map_or", 1],
  ["map_or_else", 1],
]);
/** `Result` combinators whose closure takes the `Err` payload, keyed to the closure's argument. */
const RUST_ERROR_COMBINATORS: ReadonlyMap<string, number> = new Map([
  ["map_err", 0],
  ["or_else", 0],
  ["inspect_err", 0],
  ["is_err_and", 0],
  ["unwrap_or_else", 0],
  ["map_or_else", 0],
]);

/**
 * The type of parameter `index` of the closure passed as argument `argument`
 * to `adapter`, called on `recv` — a std iterator over `iteratorItem` when
 * the receiver chain opened one (`vec.iter().map(|p| …)`), else the std
 * value `recv` itself (`opt.map(|p| …)`, `vec.retain(|p| …)`). The `.map`
 * spelling is settled by that receiver type, never by the member's name.
 */
export function rustStdClosureParamType(
  recv: TypeRef,
  iteratorItem: TypeRef | undefined,
  adapter: string,
  argument: number,
  index: number,
): TypeRef | undefined {
  if (iteratorItem !== undefined) {
    if (RUST_ITERATOR_CLOSURE_ARGUMENT.get(adapter) !== argument) return undefined;
    if (adapter === "fold" || adapter === "try_fold") return index === 1 ? iteratorItem : undefined;
    return adapter === "max_by" || adapter === "min_by" || index === 0 ? iteratorItem : undefined;
  }
  const name = rustStdShortName(recv);
  if (name === undefined || recv.form !== "instance") return undefined;
  const { args: typeArguments } = recv;
  if (name === "Option" || name === "Result") {
    if (typeArguments?.length !== (name === "Option" ? 1 : 2) || index !== 0) return undefined;
    if (RUST_PAYLOAD_COMBINATORS.get(adapter) === argument) return typeArguments[0];
    return name === "Result" && RUST_ERROR_COMBINATORS.get(adapter) === argument ? typeArguments[1] : undefined;
  }
  if (argument !== 0) return undefined;
  if (RUST_STD_MAPS.has(name) && adapter === "retain" && typeArguments?.length === 2) return typeArguments[index];
  if (!RUST_STD_SEQUENCES.has(name) || name === "Option" || !RUST_SEQUENCE_CLOSURE_MEMBERS.has(adapter)) {
    return undefined;
  }
  return typeArguments?.length === 1 && (index === 0 || adapter.endsWith("_by")) ? typeArguments[0] : undefined;
}
