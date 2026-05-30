/**
 * Shared inputs and helpers for the Go symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection — the old `GoCallResolver(composer, mode)` pair. The
 * `composer` builds `Type#member` / `Type.member` candidate ids per the
 * project-wide symbolId convention; `mode` controls ambiguous-candidate
 * resolution.
 *
 * `resolveByLocalType` and `isKnownTypeSymbol` are the two helpers the
 * typed-receiver strategies (`localBinding`, `returnTypeBinding`) share —
 * factored here so they live once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../../contracts/types/language.js";

export interface ResolverConfig {
  composer: SymbolIdComposer;
  mode: AmbiguousResolveMode;
}

/**
 * Resolve a typed-receiver call: try `Type#member` (instance form) first, then
 * `Type.member` (static form). Returns `null` — never a global short-name
 * fallback — when neither form exists; the calling strategy turns that `null`
 * into a guard DROP. Mirrors the python-resolver step 0 contract.
 */
export function resolveByLocalType(
  cfg: ResolverConfig,
  typeName: string,
  member: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const instanceForm = cfg.composer.compose(typeName, member, { methodKind: "instance" });
  const staticForm = cfg.composer.compose(typeName, member, { methodKind: "static" });
  const instanceHits = ctx.symbolTable.lookup(instanceForm);
  const instance = pickSingleCandidate(instanceHits, cfg.mode);
  if (instance) return { targetRelPath: instance.relPath, targetSymbolId: instance.symbolId };
  const staticHits = ctx.symbolTable.lookup(staticForm);
  const staticHit = pickSingleCandidate(staticHits, cfg.mode);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}

/**
 * Safety gate for function-return-type binding: a declared return type only
 * binds when it names a concrete type that EXISTS as a symbol in the table
 * (`type Engine struct {...}` → symbol `Engine`). Interfaces, builtins
 * (`string`, `error`), and external `pkg.Type`s have no project-local type
 * symbol, so they SKIP rather than fabricate an edge. Matched by exact fqName
 * first (top-level type, `Engine`), then by short name (nested / scoped type
 * declarations) — either match means a real type symbol was extracted.
 */
export function isKnownTypeSymbol(typeName: string, ctx: CallContext): boolean {
  if (ctx.symbolTable.lookup(typeName).length > 0) return true;
  return ctx.symbolTable.lookupByShortName(typeName).length > 0;
}

/** `importText`'s last `/`-segment equals the bare receiver. */
export function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
