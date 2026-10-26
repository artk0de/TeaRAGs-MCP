/**
 * Crate-scoped type and member lookups (bd tea-rags-mcp-s3i8m Task 2).
 *
 * Rust forbids an inherent `impl` outside the crate that defines the type, so
 * once a type name is UNIQUE inside its crate every `T#m` / `T.m` the crate
 * declares — in whatever file the impl block sits — belongs to that type. The
 * crate is read off the symbol table alone: the innermost ancestor directory
 * holding a `lib.rs` / `main.rs` marker. No marker, no crate, no answer.
 *
 * Every lookup here is additive: it is consulted only where the same-file
 * read was silent, and more than one candidate is never picked.
 */

import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { lookupRustSymbolsByShortName, rustImportBindings } from "./strategies/shared.js";

/** Symbol kinds that occupy a type name inside a crate — any second one makes the name ambiguous. */
const TYPE_NAME_KINDS: ReadonlySet<string> = new Set(["class", "enum", "interface", "type_alias"]);
const NOMINAL_KINDS: ReadonlySet<string> = new Set(["class", "enum"]);

/** The innermost ancestor directory of `relPath` holding a crate-root marker, or undefined when none does. */
export function rustCrateRootOf(relPath: string, ctx: CallContext): string | undefined {
  if (typeof ctx.symbolTable.hasFile !== "function") return undefined;
  const segments = relPath.split("/");
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const dir = segments.slice(0, depth).join("/");
    const prefix = dir ? `${dir}/` : "";
    if (ctx.symbolTable.hasFile(`${prefix}lib.rs`) || ctx.symbolTable.hasFile(`${prefix}main.rs`)) return dir;
  }
  return undefined;
}

function inCrate(def: SymbolDefinition, root: string, ctx: CallContext): boolean {
  return rustCrateRootOf(def.relPath, ctx) === root;
}

/** The sole struct / enum named `typeName` inside the crate rooted at `root`; any other type namesake declines. */
export function rustCrateUniqueType(typeName: string, root: string, ctx: CallContext): SymbolDefinition | undefined {
  const namesakes = lookupRustSymbolsByShortName(ctx, typeName).filter(
    (def) =>
      def.symbolKind !== undefined &&
      TYPE_NAME_KINDS.has(def.symbolKind) &&
      (def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`)) &&
      inCrate(def, root, ctx),
  );
  if (namesakes.length !== 1) return undefined;
  const [sole] = namesakes;
  return sole.symbolKind !== undefined && NOMINAL_KINDS.has(sole.symbolKind) ? sole : undefined;
}

/**
 * Whether the caller binds `typeName` through a bare-path `use` (another
 * workspace crate or an external one): the name then denotes THAT crate's type,
 * and a local namesake proves nothing (`impl LocalTrait for ext::Peer`).
 */
function rustTypeNameImportedFromOtherCrate(typeName: string, ctx: CallContext): boolean {
  return ctx.imports.some(
    (imp) =>
      rustImportBindings(imp.importText)?.some(
        (binding) => binding.localName === typeName && binding.prefix === null,
      ) === true,
  );
}

/**
 * The crate-unique type `typeName` as the CALLER's file sees it: its crate is
 * the caller's crate and no bare-path `use` rebinds the name to another crate.
 */
export function rustCallerCrateUniqueType(typeName: string, ctx: CallContext): SymbolDefinition | undefined {
  if (rustTypeNameImportedFromOtherCrate(typeName, ctx)) return undefined;
  const root = rustCrateRootOf(ctx.callerFile, ctx);
  return root === undefined ? undefined : rustCrateUniqueType(typeName, root, ctx);
}

/**
 * Every `typeName<separator>member` the crate rooted at `root` declares — inline
 * module ids (`ops::Peer#region`) match by suffix. Callers resolve only a sole
 * candidate: an inherent and a trait impl both defining `member` stay ambiguous.
 */
export function rustCrateTypeMembers(
  typeName: string,
  separator: "#" | ".",
  member: string,
  root: string,
  ctx: CallContext,
): SymbolDefinition[] {
  const own = `${typeName}${separator}${member}`;
  return lookupRustSymbolsByShortName(ctx, member).filter(
    (def) => (def.symbolId === own || def.symbolId.endsWith(`::${own}`)) && inCrate(def, root, ctx),
  );
}
