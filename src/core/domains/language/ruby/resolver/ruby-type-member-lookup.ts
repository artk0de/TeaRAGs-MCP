/**
 * Ruby's {@link TypeMemberLookup} (bd tea-rags-mcp-m99j1.1.4) — a delegation,
 * not a new walk. The form picks which existing MRO walk answers:
 *
 *   - `class`    → `resolveTypeStaticMethod`   (`Type.m`, a class-valued receiver)
 *   - `instance` → `resolveTypeInstanceMethod` (`Type#m`, an instance receiver)
 *
 * Both walk prepends, the type's own scope, and the ancestors in MRO order, and
 * both fall back to a file-only target on the type's own file when no ancestor
 * declares the member — exactly what the typed-receiver strategies answer today.
 */
import type { AmbiguousResolveMode } from "../../../../contracts/types/codegraph.js";
import { createTypeMemberLookup, type TypeMemberLookup } from "../../kernel/index.js";
import { resolveTypeInstanceMethod, resolveTypeStaticMethod } from "./strategies/shared.js";

export function createRubyTypeMemberLookup(mode: AmbiguousResolveMode): TypeMemberLookup {
  return createTypeMemberLookup((type, member, ctx) =>
    type.form === "class"
      ? resolveTypeStaticMethod(type.name, member, ctx, mode)
      : resolveTypeInstanceMethod(type.name, member, ctx, mode),
  );
}
