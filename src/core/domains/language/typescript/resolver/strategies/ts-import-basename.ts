import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { mapImportToFile } from "../ts-path-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Basename-normalized compare. Catches the common kebab-case → PascalCase TS
 * naming convention (`rank-module.js` → `RankModule`) by stripping extensions
 * and non-alphanumeric characters before case-folded equality (bd
 * tea-rags-mcp-kiuw). LOWER-PRECEDENCE fallback for imports that lack
 * `importedNames` (stale index re-indexed before the field landed). Terminal
 * once the target FILE resolves (file-only edge when the member misses).
 */
export class TSImportBasenameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importBasename";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
    if (!match) return CONTINUE;

    const targetFile = mapImportToFile(match.importText, ctx.callerFile, this.cfg.tsOptions);
    if (!targetFile) return CONTINUE;

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  // Match the basename of the import specifier against the receiver,
  // normalizing both sides so the common TS kebab-case → PascalCase file/class
  // naming convention resolves (bd tea-rags-mcp-kiuw). Examples:
  //   "../rank-module.js" → basename "rank-module.js" → norm "rankmodule"
  //   "RankModule"                                    → norm "rankmodule"
  //   "./foo.ts"          → basename "foo.ts"         → norm "foo"
  //   "Foo"                                           → norm "foo"
  // Arbitrary-name cases (filename unrelated to class) are handled by the
  // symbol-table FQN fallback in `receiverSymbol` — this comparator
  // intentionally only catches the cheap mirror cases.
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return normalizeIdentifier(last) === normalizeIdentifier(receiver);
}

function normalizeIdentifier(value: string): string {
  // Strip known source extensions before character normalization so `.d.ts`
  // and the dotted compound extensions still flatten cleanly.
  const stripped = stripSourceExtension(value);
  let out = "";
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) out += stripped[i];
    else if (isUpper) out += String.fromCharCode(code + 32);
  }
  return out;
}

function stripSourceExtension(value: string): string {
  // Recognised TS / JS source suffixes. `.d.ts` is checked before the
  // single-extension variants so the longer suffix wins.
  const lowered = value.toLowerCase();
  if (lowered.endsWith(".d.ts")) return value.slice(0, -5);
  if (lowered.endsWith(".tsx") || lowered.endsWith(".jsx") || lowered.endsWith(".mjs") || lowered.endsWith(".cjs")) {
    return value.slice(0, -4);
  }
  if (lowered.endsWith(".ts") || lowered.endsWith(".js")) return value.slice(0, -3);
  return value;
}
