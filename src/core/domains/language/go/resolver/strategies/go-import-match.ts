import { posix } from "node:path";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { GoModuleMap } from "../go-module-map.js";
import { importMatchesReceiver, type ResolverConfig } from "./shared.js";

/**
 * Step 1 — the receiver names an imported package (`bytesconv.StringToBytes`,
 * the import's last path segment equals the receiver). The call resolves to a
 * package-level declaration of that name in the package's OWN directory.
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
 */
export class GoImportMatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importMatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver) return CONTINUE;
    const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, receiver));
    if (!match) return CONTINUE;
    const packageDir = goImportPackageDir(match.importText, this.cfg.moduleMaps?.forRoot(ctx.projectRoot));
    if (packageDir === undefined) return CONTINUE;
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter(
        (def) =>
          def.symbolId === call.member && def.relPath.endsWith(".go") && goPackageDirOf(def.relPath) === packageDir,
      );
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}

/** The repo-relative package directory an import names, `undefined` when it is not a project package. */
function goImportPackageDir(importText: string, modules: GoModuleMap | undefined): string | undefined {
  if (modules?.declaresModules) return modules.packageDirOf(importText);
  return importText.replace(/^\.\//, "");
}

/** The package directory of a Go file: its directory, `""` at the root. */
function goPackageDirOf(relPath: string): string {
  const dir = posix.dirname(relPath);
  return dir === "." ? "" : dir;
}
