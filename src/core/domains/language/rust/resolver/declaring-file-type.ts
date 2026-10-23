import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, SymbolDefinition, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { NominalTypeRef } from "../../kernel/index.js";
import { rustItemPathPlacementEnabled, rustNoteItemPathPlacement } from "./item-path-placement-switch.js";
import {
  lookupRustSymbolsByShortName,
  RUST_OWN_CRATE_PATH_HEADS,
  rustFollowReexports,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportIsExternal,
  rustReexportSourcePaths,
  type RustImportBinding,
} from "./strategies/shared.js";
import { rustWorkspaceCratesOf } from "./workspace-crates.js";

/** Whether an import's text spells `name` as a path segment — the only way it can bind it explicitly. */
function rustImportTextNames(importText: string, name: string): boolean {
  return importText.split(/[^A-Za-z0-9_]+/).includes(name);
}

/**
 * Place a type `name` spelled in ANOTHER file's declaration — a callee's
 * return, a struct's field — through THAT file's own `use` imports (bd
 * tea-rags-mcp-s3i8m letCall S4b). The caller's imports say nothing about
 * what the declaring file's spelling means; `rustUseImportsByFile` carries
 * the declaring file's.
 *
 * Exactly one non-glob binding of `name` is required: no binding (a glob
 * may carry it), an unparseable import, or an external binding (std or a
 * foreign crate, S3's job) declines. The binding's candidate module files
 * must hold exactly one class or enum of the item's own name (`use a::B as
 * C` names `B`); none there follows the module's `pub use` re-exports to a
 * unique definition. A name that read leaves undecided, and a qualified
 * `a::B`, is placed through the module system by {@link rustPlaceItemPath}.
 * Anything else answers `undefined` — the read declines, as it did before
 * the channel existed.
 */
export function rustPlaceTypeThroughDeclaringFile(
  name: string,
  declaringFile: string,
  ctx: CallContext,
): NominalTypeRef | undefined {
  // The single-name read this channel always made answers first; placement only where it is silent.
  const placed =
    rustPlaceImportedName(name, declaringFile, ctx, rustDeclaresNominalType) ??
    rustPlaceItemPath(name, declaringFile, ctx, rustDeclaresNominalType);
  return placed === undefined
    ? undefined
    : { form: "instance", name: `${placed.targetRelPath}::${placed.targetSymbolId}` };
}

/** A struct, union or enum: the definitions a type spelling places onto. */
export function rustDeclaresNominalType(def: SymbolDefinition): boolean {
  return def.symbolKind === "class" || def.symbolKind === "enum";
}

/** A module-level `fn`: what a module path `a::b::f` can name as a callee. */
export function rustDeclaresFreeFn(def: SymbolDefinition): boolean {
  return def.symbolKind === "function" && !/[#.]/.test(def.symbolId);
}

/**
 * The sole non-glob `use` of `importingFile` that binds `name`. `undefined` when none
 * does; `null` when nothing is proven — an import the parser cannot read
 * that spells the name, or two bindings of it.
 */
function rustSoleUseBinding(
  name: string,
  importingFile: string,
  ctx: CallContext,
): { importText: string; binding: RustImportBinding } | null | undefined {
  const importTexts = identifierEntry(ctx.rustUseImportsByFile, importingFile);
  if (importTexts === undefined) return undefined;
  const bound: { importText: string; binding: RustImportBinding }[] = [];
  for (const importText of importTexts) {
    const bindings = rustImportBindings(importText);
    // An unread import that never spells the name (`use super::{X, *};` in a
    // `mod tests`) cannot bind it explicitly; a glob never outranks a `use`.
    if (bindings === null && !rustImportTextNames(importText, name)) continue;
    // An import the parser cannot read may bind the name: nothing is proven.
    if (bindings === null) return null;
    for (const binding of bindings) {
      if (!binding.globImport && binding.localName === name) bound.push({ importText, binding });
    }
  }
  return bound.length > 1 ? null : bound[0];
}

/**
 * The one non-glob, internal `use` of `declaringFile` that binds `name`: the
 * item it names (`use a::B as C` names `B`) and the module files that may
 * declare it. Undefined under the guards {@link rustPlaceTypeThroughDeclaringFile}
 * documents.
 */
export function rustDeclaringFileImportOf(
  name: string,
  declaringFile: string,
  ctx: CallContext,
): { importText: string; itemName: string; paths: string[] } | undefined {
  if (name.includes("::")) return undefined;
  const bound = rustSoleUseBinding(name, declaringFile, ctx);
  if (bound === undefined || bound === null) return undefined;
  const { importText, binding } = bound;
  if (rustImportIsExternal(importText, { ...ctx, callerFile: declaringFile }, name)) return undefined;
  const itemName = binding.sourceName ?? binding.moduleSegments.at(-1);
  const paths = rustImportCandidatePaths(importText, name, declaringFile, ctx);
  return itemName === undefined || paths === null ? undefined : { importText, itemName, paths };
}

/** How many `use` substitutions a path placement follows before it declines. */
const RUST_PATH_SUBSTITUTION_CAP = 4;
const RUST_PLACEABLE_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|\$crate)$/;

/**
 * Place an item PATH as written in `fromFile` — `X` bound by a `use`,
 * `a::b::X`, `crate::a::X`, `self::` / `super::` paths, `<crate>::a::X` —
 * onto the one definition `accept` admits, through the crate module system:
 *
 *   - a head bound by a sole non-glob `use` of `fromFile` is replaced by the
 *     path the `use` names (renames and groups included), hop-bounded;
 *   - `crate` / `self` / `super` climb from `fromFile`'s module, a workspace
 *     crate name opens that member's root, any other head is a child module
 *     of `fromFile`'s module (`mod x;` → `x.rs` | `x/mod.rs`);
 *   - the item is looked up in the module file the path names (an inline
 *     `mod` block is the remaining path inside that file's symbol ids), else
 *     through the `pub use` re-exports of that module (`rustFollowReexports`:
 *     hop-bounded, cycle-guarded).
 *
 * Undecidable answers `undefined`: a bare name no `use` binds (lexical scope
 * or a glob), an unreadable import, an external or unplaceable head, a
 * module file the run does not hold, two definitions at one step, or a
 * re-export walk that ends anywhere but one definition. A single `use`-bound
 * name reads {@link rustDeclaringFileImportOf}'s candidate files first,
 * exactly as before this function existed. Off under
 * `rustWithoutItemPathPlacement`; every answer is counted
 * (`item-path-placement-switch.ts`), so the resolver can re-read without it.
 */
export function rustPlaceItemPath(
  path: string,
  fromFile: string,
  ctx: CallContext,
  accept: (def: SymbolDefinition) => boolean,
): SymbolResolutionTarget | undefined {
  if (!rustItemPathPlacementEnabled()) return undefined;
  const segments = path.replace(/^::/, "").split("::");
  if (!segments.every((segment) => RUST_PLACEABLE_SEGMENT.test(segment))) return undefined;
  const placed = rustPlaceSegments(segments, fromFile, ctx, accept, 0);
  if (placed !== undefined) rustNoteItemPathPlacement();
  return placed;
}

function rustPlaceSegments(
  segments: readonly string[],
  fromFile: string,
  ctx: CallContext,
  accept: (def: SymbolDefinition) => boolean,
  substitutions: number,
): SymbolResolutionTarget | undefined {
  const [head, ...rest] = segments;
  if (head === undefined || substitutions > RUST_PATH_SUBSTITUTION_CAP) return undefined;
  if (!RUST_OWN_CRATE_PATH_HEADS.has(head)) {
    const bound = rustSoleUseBinding(head, fromFile, ctx);
    if (bound === null) return undefined;
    const boundPath = bound === undefined ? undefined : rustUseBindingPath(bound.binding);
    // `use foo;` names the crate or module `foo` itself: nothing to substitute.
    if (boundPath !== undefined && !(boundPath.length === 1 && boundPath[0] === head)) {
      if (rest.length === 0) {
        const imported = rustPlaceImportedName(head, fromFile, ctx, accept);
        if (imported !== undefined) return imported;
      }
      return rustPlaceSegments([...boundPath, ...rest], fromFile, ctx, accept, substitutions + 1);
    }
    if (rest.length === 0) return undefined;
  }
  if (rest.length === 0) return undefined;
  const name = segments[segments.length - 1];
  const accepted = lookupRustSymbolsByShortName(ctx, name).filter(accept);
  for (let split = segments.length - 1; split >= 1; split--) {
    const moduleFiles = rustReexportSourcePaths(segments.slice(0, split).join("::"), fromFile, ctx);
    if (moduleFiles === "external") return undefined;
    if (moduleFiles === null) continue;
    const symbolId = segments.slice(split).join("::");
    const hits = accepted.filter((def) => def.symbolId === symbolId && moduleFiles.includes(def.relPath));
    if (hits.length === 1) return { targetRelPath: hits[0].relPath, targetSymbolId: hits[0].symbolId };
    if (hits.length > 1) return undefined;
  }
  // A bare head that is no prefix and no workspace crate is a child module: spell it `self::`.
  const rooted =
    RUST_OWN_CRATE_PATH_HEADS.has(head) || rustWorkspaceCratesOf(ctx)?.declares(head) === true
      ? segments
      : ["self", ...segments];
  const reexported = rustFollowReexports(rooted.join("::"), name, fromFile, ctx, (sourceName) =>
    lookupRustSymbolsByShortName(ctx, sourceName).filter(accept),
  ).target;
  return reexported ?? undefined;
}

/** The path a `use` binding names, prefix included: `use super::{a::B as C}` → `super::a::B`. */
function rustUseBindingPath(binding: RustImportBinding): string[] {
  const prefix =
    binding.prefix === "super"
      ? Array.from({ length: binding.superDepth }, () => "super")
      : binding.prefix === null
        ? []
        : [binding.prefix];
  return [...prefix, ...binding.moduleSegments, ...(binding.sourceName === null ? [] : [binding.sourceName])];
}

/**
 * A single `use`-bound name read the way {@link rustPlaceTypeThroughDeclaringFile}
 * always read it: the binding's candidate module files, then their re-exports.
 */
function rustPlaceImportedName(
  name: string,
  declaringFile: string,
  ctx: CallContext,
  accept: (def: SymbolDefinition) => boolean,
): SymbolResolutionTarget | undefined {
  const bound = rustDeclaringFileImportOf(name, declaringFile, ctx);
  if (bound === undefined) return undefined;
  const { importText, itemName, paths } = bound;
  const accepted = (shortName: string): SymbolDefinition[] =>
    lookupRustSymbolsByShortName(ctx, shortName).filter(accept);
  const direct = accepted(itemName).filter((def) => paths.includes(def.relPath));
  if (direct.length === 1) return { targetRelPath: direct[0].relPath, targetSymbolId: direct[0].symbolId };
  if (direct.length > 1) return undefined;
  return rustFollowReexports(importText, name, declaringFile, ctx, accepted).target ?? undefined;
}
