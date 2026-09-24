/**
 * Which files DECLARE a Swift type and which only re-open it — the resolver's
 * read of the run-global `typeDeclarations` channel (bd tea-rags-mcp-y99pg.1).
 *
 * `extension World` composes exactly the symbol id `class World` does, so the
 * symbol table alone cannot tell the two apart. That costs twice:
 *
 *   - a type re-opened ACROSS files (`World.swift` + `World+DSL.swift`) answers
 *     its name with two definitions, and the strict gate drops every
 *     construction edge into it as ambiguous;
 *   - a type the project only EXTENDS (`extension JSONDecoder: DataDecoder {}`)
 *     answers its name with the extension alone, so `JSONDecoder()` lands on a
 *     file that declares no initializer of it.
 *
 * The channel is absent on an index built before the walker published it, and
 * every question here then answers `undefined` — the caller keeps the answer it
 * gave before the channel existed.
 */

import type { CallContext, TypeDeclarationFact } from "../../../../contracts/types/codegraph.js";
import { RunScopedMemo } from "../../kernel/run-scoped-memo.js";

interface SwiftTypeDeclarationSets {
  /** typeId → the files holding its own declaration. */
  readonly declaring: ReadonlyMap<string, ReadonlySet<string>>;
  /** typeId → the files re-opening it. */
  readonly reopening: ReadonlyMap<string, ReadonlySet<string>>;
}

const memo = new RunScopedMemo<Readonly<Record<string, readonly TypeDeclarationFact[]>>, SwiftTypeDeclarationSets>();

function add(into: Map<string, Set<string>>, typeId: string, relPath: string): void {
  const files = into.get(typeId);
  if (files) files.add(relPath);
  else into.set(typeId, new Set([relPath]));
}

function setsFor(ctx: CallContext): SwiftTypeDeclarationSets | undefined {
  const channel = ctx.typeDeclarations;
  if (channel === undefined) return undefined;
  const hit = memo.get(ctx.runScope, channel);
  if (hit !== undefined) return hit;
  const declaring = new Map<string, Set<string>>();
  const reopening = new Map<string, Set<string>>();
  for (const [relPath, facts] of Object.entries(channel)) {
    // Swift declarations only, as every lookup here (`swift-symbol-lookup.ts`).
    if (!relPath.endsWith(".swift")) continue;
    for (const fact of facts) add(fact.reopens ? reopening : declaring, fact.typeId, relPath);
  }
  const fresh = { declaring, reopening };
  memo.set(ctx.runScope, channel, fresh);
  return fresh;
}

/**
 * The files holding `typeId`'s own declaration, or `undefined` when the run
 * says nothing about the type — no channel, or no file declaring or re-opening
 * it. An EMPTY set means the project only re-opens the type.
 */
export function swiftDeclaringFiles(typeId: string, ctx: CallContext): ReadonlySet<string> | undefined {
  const sets = setsFor(ctx);
  if (sets === undefined) return undefined;
  const declaring = sets.declaring.get(typeId);
  if (declaring !== undefined) return declaring;
  return sets.reopening.has(typeId) ? new Set<string>() : undefined;
}

/** Whether the run PROVES `typeId` is a type the project re-opens but never declares. */
export function isSwiftReopenedOnlyType(typeId: string, ctx: CallContext): boolean {
  return swiftDeclaringFiles(typeId, ctx)?.size === 0;
}

/**
 * Whether a project extension declares an initializer of `typeId` — the one
 * way a construction of a type the project only re-opens can land in the
 * project. Which initializer a call runs is an argument-label question, so this
 * says only that one CAN.
 */
export function swiftExtensionDeclaresInit(typeId: string, lookup: (symbolId: string) => readonly unknown[]): boolean {
  return lookup(`${typeId}#init`).length > 0 || lookup(`${typeId}.init`).length > 0;
}
