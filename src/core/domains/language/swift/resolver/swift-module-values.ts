/**
 * What a Swift MODULE-LEVEL value denotes (bd tea-rags-mcp-y99pg.30) — the
 * read side of the walker's module-values pass
 * (`../walker/passes/module-values.ts`).
 *
 * `public let AF = Session.default` is declared once, at file scope, and read
 * as `AF.request(…)` from files that never mention it. The walker publishes it
 * under the module-scope key `<relPath>::` (`../type-field-address.ts`) on the
 * two run-global field channels: typed on `classFieldTypesByClassKey` when the
 * declaration spells the type, else by SPELLING on `classFieldCallResults`.
 * This index unions those keys across the run into `name → declarations`, and
 * answers:
 *
 *   - ONE declaration of the name — its type, or its spelling folded through
 *     the chain's own ports in MODULE scope: the caller's file, scope, locals
 *     and file-local fields are dropped from the context, because the
 *     right-hand side was written at file scope of another file, where none of
 *     them is visible;
 *   - two or more — nothing. Two files of one module cannot both declare a
 *     module value of one name, so a second declaration means two modules (an
 *     app and its framework), and the index cannot tell which one the caller
 *     imports.
 *
 * A fold that re-enters itself (`let a = b.x` / `let b = a.y`) types nothing.
 * Both results are memoized per run, per channel object, through
 * {@link RunScopedMemo} — `ctx` is threaded so nothing is allocated per call
 * site beyond the first read of a name.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { propagateReceiverType, RunScopedMemo, type ReceiverTypePorts } from "../../kernel/index.js";
import { swiftModuleScopeKeyRelPath } from "../type-field-address.js";
import { isSwiftSourcePath } from "./swift-symbol-lookup.js";

/** One module-level declaration of a value: where, and what it states. */
interface SwiftModuleValueDeclaration {
  readonly relPath: string;
  readonly type?: string;
  readonly spelling?: string;
}

type SwiftModuleValueDeclarations = Readonly<Record<string, readonly SwiftModuleValueDeclaration[]>>;

const NO_DECLARATIONS: SwiftModuleValueDeclarations = Object.freeze({});
const NO_CHANNEL: Record<string, Record<string, string>> = Object.freeze({});

/** Every Swift module-scope key of one channel, as `name → declarations`. */
function collectModuleValues(
  channel: Record<string, Record<string, string>>,
  into: Record<string, SwiftModuleValueDeclaration[]>,
  slot: "type" | "spelling",
): void {
  for (const [key, values] of Object.entries(channel)) {
    const relPath = swiftModuleScopeKeyRelPath(key);
    if (relPath === undefined || !isSwiftSourcePath(relPath)) continue;
    for (const [name, text] of Object.entries(values)) (into[name] ??= []).push({ relPath, [slot]: text });
  }
}

/** A fold's result, `null` for "types nothing" so a memo hit is told from a miss. */
type SwiftModuleValueFold = TypeRef | null;

export class SwiftModuleValueIndex {
  private readonly declarations = new RunScopedMemo<object, SwiftModuleValueDeclarations>();
  private readonly folds = new RunScopedMemo<object, Map<string, SwiftModuleValueFold>>();
  /** Names whose fold is on the stack — the re-entry guard. */
  private readonly folding = new Set<string>();

  /** The type the module value `name` holds, or `undefined`. */
  typeOf(name: string, ctx: CallContext, ports: ReceiverTypePorts): TypeRef | undefined {
    const declared = this.declarationsFor(ctx)[name];
    if (declared?.length !== 1) return undefined;
    const [only] = declared;
    if (only.type !== undefined) return { form: "instance", name: only.type };
    return this.fold(name, only, ctx, ports);
  }

  private fold(
    name: string,
    declaration: SwiftModuleValueDeclaration,
    ctx: CallContext,
    ports: ReceiverTypePorts,
  ): TypeRef | undefined {
    const memoKey = ctx.classFieldCallResults ?? NO_CHANNEL;
    let memo = this.folds.get(ctx.runScope, memoKey);
    if (memo === undefined) {
      memo = new Map();
      this.folds.set(ctx.runScope, memoKey, memo);
    }
    const hit = memo.get(name);
    if (hit !== undefined) return hit ?? undefined;
    if (declaration.spelling === undefined || this.folding.has(name)) return undefined;
    this.folding.add(name);
    let folded: TypeRef | undefined;
    try {
      folded = propagateReceiverType(declaration.spelling, 0, moduleScopeContext(ctx, declaration.relPath), ports);
    } finally {
      this.folding.delete(name);
    }
    const value = folded?.form === "instance" ? folded : undefined;
    memo.set(name, value ?? null);
    return value;
  }

  private declarationsFor(ctx: CallContext): SwiftModuleValueDeclarations {
    const typed = ctx.classFieldTypesByClassKey;
    const spelled = ctx.classFieldCallResults;
    if (typed === undefined && spelled === undefined) return NO_DECLARATIONS;
    // Keyed on the spelled channel when there is one: both are fixed for a run.
    const memoKey = spelled ?? typed ?? NO_CHANNEL;
    const hit = this.declarations.get(ctx.runScope, memoKey);
    if (hit !== undefined) return hit;
    const out: Record<string, SwiftModuleValueDeclaration[]> = createIdentifierRecord();
    collectModuleValues(typed ?? NO_CHANNEL, out, "type");
    collectModuleValues(spelled ?? NO_CHANNEL, out, "spelling");
    this.declarations.set(ctx.runScope, memoKey, out);
    return out;
  }
}

/**
 * `ctx` as seen from file scope of `relPath`: no enclosing type, no locals, no
 * file-local fields — every run-global channel kept.
 */
function moduleScopeContext(ctx: CallContext, relPath: string): CallContext {
  return {
    ...ctx,
    callerFile: relPath,
    callerScope: [],
    callerSymbolId: undefined,
    classFieldTypes: undefined,
    localBindings: undefined,
    localCallBindings: undefined,
    callResultBindings: undefined,
  };
}
