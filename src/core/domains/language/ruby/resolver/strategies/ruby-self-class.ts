import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  LocalBinding,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type {
  DispatchResolverComponent,
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import { RubyConeDispatchResolver } from "./ruby-cone-dispatch.js";
import {
  callerAncestrySide,
  lastConstantSegment,
  lookupRubySymbolsByShortName,
  resolveConstant,
  resolveRubyInitializer,
  resolveTypeStaticMethod,
  symbolIdIsClassMethod,
  type ResolverConfig,
} from "./shared.js";

const SELF_CLASS = "self.class";

/**
 * The class a `self.class` receiver names (bd tea-rags-mcp-2m83f.58): inside an
 * instance method of class `C` it is `C` or a subclass of `C`. `null` when the
 * caller is no instance method (in `def self.x` it is `Class`), when the
 * enclosing scope is a module (`self.class` is the includer there), or when `C`
 * resolves to no project file.
 */
export function selfClassReceiverType(call: CallRef, ctx: CallContext): string | null {
  if (call.receiver !== SELF_CLASS || ctx.callerScope.length === 0) return null;
  if (callerAncestrySide(ctx) !== "instance") return null;
  const klass = ctx.callerScope.join("::");
  if (resolveConstant(klass, ctx) === null) return null;
  const declarations = lookupRubySymbolsByShortName(ctx, lastConstantSegment(klass), { role: "receiver" }).filter(
    (def) => def.fqName === klass && def.symbolKind !== undefined,
  );
  if (declarations.length > 0 && declarations.every((def) => def.symbolKind === "module")) return null;
  return klass;
}

/**
 * `self.class.m` → the singleton `m` the class's ancestry declares; `self.class.new`
 * → a declared singleton `new`, else the `initialize` the instance ancestry finds.
 * Method-level or `null`.
 */
export function resolveSelfClassTarget(
  klass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const singleton = resolveTypeStaticMethod(klass, member, ctx, mode);
  if (singleton?.targetSymbolId) return singleton;
  return member === "new" ? resolveRubyInitializer(klass, ctx, mode) : null;
}

/**
 * Chain pass for a `self.class` receiver. A singleton member the ancestry never
 * declares (`self.class.name`) CONTINUEs, so it stays external; `new` with no
 * declared constructor takes `C.new`'s file-only edge.
 */
export class RubySelfClassSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfClass";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const klass = selfClassReceiverType(call, ctx);
    if (klass === null) return CONTINUE;
    const target = resolveSelfClassTarget(klass, call.member, ctx, this.cfg.mode);
    if (target) return resolved(target);
    if (call.member !== "new") return CONTINUE;
    const file = resolveConstant(klass, ctx);
    return file ? resolved({ targetRelPath: file, targetSymbolId: null }) : CONTINUE;
  }
}

/**
 * The CHA cone over a `self.class` receiver: typed as the class value `C`, it
 * fans out to the subclasses that redefine the singleton member (`Sub.m` only).
 * `new` never cones — the constructor is the chain's.
 */
export class RubySelfClassConeDispatchResolver implements DispatchResolverComponent {
  private readonly cone: RubyConeDispatchResolver;

  constructor(cfg: ResolverConfig) {
    this.cone = new RubyConeDispatchResolver(cfg, symbolIdIsClassMethod);
  }

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    const klass = call.member === "new" ? null : selfClassReceiverType(call, ctx);
    if (klass === null) return { kind: "edges", edges: [] };
    const binding: LocalBinding = { line: 0, type: klass, valueKind: "class" };
    return this.cone.resolveDispatch(call, {
      ...ctx,
      localBindings: { ...ctx.localBindings, [SELF_CLASS]: [binding] },
    });
  }
}
