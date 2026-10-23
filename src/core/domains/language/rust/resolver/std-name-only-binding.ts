/**
 * RESIDUAL R5 (a) — the static name-only binding of a std-prelude name.
 *
 * The global short-name pass binds `x.unwrap()` to the corpus's only project
 * `unwrap` (tikv `Res#unwrap`) and the enclosing-type probe binds a bare
 * `Ok(v)` to `Response#Ok` (servo). Wherever the rustc driver answered those
 * sites it named std (`Result::unwrap`, `std::prelude::v1::Ok`), ~19k times on
 * tikv. So where the driver is silent (cfg'd-out code, excluded crates, a build
 * failure, no driver at all) a std-prelude name with no receiver-type evidence
 * is read as std: the strategies drop the edge and the miss classifier counts
 * the site external.
 *
 * Evidence that keeps the static edge: a driver row at the member token (the
 * driver decides), a `self` receiver, a path call naming a type (`Res::unwrap`),
 * an import-bound receiver head, a typed local binding or a receiver the chain
 * fold types. A bare call is gated only when every project namesake is an
 * associated item — Rust resolves a bare call through lexical scope and the
 * prelude, never to an impl member — and no `use` binds the name.
 */

import { resolveLocalBinding, type CallContext, type CallRef } from "../../../../contracts/types/codegraph.js";
import { rustTextIsStdMethodName } from "../vocabulary/std-method-names.js";
import { rustTextIsStdPreludeCallable } from "../vocabulary/std-prelude.js";
import { rustcCallSiteDefinitionOf } from "./call-site-resolution.js";
import { rustReceiverChainType } from "./strategies/rust-type-receiver.js";
import {
  parseRustImportPath,
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  rustImportBindings,
} from "./strategies/shared.js";

const RUST_MEMBER_SYMBOL_ID = /[#.][^#.:]+$/;

/** Whether the only binding the static chain could give this call is a std-prelude name matched by name alone. */
export function rustStdNameBindsByNameOnly(call: CallRef, ctx: CallContext): boolean {
  if (rustCallIsMacroInvocation(call) || rustcCallSiteDefinitionOf(call, ctx) !== null) return false;
  return call.receiver === null ? bareStdNameBindsByNameOnly(call, ctx) : receiverStdNameBindsByNameOnly(call, ctx);
}

function bareStdNameBindsByNameOnly(call: CallRef, ctx: CallContext): boolean {
  if (!rustTextIsStdPreludeCallable(call.member)) return false;
  const boundByUse = ctx.imports.some((imp) =>
    rustImportBindings(imp.importText)?.some((binding) => binding.localName === call.member),
  );
  if (boundByUse) return false;
  const candidates = rustCalleeShortNameCandidates(ctx, call.member);
  return candidates.length > 0 && candidates.every((def) => RUST_MEMBER_SYMBOL_ID.test(def.symbolId));
}

function receiverStdNameBindsByNameOnly(call: CallRef, ctx: CallContext): boolean {
  const receiverText = call.receiver ?? "";
  if (!rustTextIsStdMethodName(call.member)) return false;
  if (rustCalleeShortNameCandidates(ctx, call.member).length !== 1) return false;
  if (call.callText.startsWith(`${receiverText}::`)) return false;
  const head = receiverText.split(/[.:]/)[0] ?? receiverText;
  if (head === "self" || head === "Self") return false;
  if (ctx.imports.some((imp) => parseRustImportPath(imp.importText, head)?.receiverMatches)) return false;
  const binding = resolveLocalBinding(ctx.localBindings, head, call.startLine, call.startColumn);
  if (binding !== undefined && (binding.typeRef !== undefined || binding.type.length > 0)) return false;
  return rustReceiverChainType(call, ctx) === undefined;
}
