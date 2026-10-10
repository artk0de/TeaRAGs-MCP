/**
 * A member found on a Python class or up its ancestors: the C3-MRO scan from a
 * class key, the named-type entry into it, and the legacy single-base
 * `classExtends` walk that predates `classAncestors`. Split out of
 * `strategies/shared.ts` by cohesion cluster (bd tea-rags-mcp-0qaht.43);
 * `shared.ts` re-exports every name.
 */

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { findMemberInAncestorChain, type AncestorClosure, type AncestorLinearizer } from "../../../kernel/index.js";
import { parsePythonClassKey } from "./python-class-key.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { lastSegment, pythonTypeRefClassKey, resolveTypeRefFile } from "./python-type-addressing.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

/** A member found on a class or one of its ancestors, and how far the walk could see. */
export interface PythonInheritedMemberResult {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: AncestorClosure;
}

/**
 * `<member>` on `classKey` or the first ancestor in its MRO that owns it (bd
 * tea-rags-mcp-9fgdi). `classifyMethod` files an undecorated `def` as the
 * instance spelling (`Cls#m`) and a `@classmethod` / `@staticmethod` one as the
 * class spelling (`Cls.m`), and the corpora carry both
 * (`GetRelatedModelsMixin#get_related_models`, `RepositoryBase.from_session`),
 * so the scan tries both at every class in the order.
 *
 * WHICH ONE IT TRIES FIRST is `options.spellingOrder`, and it matters only for
 * a class that declares BOTH — a `@classmethod` shadowing an inherited instance
 * method. `instanceFirst` is the default and is what an instance receiver
 * wants; `classFirst` is what a receiver that IS the class object wants (bd
 * tea-rags-mcp-w205u, E4.4a). The option REORDERS and never excludes, so a
 * `cls.instance_method()` still resolves.
 *
 * Every lookup is FILTERED BY THE CANDIDATE'S OWN FILE. The class key is
 * file-qualified precisely so two `Base` classes in two files stay apart, and
 * an unfiltered `symbolTable.lookup("Base#m")` would put them back together.
 *
 * `closure` is the caller's evidence for what to do with a miss — a hierarchy
 * read to the end that does not own the member is evidence of ABSENCE, one that
 * left the project or could not be bound is not. This function never decides;
 * see each strategy's verdict table.
 */
export function resolvePythonInheritedMember(
  classKey: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext>,
  options: {
    readonly startAfter?: boolean;
    readonly spellingOrder?: "instanceFirst" | "classFirst";
  } = {},
): PythonInheritedMemberResult {
  const scan = findMemberInAncestorChain(
    classKey,
    linearizer,
    (candidateKey) => {
      const parsed = parsePythonClassKey(candidateKey);
      if (parsed === null) return null;
      const instance = `${parsed.classFq}#${member}`;
      const klass = `${parsed.classFq}.${member}`;
      for (const spelling of options.spellingOrder === "classFirst" ? [klass, instance] : [instance, klass]) {
        const inFile = ctx.symbolTable.lookup(spelling).filter((def) => def.relPath === parsed.relPath);
        const picked = pickSingleCandidate(inFile, mode);
        if (picked) return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
      }
      return null;
    },
    // Forward only what the kernel walk declares, so a Python-only option
    // cannot leak into a signature that has no field for it.
    { startAfter: options.startAfter },
  );
  return { target: scan.target, closure: scan.closure };
}

/**
 * Where a walk for a member on a NAMED TYPE stopped, when it found nothing.
 * `unbound` is this module's own state and not one of the kernel's: the type
 * NAME never named a class the project declares, so no hierarchy was entered
 * and the ancestor closure has nothing to say about it.
 */
export type PythonTypeMemberClosure = AncestorClosure | "unbound";

/** A member found on a named type or one of its ancestors, and how far the walk saw. */
export interface PythonTypeMemberResolution {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: PythonTypeMemberClosure;
}

const UNBOUND_TYPE_MEMBER: PythonTypeMemberResolution = { target: null, closure: "unbound" };

/**
 * `<member>` on a receiver whose TYPE NAME is known, resolved through the C3
 * MRO (bd tea-rags-mcp-s2w5g).
 *
 * The two steps between a type name and {@link resolvePythonInheritedMember}:
 * the name resolves to the FILE that declares it, and the file plus the name
 * become the dotted-FQ class KEY the ancestor walk is addressed by. Stated once
 * here because three passes ask the same question of a differently-obtained
 * type — `localBinding` of the walker's binding, `selfField` of the field's
 * recorded type, `chainType` of what the fold arrived at — and the verbatim
 * `<Type>#<member>` lookup two of them used instead is blind to inheritance:
 * polar's `self.client.build_request()` types `client` to `SyncClientBase` and
 * `build_request` is declared on `BuildRequestMixin`, a base of it. 752 rows.
 *
 * The verdict is the CALLER's. `unbound` and `closed` and `external` are three
 * different pieces of evidence and the passes act on them differently; this
 * function never fabricates a target to settle one.
 *
 * `options.spellingOrder` is forwarded to {@link resolvePythonInheritedMember}:
 * a receiver that IS the class object asks `classFirst`. Omitted, the order is
 * the instance-first default every existing caller relies on.
 */
export function resolvePythonMemberOnTypeThroughMro(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext>,
  options: { readonly spellingOrder?: "instanceFirst" | "classFirst" } = {},
): PythonTypeMemberResolution {
  const classKey = pythonTypeRefClassKey(typeName, ctx, mapper);
  if (classKey === null) return UNBOUND_TYPE_MEMBER;
  return resolvePythonInheritedMember(classKey, member, ctx, mode, linearizer, {
    spellingOrder: options.spellingOrder,
  });
}

/**
 * Resolve `<member>` against `startClass` and, on a miss, its IN-PROJECT
 * base-class chain (`classExtends`). bd tea-rags-mcp-yrs0.
 *
 * Walk order: the class itself first (so a method defined on the direct
 * class always wins over an inherited one), then each ancestor reached
 * via single-inheritance `classExtends`, left-to-right MRO-ish. Instance
 * form (`Class#member`) is preferred at each level, static form
 * (`Class.member`) is the fallback.
 *
 * Safety:
 *   - CYCLE GUARD: a `visited` set breaks `A extends B extends A` and
 *     self-references — the walk always terminates.
 *   - IN-PROJECT ONLY: an ancestor whose definition is not in the symbol
 *     table (external base — Django CBVs, werkzeug) yields no lookup hit
 *     and the branch simply continues to its parent (which is usually
 *     undefined for an external base, ending the walk). No edge is
 *     fabricated for an external method.
 *   - DROP on miss: when no class in the chain defines `member`, returns
 *     `null` so the caller does NOT fall through to ambiguous global
 *     short-name resolution.
 */
export function walkClassExtendsForMethod(
  startClass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const visited = new Set<string>();
  let current: string | undefined = startClass;
  while (current && !visited.has(current)) {
    visited.add(current);
    const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}#${member}`), mode);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}.${member}`), mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    current = identifierEntry(ctx.classExtends, current);
  }
  return null;
}

/**
 * Resolve `<typeName>.<member>` inside the file that defines `typeName`, then
 * up its IN-PROJECT `classExtends` chain. `null` when no class in the chain
 * defines the member — the CALLER decides whether that is a file-only edge
 * (a direct local binding, bd tea-rags-mcp-yrs0 / 86qfb) or a DROP (a folded
 * chain type, which has no measurement supporting the weaker answer).
 */
export function resolvePythonMemberOnType(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
): SymbolResolutionTarget | null {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeRefFile(typeName, ctx, mapper, member);
  if (!targetFile) return null;
  const candidates = lookupPythonSymbolsByShortName(ctx, member, { role: "callee" }).filter(
    (def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType,
  );
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  // bd tea-rags-mcp-yrs0 — `member` is not defined on the type itself. Walk its
  // IN-PROJECT base chain before giving up: an inherited `Leaf().shared()`
  // where `shared` lives on `Base` resolves to `Base#shared`. The walk starts
  // one level up (the type was already checked above).
  const parent = identifierEntry(ctx.classExtends, bareType);
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}
