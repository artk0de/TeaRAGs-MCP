/**
 * Java's nominal member lookup port for the reusable receiver-typed kernel
 * strategies. Java keeps its overload policy and instance/static spelling here;
 * the kernel owns only the nominal-form gate and strategy verdict.
 */
import type {
  AmbiguousResolveMode,
  CallContext,
  SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import { createTypeMemberLookup, type NominalTypeRef, type TypeMemberLookup } from "../../kernel/index.js";
import { resolveJavaTypeMember } from "./strategies/shared.js";

export function createJavaTypeMemberLookup(mode: AmbiguousResolveMode): TypeMemberLookup {
  return createTypeMemberLookup(
    (type: NominalTypeRef, member: string, ctx: CallContext): SymbolResolutionTarget =>
      resolveJavaTypeMember(type, member, ctx, mode),
  );
}
