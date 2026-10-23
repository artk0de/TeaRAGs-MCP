import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { NominalTypeRef } from "../../kernel/index.js";
import {
  lookupRustSymbolsByShortName,
  rustFollowReexports,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportIsExternal,
  type RustImportBinding,
} from "./strategies/shared.js";

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
 * unique definition. Anything else answers `undefined` — the read declines,
 * as it did before the channel existed.
 */
export function rustPlaceTypeThroughDeclaringFile(
  name: string,
  declaringFile: string,
  ctx: CallContext,
): NominalTypeRef | undefined {
  const bound = rustDeclaringFileImportOf(name, declaringFile, ctx);
  if (bound === undefined) return undefined;
  const { importText, itemName, paths } = bound;
  const typesNamed = (shortName: string): SymbolDefinition[] =>
    lookupRustSymbolsByShortName(ctx, shortName).filter(
      (def) => def.symbolKind === "class" || def.symbolKind === "enum",
    );
  const direct = typesNamed(itemName).filter((def) => paths.includes(def.relPath));
  if (direct.length === 1) return { form: "instance", name: `${direct[0].relPath}::${direct[0].symbolId}` };
  if (direct.length > 1) return undefined;
  const { target } = rustFollowReexports(importText, name, declaringFile, ctx, typesNamed);
  return target === null ? undefined : { form: "instance", name: `${target.targetRelPath}::${target.targetSymbolId}` };
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
  const importTexts = identifierEntry(ctx.rustUseImportsByFile, declaringFile);
  if (importTexts === undefined || name.includes("::")) return undefined;
  const bound: { importText: string; binding: RustImportBinding }[] = [];
  for (const importText of importTexts) {
    const bindings = rustImportBindings(importText);
    // An unread import that never spells the name (`use super::{X, *};` in a
    // `mod tests`) cannot bind it explicitly; a glob never outranks a `use`.
    if (bindings === null && !rustImportTextNames(importText, name)) continue;
    // An import the parser cannot read may bind the name: nothing is proven.
    if (bindings === null) return undefined;
    for (const binding of bindings) {
      if (!binding.globImport && binding.localName === name) bound.push({ importText, binding });
    }
  }
  if (bound.length !== 1) return undefined;
  const [{ importText, binding }] = bound;
  if (rustImportIsExternal(importText, { ...ctx, callerFile: declaringFile }, name)) return undefined;
  const itemName = binding.sourceName ?? binding.moduleSegments.at(-1);
  const paths = rustImportCandidatePaths(importText, name, declaringFile, ctx);
  return itemName === undefined || paths === null ? undefined : { importText, itemName, paths };
}
