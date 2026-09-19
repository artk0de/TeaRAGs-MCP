import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { goLocalAt } from "../../local-scope.js";
import { resolveImportedPackageMember, type ResolverConfig } from "./shared.js";

/**
 * Step 1 — the receiver names an imported package (`bytesconv.StringToBytes`:
 * the import's alias when the source spells one, else the package's own name —
 * `goImportNamedBy`, bd tea-rags-mcp-e6xx G2-1).
 * The call resolves to a package-level declaration of that name in the
 * package's OWN directory.
 *
 * Which directory an import names (bd tea-rags-mcp-e6xx):
 *   - the project declares go.mod modules → `<module>/<subpath>` is `<subpath>`
 *     beneath that go.mod (`GoModuleMap`); an import under no project module —
 *     the standard library, a dependency — names no project package at all, so
 *     `encoding/json` never lands on a project `encoding/json/` directory;
 *   - no go.mod anywhere (GOPATH-shaped fixtures) → the import path itself is
 *     the directory.
 * Either way the match is EXACT: a Go package is one directory, so `foo/bar`
 * is neither `foo/barista/` nor the sub-package `foo/bar/sub/`. The substring
 * test this replaces did both, and it never matched a module-path import, so
 * every intra-module package call of a modern Go project went unresolved.
 *
 * Only a package-level declaration answers — `symbolId` equal to the member —
 * so a method of the same name in that package is not picked. Non-guard: a
 * miss CONTINUEs to the receiver-present drop.
 *
 * A receiver that names a LOCAL in scope (`goLocalAt`) is a value, never the
 * package it shadows (bd tea-rags-mcp-e6xx): `config := config.LoadAny();
 * config.Validate()` is a method call on whatever `LoadAny` returned, even when
 * no pass could type it. The declaring statement's own right-hand side is not
 * yet in the local's scope, so `config.LoadAny()` itself still matches.
 */
export class GoImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    if (goLocalAt(ctx, call.receiver, call.startLine)) return CONTINUE;
    const target = resolveImportedPackageMember(this.cfg, call.receiver, call.member, ctx);
    return target ? resolved(target) : CONTINUE;
  }
}
