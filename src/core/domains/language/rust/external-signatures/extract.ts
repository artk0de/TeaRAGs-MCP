/**
 * Pure extraction of a Rust external signature table (bd s3i8m.7) from the
 * source of crates outside the project — std/core/alloc or a registry/git
 * dependency. Sources are handed in; nothing here touches the disk.
 *
 * One tight walk per file visits ITEM-level nodes only (crate root, inline and
 * file modules, impl bodies) and never enters a function body, so the cost is
 * the parse plus the item count. Items are recorded raw, then resolved once the
 * whole module graph is known: a return type spelled `LockResult<MutexGuard<'_, T>>`
 * in `std::sync::poison::mutex` becomes `std::sync::LockResult<std::sync::MutexGuard<T>>`.
 */
import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type {
  AstNode,
  RustClosedAssoc,
  RustExternalMember,
  RustExternalSignatureTableData,
  RustExternalSourceFile,
  RustExternalTypeExpr,
  RustExternalTypeSignatures,
  TypeRef,
} from "../../../../contracts/index.js";
import { rustImportBindings } from "../resolver/strategies/shared.js";
import { rustStdPrimitiveTypes } from "../vocabulary/std-prelude.js";
import { rustDeclaredTypeRef, rustGenericParameters } from "../walker/return-types.js";
import { RustCrateGraph, rustUseTargetSegments, type RustModuleScope } from "./canonical-paths.js";

export type { RustExternalSourceFile } from "../../../../contracts/index.js";

export type RustSourceParser = (source: string) => AstNode;

/** Crates whose public API is discriminated by `#[stable]` / `#[unstable]`. */
const RUST_STABILITY_CRATES: ReadonlySet<string> = new Set(["std", "core", "alloc"]);
const RUST_STD_CRATES: ReadonlySet<string> = new Set(["std", "core", "alloc"]);
const UNIT: TypeRef = { form: "tuple", elements: [] };
const CFG_TEST = /^#\[cfg\(\s*test\s*\)\]$/;
const STABLE = /^#\[stable\b/;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["tests", "benches", "examples"]);

/** `(trait last segment, associated type name)` → the closed key it answers. */
const CLOSED_ASSOC: Readonly<Record<string, RustClosedAssoc>> = {
  "Deref::Target": "Deref::Target",
  "Iterator::Item": "Iterator::Item",
  "IntoIterator::IntoIter": "IntoIterator::IntoIter",
  "Future::Output": "Future::Output",
};

interface RawFn {
  readonly name: string;
  readonly pub: boolean;
  readonly stable: boolean;
  readonly selfKind: RustExternalMember["selfKind"];
  readonly returns: TypeRef | undefined;
  readonly methodGenericParameters: readonly string[];
}

interface RawImpl {
  readonly scope: RustModuleScope;
  readonly selfType: TypeRef;
  readonly implParameters: readonly string[];
  readonly traitType: TypeRef | undefined;
  readonly fns: readonly RawFn[];
  readonly assoc: readonly { readonly name: string; readonly type: TypeRef | undefined }[];
}

interface RawStruct {
  readonly scope: RustModuleScope;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly fields: readonly { readonly name: string; readonly type: TypeRef | undefined }[];
}

interface RawAlias {
  readonly scope: RustModuleScope;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly type: TypeRef | undefined;
}

interface RawItems {
  readonly impls: RawImpl[];
  readonly structs: RawStruct[];
  readonly aliases: RawAlias[];
}

export function extractRustExternalSignatures(
  files: readonly RustExternalSourceFile[],
  parse: RustSourceParser,
): RustExternalSignatureTableData {
  const graph = new RustCrateGraph();
  const raw: RawItems = { impls: [], structs: [], aliases: [] };
  for (const file of files) {
    const segments = rustModuleSegmentsOf(file.relPath);
    if (segments === undefined) continue;
    collectItems(parse(file.source), graph.module(file.crate, segments), graph, raw);
  }
  const paths = graph.assignCanonicalPaths();
  return { crates: graph.crates(), paths, ...resolveSignatures(graph, raw) };
}

/** `lib.rs` → crate root, `a/mod.rs` and `a.rs` → `a`; tests/benches/examples and binaries → not a library module. */
function rustModuleSegmentsOf(relPath: string): string[] | undefined {
  const parts = relPath.split(/[\\/]/);
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) return undefined;
  const file = parts.pop() ?? "";
  if (!file.endsWith(".rs")) return undefined;
  if (parts.length === 0 && (file === "lib.rs" || file === "main.rs")) return file === "lib.rs" ? [] : undefined;
  if (file === "mod.rs") return parts;
  return [...parts, file.slice(0, -3)];
}

function isPub(node: AstNode): boolean {
  return node.namedChildren.some((child) => child.type === "visibility_modifier" && child.text === "pub");
}

function collectItems(container: AstNode, scope: RustModuleScope, graph: RustCrateGraph, raw: RawItems): void {
  let attributes: string[] = [];
  for (const node of container.namedChildren) {
    if (node.type === "attribute_item") {
      attributes.push(node.text);
      continue;
    }
    if (node.type === "line_comment" || node.type === "block_comment" || node.type === "inner_attribute_item") continue;
    const itemAttributes = attributes;
    attributes = [];
    if (itemAttributes.some((attribute) => CFG_TEST.test(attribute))) continue;
    collectItem(node, itemAttributes, scope, graph, raw);
  }
}

function collectItem(
  node: AstNode,
  attributes: readonly string[],
  scope: RustModuleScope,
  graph: RustCrateGraph,
  raw: RawItems,
): void {
  const name = node.childForFieldName("name")?.text;
  switch (node.type) {
    case "mod_item": {
      if (name === undefined) return;
      const child = graph.declareModule(scope, name, isPub(node));
      const body = node.childForFieldName("body");
      if (body !== null) collectItems(body, child, graph, raw);
      return;
    }
    case "struct_item":
    case "enum_item":
    case "union_item":
      if (name === undefined) return;
      scope.declare(name, "type", isPub(node));
      if (node.type === "struct_item") raw.structs.push(collectStruct(node, name, scope));
      return;
    case "trait_item":
      if (name !== undefined) scope.declare(name, "trait", isPub(node));
      return;
    case "type_item":
      if (name === undefined) return;
      scope.declare(name, "alias", isPub(node));
      raw.aliases.push({
        scope,
        name,
        parameters: rustGenericParameters(node),
        type: rustSignatureTypeRef(node.childForFieldName("type")),
      });
      return;
    case "use_declaration":
      collectUse(node, attributes, scope, graph);
      return;
    case "extern_crate_declaration": {
      const alias = node.childForFieldName("alias")?.text;
      if (name !== undefined) graph.declareExternCrate(scope.crate, name, alias ?? name);
      return;
    }
    case "impl_item": {
      const implementation = collectImpl(node, scope);
      if (implementation !== undefined) raw.impls.push(implementation);
      break;
    }
    default:
  }
}

function collectUse(node: AstNode, attributes: readonly string[], scope: RustModuleScope, graph: RustCrateGraph): void {
  const argument = node.childForFieldName("argument");
  if (argument === null) return;
  const bindings = rustImportBindings(`use ${argument.text};`);
  if (bindings === null) return;
  const pub = isPub(node);
  for (const binding of bindings) {
    const target = {
      prefix: binding.prefix,
      superDepth: binding.superDepth,
      segments: rustUseTargetSegments(binding),
    };
    if (binding.globImport) {
      if (attributes.some((attribute) => attribute.startsWith("#[prelude_import"))) graph.declarePrelude(scope, target);
      else scope.globs.push({ pub, target });
    } else scope.uses.push({ localName: binding.localName, pub, target });
  }
}

function collectStruct(node: AstNode, name: string, scope: RustModuleScope): RawStruct {
  const body = node.childForFieldName("body");
  const fields =
    body?.type === "field_declaration_list"
      ? body.namedChildren
          .filter((field) => field.type === "field_declaration" && isPub(field))
          .map((field) => ({
            name: field.childForFieldName("name")?.text ?? "",
            type: rustSignatureTypeRef(field.childForFieldName("type")),
          }))
          .filter((field) => field.name.length > 0)
      : [];
  return { scope, name, parameters: rustGenericParameters(node), fields };
}

function collectImpl(node: AstNode, scope: RustModuleScope): RawImpl | undefined {
  const selfTypeNode = node.childForFieldName("type");
  // `impl IntoIterator for &Vec<T>` is not an impl for `Vec<T>`: its own members would collide with the owned impl's.
  if (selfTypeNode === null || selfTypeNode.type === "reference_type") return undefined;
  const selfType = rustSignatureTypeRef(selfTypeNode);
  const body = node.childForFieldName("body");
  if (selfType?.form !== "instance" || body === null) return undefined;
  const traitNode = node.childForFieldName("trait");
  const fns: RawFn[] = [];
  const assoc: { name: string; type: TypeRef | undefined }[] = [];
  let attributes: string[] = [];
  for (const member of body.namedChildren) {
    if (member.type === "attribute_item") {
      attributes.push(member.text);
      continue;
    }
    if (member.type === "line_comment" || member.type === "block_comment") continue;
    const memberAttributes = attributes;
    attributes = [];
    if (memberAttributes.some((attribute) => CFG_TEST.test(attribute))) continue;
    const name = member.childForFieldName("name")?.text;
    if (name === undefined) continue;
    if (member.type === "function_item") {
      fns.push({
        name,
        pub: isPub(member),
        stable: !RUST_STABILITY_CRATES.has(scope.crate) || memberAttributes.some((attribute) => STABLE.test(attribute)),
        selfKind: rustSelfKindOf(member),
        returns: rustSignatureTypeRef(member.childForFieldName("return_type"), UNIT),
        methodGenericParameters: rustGenericParameters(member),
      });
    } else if (member.type === "type_item") {
      assoc.push({ name, type: rustSignatureTypeRef(member.childForFieldName("type")) });
    }
  }
  return {
    scope,
    selfType,
    implParameters: rustGenericParameters(node),
    traitType: traitNode === null ? undefined : rustDeclaredTypeRef(traitNode),
    fns,
    assoc,
  };
}

/**
 * A type in a signature: the walker's `rustDeclaredTypeRef` (references
 * stripped, lifetimes dropped), plus the two top-level shapes it leaves out —
 * a primitive keyword and `()`. `absent` answers a missing node (`-> ()` implied).
 */
function rustSignatureTypeRef(node: AstNode | null, absent?: TypeRef): TypeRef | undefined {
  if (node === null) return absent;
  if (node.type === "reference_type") return rustSignatureTypeRef(node.childForFieldName("type"));
  if (node.type === "primitive_type") return { form: "instance", name: node.text };
  if (node.type === "unit_type") return UNIT;
  return rustDeclaredTypeRef(node);
}

function rustSelfKindOf(fn: AstNode): RustExternalMember["selfKind"] {
  const first = fn.childForFieldName("parameters")?.namedChildren.find((child) => child.type !== "attribute_item");
  if (first === undefined) return "none";
  if (first.type === "self_parameter") {
    if (!first.text.startsWith("&")) return "value";
    return /\bmut\s+self\b/.test(first.text) ? "mut" : "ref";
  }
  if (first.type === "parameter" && first.childForFieldName("pattern")?.text === "self") {
    const type = first.childForFieldName("type")?.text ?? "";
    if (!type.startsWith("&")) return "value";
    return /^&\s*(?:'\w+\s+)?mut\b/.test(type) ? "mut" : "ref";
  }
  return "none";
}

function emptySignatures(): RustExternalTypeSignatures {
  return {
    inherent: createIdentifierRecord(),
    fields: createIdentifierRecord(),
    associated: createIdentifierRecord(),
    traitMembers: createIdentifierRecord(),
  };
}

function resolveSignatures(
  graph: RustCrateGraph,
  raw: RawItems,
): Pick<RustExternalSignatureTableData, "types" | "aliases"> {
  const types = createIdentifierRecord<RustExternalTypeSignatures>();
  const aliases = createIdentifierRecord<RustExternalTypeExpr>();
  const signaturesOf = (path: string): RustExternalTypeSignatures => (types[path] ??= emptySignatures());

  for (const alias of raw.aliases) {
    const item = alias.scope.items.get(alias.name);
    const type = alias.type && canonicalTypeRef(alias.type, alias.scope, graph, new Set(alias.parameters));
    if (item?.publicPath !== undefined && type !== undefined) {
      aliases[item.publicPath] ??= { type, genericParameters: alias.parameters };
    }
  }
  for (const struct of raw.structs) {
    const publicPath = struct.scope.items.get(struct.name)?.publicPath;
    if (publicPath === undefined) continue;
    const generics = new Set(struct.parameters);
    for (const field of struct.fields) {
      const type = field.type && canonicalTypeRef(field.type, struct.scope, graph, generics);
      const fields = signaturesOf(publicPath).fields as Record<string, RustExternalTypeExpr>;
      if (type !== undefined) fields[field.name] = { type, genericParameters: struct.parameters };
    }
  }

  const members = new Map<string, Map<string, RustExternalMember[]>>();
  const associated = new Map<string, Map<RustClosedAssoc, RustExternalTypeExpr[]>>();
  for (const implementation of raw.impls) {
    const owner = implOwnerPath(implementation, graph);
    if (owner === undefined) continue;
    const ownerArgs = implementation.selfType.form === "instance" ? (implementation.selfType.args ?? []) : [];
    const implParameters = new Set(implementation.implParameters);
    const genericParameters = ownerArgs.map((arg) =>
      arg.form === "instance" && arg.args === undefined && implParameters.has(arg.name) ? arg.name : "_",
    );
    if (implementation.traitType === undefined) {
      for (const fn of implementation.fns) {
        if (!fn.pub) continue;
        const generics = new Set([...implementation.implParameters, ...fn.methodGenericParameters]);
        const returns = fn.returns && canonicalTypeRef(fn.returns, implementation.scope, graph, generics);
        const member: RustExternalMember = {
          ...(returns === undefined ? {} : { returns: { type: returns, genericParameters } }),
          methodGenericParameters: fn.methodGenericParameters,
          selfKind: fn.selfKind,
          stable: fn.stable,
        };
        pushCandidate(members, owner, fn.name, member);
      }
      continue;
    }
    const traitPath =
      implementation.traitType.form === "instance"
        ? (graph.resolveTypeSpelling(implementation.traitType.name, implementation.scope) ??
          implementation.traitType.name)
        : undefined;
    if (traitPath === undefined) continue;
    const traitMembers = signaturesOf(owner).traitMembers as Record<string, string[]>;
    const names = new Set([...(traitMembers[traitPath] ?? []), ...implementation.fns.map((fn) => fn.name)]);
    traitMembers[traitPath] = [...names].sort();
    const traitSegments = traitPath.split("::");
    if (traitSegments.length > 1 && !RUST_STD_CRATES.has(traitSegments[0])) continue;
    for (const assoc of implementation.assoc) {
      const key = CLOSED_ASSOC[`${traitSegments.at(-1)}::${assoc.name}`] as RustClosedAssoc | undefined;
      const type = key && assoc.type && canonicalTypeRef(assoc.type, implementation.scope, graph, implParameters);
      if (key !== undefined && type !== undefined) pushCandidate(associated, owner, key, { type, genericParameters });
    }
  }

  for (const [owner, byName] of members) {
    const inherent = signaturesOf(owner).inherent as Record<string, RustExternalMember | "ambiguous">;
    for (const [name, candidates] of byName) {
      const preferred = candidates.some((member) => member.stable)
        ? candidates.filter((member) => member.stable)
        : candidates;
      inherent[name] = singleOrAmbiguous(preferred, (member) => JSON.stringify(member.returns ?? null));
    }
  }
  for (const [owner, byKey] of associated) {
    const target = signaturesOf(owner).associated as Partial<
      Record<RustClosedAssoc, RustExternalTypeExpr | "ambiguous">
    >;
    for (const [key, candidates] of byKey) target[key] = singleOrAmbiguous(candidates, (expr) => JSON.stringify(expr));
  }
  return { types, aliases };
}

/** The table key of an impl's self type: a publicly reachable type, or a primitive (`impl str`). */
function implOwnerPath(implementation: RawImpl, graph: RustCrateGraph): string | undefined {
  if (implementation.selfType.form !== "instance") return undefined;
  const { name } = implementation.selfType;
  if (rustStdPrimitiveTypes.has(name)) return RUST_STD_CRATES.has(implementation.scope.crate) ? name : undefined;
  const resolution = graph.resolveType(name, implementation.scope);
  return resolution?.kind === "item" && resolution.item.kind === "type" ? resolution.item.publicPath : undefined;
}

function canonicalTypeRef(
  recv: TypeRef,
  scope: RustModuleScope,
  graph: RustCrateGraph,
  generics: ReadonlySet<string>,
): TypeRef | undefined {
  if (recv.form === "tuple") return recv.elements.length === 0 ? recv : undefined;
  if (recv.form !== "instance") return undefined;
  const keepsSpelling = generics.has(recv.name) || recv.name === "Self" || rustStdPrimitiveTypes.has(recv.name);
  const name = keepsSpelling ? recv.name : graph.resolveTypeSpelling(recv.name, scope);
  if (name === undefined) return undefined;
  if (recv.args === undefined) return { form: "instance", name };
  const args: TypeRef[] = [];
  for (const arg of recv.args) {
    const resolved = canonicalTypeRef(arg, scope, graph, generics);
    if (resolved === undefined) return undefined;
    args.push(resolved);
  }
  return { form: "instance", name, args };
}

function pushCandidate<K, V>(table: Map<string, Map<K, V[]>>, owner: string, key: K, value: V): void {
  let byKey = table.get(owner);
  if (byKey === undefined) {
    byKey = new Map();
    table.set(owner, byKey);
  }
  const list = byKey.get(key);
  if (list === undefined) byKey.set(key, [value]);
  else list.push(value);
}

function singleOrAmbiguous<V>(candidates: readonly V[], identity: (value: V) => string): V | "ambiguous" {
  return new Set(candidates.map(identity)).size === 1 ? candidates[0] : "ambiguous";
}
