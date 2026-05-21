/**
 * Rust implementation of the `CallResolver` contract.
 *
 * Rust paths use `::` separators with prefixes:
 *   - `crate::` — current crate root
 *   - `super::` — parent module
 *   - `self::` — current module
 *   - bare paths — refer to a use'd import or external crate
 *
 * Without project-level Cargo metadata we resolve by basename match
 * over the symbol table — for `use crate::foo::bar`, look up `bar`
 * and accept any file whose path ends in `foo/bar.rs` (or
 * `foo/bar/mod.rs`). External crates are out of scope.
 */

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";

export class RustCallResolver implements CallResolver {
  readonly language = "rust";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      const match = ctx.imports.find((imp) => rustImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const suffix = rustImportSuffix(match.importText);
        if (suffix) {
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath.endsWith(`${suffix}.rs`) || def.relPath.endsWith(`${suffix}/mod.rs`));
          const target = candidates[0];
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return { targetRelPath: fallback[0].relPath, targetSymbolId: fallback[0].symbolId };
    }
    return null;
  }
}

function rustImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip `crate::`, `super::`, `self::` prefixes.
  const cleaned = importText.replace(/^(crate|super|self)::/, "");
  const segments = cleaned.split("::");
  const last = segments[segments.length - 1]?.trim() ?? "";
  // Group import `{a, b, c}` — receiver matches if it appears in the
  // braced list.
  if (last.startsWith("{") && last.endsWith("}")) {
    const inner = last
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim());
    return inner.includes(receiver);
  }
  return last === receiver;
}

function rustImportSuffix(importText: string): string | null {
  // Reduce import to its module path component (suffix), dropping
  // crate-prefix and any terminal `{...}` group.
  const cleaned = importText.replace(/^(crate|super|self)::/, "");
  const segments = cleaned.split("::");
  // Drop the trailing item if it's brace-wrapped (the suffix is the
  // path up to that segment).
  const last = segments[segments.length - 1]?.trim() ?? "";
  if (last.startsWith("{")) {
    return segments.slice(0, -1).join("/");
  }
  return segments.join("/");
}
