import { CONTINUE, deferred, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { targetsExternalImport } from "../ts-external-call.js";
import { importSpecifierNamesReceiver } from "../ts-import-basename-match.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Basename-normalized compare. Catches the common kebab-case → PascalCase TS
 * naming convention (`rank-module.js` → `RankModule`) by stripping extensions
 * and non-alphanumeric characters before case-folded equality (bd
 * tea-rags-mcp-kiuw). LOWER-PRECEDENCE fallback for imports that lack
 * `importedNames` (stale index re-indexed before the field landed). Once the
 * target FILE resolves, a missing member yields a file-only edge that is
 * DEFERRED, not committed — same reasoning as `namedImport` (bd
 * tea-rags-mcp-5onmn).
 *
 * The comparator itself lives in `../ts-import-basename-match.ts` so the
 * external classifier can recognise the same receivers without importing this
 * strategy back (bd tea-rags-mcp-4kx9f).
 *
 * The guard on that park reads the resolver's `TSProgramCache` (bd
 * tea-rags-mcp-83iz5), for the reason passes 9-10 do. Matching on the specifier
 * BASENAME means the receiver need not be an import at all — `const cache =
 * this.ensureBlameCache(root)` collides with the `./infra/cache.js` the same
 * file imports — so the receiver is routinely one the walker never typed, and
 * `get` / `set` are outside {@link ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS}
 * because project classes own those names. Without the cache this guard was the
 * last one in the chain still asking the question one argument short of the
 * answer: `TSCallResolver#targetsExternalImport` already called those calls
 * external, and the pass parked an edge onto the module anyway.
 */
export class TSImportBasenameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importBasename";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache | null = null,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const match = ctx.imports.find((imp) => importSpecifierNamesReceiver(imp.importText, call.receiver as string));
    if (!match) return CONTINUE;

    const targetFile = mapImportToFile(match.importText, ctx.callerFile, this.cfg.tsOptions, this.cfg.fileExists);
    if (!targetFile) return CONTINUE;

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    // Same guard, and the same placement rationale, as `namedImport` (bd
    // tea-rags-mcp-4kx9f). This pass reaches the shape from the other side: it
    // compares receiver TEXT to the specifier's basename, so a local `sessions`
    // array collides with a `sessions.ts` the caller imports and `sessions.map`
    // lands a file-only edge on a module the call never enters.
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions, this.programCache)) return CONTINUE;
    return deferred({ targetRelPath: targetFile, targetSymbolId: null });
  }
}
