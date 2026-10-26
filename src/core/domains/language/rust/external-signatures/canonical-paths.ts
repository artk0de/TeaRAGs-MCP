/**
 * The module graph of the external crates one extraction reads, and the two
 * answers built over it: what a path spelled inside a module names (`use`
 * declarations, globs, `extern crate` aliases, the prelude), and the canonical
 * path of every type-like item — the shortest PUBLIC path, `std` before `alloc`
 * before `core` before any other crate on a tie. An item no public path reaches
 * (everything under std's private `sys`) has no public path at all.
 */
import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { RustImportBinding } from "../resolver/strategies/shared.js";

export type RustDeclaredItemKind = "module" | "type" | "trait" | "alias" | "fn";

export interface RustDeclaredItem {
  readonly kind: RustDeclaredItemKind;
  readonly pub: boolean;
  readonly declPath: string;
  /** Set for `kind: "module"`. */
  readonly module?: RustModuleScope;
  /** The shortest public path, assigned by `RustCrateGraph#assignCanonicalPaths`. */
  publicPath?: string;
}

export interface RustUseTarget {
  readonly prefix: RustImportBinding["prefix"];
  readonly superDepth: number;
  readonly segments: readonly string[];
}

export type RustPathResolution =
  | { readonly kind: "item"; readonly item: RustDeclaredItem }
  | { readonly kind: "external"; readonly path: readonly string[] };

const STD_CRATE_ORDER = ["std", "alloc", "core"];
const STD_PRELUDE_MODULES = ["rust_2024", "rust_2021", "v1"];
const MAX_PUBLIC_PATH_DEPTH = 10;

/** The std prelude's names as canonical paths — read only when no std source is part of the extraction. */
const STD_PRELUDE_FALLBACK: Readonly<Record<string, string>> = {
  Option: "std::option::Option",
  Result: "std::result::Result",
  Vec: "std::vec::Vec",
  String: "std::string::String",
  Box: "std::boxed::Box",
  Iterator: "std::iter::Iterator",
  IntoIterator: "std::iter::IntoIterator",
  DoubleEndedIterator: "std::iter::DoubleEndedIterator",
  ExactSizeIterator: "std::iter::ExactSizeIterator",
  Extend: "std::iter::Extend",
  FromIterator: "std::iter::FromIterator",
  Clone: "std::clone::Clone",
  Default: "std::default::Default",
  ToOwned: "std::borrow::ToOwned",
  ToString: "std::string::ToString",
  Drop: "std::ops::Drop",
  Copy: "std::marker::Copy",
  Send: "std::marker::Send",
  Sync: "std::marker::Sync",
  Sized: "std::marker::Sized",
  PartialEq: "std::cmp::PartialEq",
  Eq: "std::cmp::Eq",
  PartialOrd: "std::cmp::PartialOrd",
  Ord: "std::cmp::Ord",
  AsRef: "std::convert::AsRef",
  AsMut: "std::convert::AsMut",
  From: "std::convert::From",
  Into: "std::convert::Into",
  TryFrom: "std::convert::TryFrom",
  TryInto: "std::convert::TryInto",
};

export function rustUseTargetSegments(binding: {
  moduleSegments: readonly string[];
  sourceName: string | null;
}): string[] {
  return binding.sourceName === null ? [...binding.moduleSegments] : [...binding.moduleSegments, binding.sourceName];
}

export class RustModuleScope {
  /** The type namespace: modules, types, traits, aliases. */
  readonly items = new Map<string, RustDeclaredItem>();
  /**
   * The value namespace: free functions. Apart from `items` because Rust keeps
   * the namespaces apart — `mod spawn; pub use spawn::spawn;` binds `spawn` in
   * both, the module in one and the function in the other.
   */
  readonly values = new Map<string, RustDeclaredItem>();
  readonly uses: { readonly localName: string; readonly pub: boolean; readonly target: RustUseTarget }[] = [];
  readonly globs: { readonly pub: boolean; readonly target: RustUseTarget }[] = [];

  constructor(
    readonly crate: string,
    readonly segments: readonly string[],
    readonly parent: RustModuleScope | undefined,
  ) {}

  get declPath(): string {
    return [this.crate, ...this.segments].join("::");
  }

  declare(name: string, kind: Exclude<RustDeclaredItemKind, "module" | "fn">, pub: boolean): RustDeclaredItem {
    const existing = this.items.get(name);
    if (existing !== undefined) return existing;
    const item: RustDeclaredItem = { kind, pub, declPath: `${this.declPath}::${name}` };
    this.items.set(name, item);
    return item;
  }

  /** A module-level `fn` — first declaration wins, so two cfg arms share one item. */
  declareValue(name: string, pub: boolean): RustDeclaredItem {
    const existing = this.values.get(name);
    if (existing !== undefined) return existing;
    const item: RustDeclaredItem = { kind: "fn", pub, declPath: `${this.declPath}::${name}` };
    this.values.set(name, item);
    return item;
  }
}

export class RustCrateGraph {
  private readonly modules = new Map<string, RustModuleScope>();
  private readonly externAliases = new Map<string, Map<string, string>>();
  private readonly preludes = new Map<string, { readonly scope: RustModuleScope; readonly target: RustUseTarget }>();
  private readonly lookupMemo = new Map<string, RustPathResolution | undefined>();
  private readonly lookupInFlight = new Set<string>();
  private readonly publicNamesMemo = new Map<string, Map<string, RustDeclaredItem>>();
  private readonly publicValuesMemo = new Map<string, Map<string, RustDeclaredItem>>();

  /** The module scope at `segments` inside `crate`, created on first ask. */
  module(crate: string, segments: readonly string[]): RustModuleScope {
    const key = [crate, ...segments].join("::");
    const existing = this.modules.get(key);
    if (existing !== undefined) return existing;
    const parent = segments.length === 0 ? undefined : this.module(crate, segments.slice(0, -1));
    const scope = new RustModuleScope(crate, segments, parent);
    this.modules.set(key, scope);
    return scope;
  }

  /** `mod name;` / `mod name { … }` in `scope`. */
  declareModule(scope: RustModuleScope, name: string, pub: boolean): RustModuleScope {
    const child = this.module(scope.crate, [...scope.segments, name]);
    if (!scope.items.has(name)) scope.items.set(name, { kind: "module", pub, declPath: child.declPath, module: child });
    return child;
  }

  declareExternCrate(crate: string, name: string, alias: string): void {
    let aliases = this.externAliases.get(crate);
    if (aliases === undefined) {
      aliases = new Map();
      this.externAliases.set(crate, aliases);
    }
    aliases.set(alias, name);
  }

  /** `#[prelude_import] use prelude::rust_2024::*;` — the glob every module of the crate falls back to. */
  declarePrelude(scope: RustModuleScope, target: RustUseTarget): void {
    this.preludes.set(scope.crate, { scope, target });
  }

  /** Crates in canonical tie-break order: std, alloc, core, then the rest by name. */
  crates(): string[] {
    const crates = new Set([...this.modules.values()].map((scope) => scope.crate));
    const std = STD_CRATE_ORDER.filter((crate) => crates.has(crate));
    const rest = [...crates].filter((crate) => !STD_CRATE_ORDER.includes(crate)).sort();
    return [...std, ...rest];
  }

  /** What a `use` target (or a path spelled in `from`) names. */
  resolve(target: RustUseTarget, from: RustModuleScope): RustPathResolution | undefined {
    const { segments } = target;
    if (segments.length === 0) return undefined;
    if (target.prefix === "crate") return this.walk(this.module(from.crate, []), segments);
    if (target.prefix === "self") return this.walk(from, segments);
    if (target.prefix === "super") {
      let scope: RustModuleScope | undefined = from;
      for (let depth = 0; depth < target.superDepth; depth++) scope = scope?.parent;
      return scope === undefined ? undefined : this.walk(scope, segments);
    }
    const [first, ...rest] = segments;
    const local = this.lookupName(from, first);
    if (local !== undefined) return this.continueFrom(local, rest);
    const crate = this.externAliases.get(from.crate)?.get(first) ?? first;
    // A bare crate name names a crate, never an item.
    if (rest.length === 0) return undefined;
    if (this.modules.has(crate)) return this.walk(this.module(crate, []), rest);
    return { kind: "external", path: [crate, ...rest] };
  }

  /**
   * The canonical path a type spelled in `scope` names, or `undefined` when it
   * names nothing type-like the graph can prove. A bare name the module does not
   * bind falls back to the crate's prelude.
   */
  resolveTypeSpelling(spelling: string, scope: RustModuleScope): string | undefined {
    const resolution = this.resolveType(spelling, scope);
    if (resolution === undefined) return undefined;
    if (resolution.kind === "external") return resolution.path.join("::");
    return resolution.item.kind === "module" ? undefined : rustCanonicalPathOf(resolution.item);
  }

  /** What a type spelled in `scope` resolves to, before it is read as a path. */
  resolveType(spelling: string, scope: RustModuleScope): RustPathResolution | undefined {
    const target = rustSpelledTarget(spelling);
    if (target === undefined) return undefined;
    const resolution = this.resolve(target, scope);
    if (resolution !== undefined || target.prefix !== null || target.segments.length !== 1) return resolution;
    return this.resolvePrelude(target.segments[0], scope.crate);
  }

  /**
   * What a function spelled in `scope` resolves to in the VALUE namespace: the
   * segments before the last walk the module graph as `resolve` does, the last
   * one is looked up among the module's functions. No prelude fallback.
   */
  resolveValue(spelling: string, scope: RustModuleScope): RustPathResolution | undefined {
    const target = rustSpelledTarget(spelling);
    return target === undefined ? undefined : this.resolveValueTarget(target, scope);
  }

  /**
   * Assign every public type-like item its shortest public path (breadth-first
   * from the crate roots, std first) and return every public spelling → that
   * canonical path. Each module is expanded once per crate root, so the spelling
   * `core::option::Option` exists next to `std::option::Option`. The same walk
   * assigns every public free function its path in the value namespace.
   */
  assignCanonicalPaths(): { paths: Record<string, string>; functionPaths: Record<string, string> } {
    const paths = createIdentifierRecord<string>();
    const functionPaths = createIdentifierRecord<string>();
    const queue: { scope: RustModuleScope; path: readonly string[]; root: string }[] = this.crates().map((crate) => ({
      scope: this.module(crate, []),
      path: [crate],
      root: crate,
    }));
    const expanded = new Set(queue.map((entry) => `${entry.root}\0${entry.scope.declPath}`));
    // The queue grows while it is read: a for-of over an array visits pushed entries.
    for (const { scope, path, root } of queue) {
      for (const [name, item] of [...this.publicNames(scope)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const spelled = [...path, name];
        if (item.kind === "module") {
          const key = `${root}\0${item.declPath}`;
          if (item.module !== undefined && !expanded.has(key) && spelled.length < MAX_PUBLIC_PATH_DEPTH) {
            expanded.add(key);
            queue.push({ scope: item.module, path: spelled, root });
          }
          continue;
        }
        item.publicPath ??= spelled.join("::");
        paths[spelled.join("::")] = item.publicPath;
      }
      for (const [name, item] of [...this.publicValues(scope)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const spelled = [...path, name].join("::");
        item.publicPath ??= spelled;
        functionPaths[spelled] = item.publicPath;
      }
    }
    return { paths, functionPaths };
  }

  private resolvePrelude(name: string, crate: string): RustPathResolution | undefined {
    const prelude = this.preludes.get(crate);
    if (prelude !== undefined) {
      const target = this.resolve(prelude.target, prelude.scope);
      if (target?.kind === "item" && target.item.module !== undefined) {
        const found = this.lookupName(target.item.module, name);
        if (found !== undefined) return found;
      }
    }
    if (this.modules.has("std")) {
      for (const edition of STD_PRELUDE_MODULES) {
        const module = this.modules.get(`std::prelude::${edition}`);
        const found = module === undefined ? undefined : this.lookupName(module, name);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const fallback = Object.hasOwn(STD_PRELUDE_FALLBACK, name) ? STD_PRELUDE_FALLBACK[name] : undefined;
    return fallback === undefined ? undefined : { kind: "external", path: fallback.split("::") };
  }

  private walk(start: RustModuleScope, segments: readonly string[]): RustPathResolution | undefined {
    if (segments.length === 0) return undefined;
    const found = this.lookupName(start, segments[0]);
    return found === undefined ? undefined : this.continueFrom(found, segments.slice(1));
  }

  private continueFrom(found: RustPathResolution, rest: readonly string[]): RustPathResolution | undefined {
    if (rest.length === 0) return found;
    if (found.kind === "external") return { kind: "external", path: [...found.path, ...rest] };
    return found.item.module === undefined ? undefined : this.walk(found.item.module, rest);
  }

  /** A name bound in `scope` — declared, `use`d, or glob-imported. */
  private lookupName(scope: RustModuleScope, name: string): RustPathResolution | undefined {
    const key = `${scope.declPath}\0${name}`;
    if (this.lookupMemo.has(key)) return this.lookupMemo.get(key);
    if (this.lookupInFlight.has(key)) return undefined;
    this.lookupInFlight.add(key);
    const declared = scope.items.get(name);
    let found: RustPathResolution | undefined = declared === undefined ? undefined : { kind: "item", item: declared };
    for (const use of scope.uses) {
      if (found !== undefined) break;
      if (use.localName === name) found = this.resolve(use.target, scope);
    }
    for (const glob of scope.globs) {
      if (found !== undefined) break;
      const target = this.resolve(glob.target, scope);
      if (target?.kind === "item" && target.item.module !== undefined && target.item.module !== scope) {
        found = this.lookupName(target.item.module, name);
      }
    }
    this.lookupInFlight.delete(key);
    this.lookupMemo.set(key, found);
    return found;
  }

  /** A `use` target (or spelled path) read in the value namespace. */
  private resolveValueTarget(target: RustUseTarget, from: RustModuleScope): RustPathResolution | undefined {
    const { segments } = target;
    if (segments.length === 0) return undefined;
    const name = segments[segments.length - 1];
    if (target.prefix === null && segments.length === 1) return this.lookupValue(from, name);
    const owner = this.resolveModule({ ...target, segments: segments.slice(0, -1) }, from);
    if (owner === undefined) return undefined;
    if (owner.kind === "external") return { kind: "external", path: [...owner.path, name] };
    return this.lookupValue(owner.scope, name);
  }

  /** The module a path of module segments names: `crate` / `self` / `super` alone, a crate name, or a walked path. */
  private resolveModule(
    target: RustUseTarget,
    from: RustModuleScope,
  ): { kind: "module"; scope: RustModuleScope } | { kind: "external"; path: readonly string[] } | undefined {
    if (target.segments.length === 0) {
      if (target.prefix === "crate") return { kind: "module", scope: this.module(from.crate, []) };
      if (target.prefix === "self") return { kind: "module", scope: from };
      if (target.prefix !== "super") return undefined;
      let scope: RustModuleScope | undefined = from;
      for (let depth = 0; depth < target.superDepth; depth++) scope = scope?.parent;
      return scope === undefined ? undefined : { kind: "module", scope };
    }
    const resolution = this.resolve(target, from);
    if (resolution?.kind === "item") {
      return resolution.item.module === undefined ? undefined : { kind: "module", scope: resolution.item.module };
    }
    if (resolution?.kind === "external") return { kind: "external", path: resolution.path };
    if (target.prefix !== null || target.segments.length !== 1) return undefined;
    // A bare crate name: `resolve` names no item by it, but in a value path it owns the next segment.
    const crate = this.externAliases.get(from.crate)?.get(target.segments[0]) ?? target.segments[0];
    return this.modules.has(crate)
      ? { kind: "module", scope: this.module(crate, []) }
      : { kind: "external", path: [crate] };
  }

  /** A function name bound in `scope` — declared, `use`d, or glob-imported. */
  private lookupValue(scope: RustModuleScope, name: string): RustPathResolution | undefined {
    const key = `value\0${scope.declPath}\0${name}`;
    if (this.lookupMemo.has(key)) return this.lookupMemo.get(key);
    if (this.lookupInFlight.has(key)) return undefined;
    this.lookupInFlight.add(key);
    const declared = scope.values.get(name);
    let found: RustPathResolution | undefined = declared === undefined ? undefined : { kind: "item", item: declared };
    for (const use of scope.uses) {
      if (found !== undefined) break;
      if (use.localName === name) found = this.resolveValueTarget(use.target, scope);
    }
    for (const glob of scope.globs) {
      if (found !== undefined) break;
      const target = this.resolve(glob.target, scope);
      if (target?.kind === "item" && target.item.module !== undefined && target.item.module !== scope) {
        found = this.lookupValue(target.item.module, name);
      }
    }
    this.lookupInFlight.delete(key);
    this.lookupMemo.set(key, found);
    return found;
  }

  /** The functions `scope` exposes publicly — `pub fn`, `pub use`, `pub use …::*`. */
  private publicValues(scope: RustModuleScope): Map<string, RustDeclaredItem> {
    const memo = this.publicValuesMemo.get(scope.declPath);
    if (memo !== undefined) return memo;
    const names = new Map<string, RustDeclaredItem>();
    this.publicValuesMemo.set(scope.declPath, names);
    for (const [name, item] of scope.values) if (item.pub) names.set(name, item);
    for (const use of scope.uses) {
      if (!use.pub || names.has(use.localName)) continue;
      const target = this.resolveValueTarget(use.target, scope);
      if (target?.kind === "item") names.set(use.localName, target.item);
    }
    for (const glob of scope.globs) {
      if (!glob.pub) continue;
      const target = this.resolve(glob.target, scope);
      if (target?.kind !== "item" || target.item.module === undefined || target.item.module === scope) continue;
      for (const [name, item] of this.publicValues(target.item.module)) if (!names.has(name)) names.set(name, item);
    }
    return names;
  }

  /** The names `scope` exposes publicly — `pub` items, `pub use`, `pub use …::*`. */
  private publicNames(scope: RustModuleScope): Map<string, RustDeclaredItem> {
    const memo = this.publicNamesMemo.get(scope.declPath);
    if (memo !== undefined) return memo;
    const names = new Map<string, RustDeclaredItem>();
    this.publicNamesMemo.set(scope.declPath, names);
    for (const [name, item] of scope.items) if (item.pub) names.set(name, item);
    for (const use of scope.uses) {
      if (!use.pub || names.has(use.localName)) continue;
      const target = this.resolve(use.target, scope);
      if (target?.kind === "item") names.set(use.localName, target.item);
    }
    for (const glob of scope.globs) {
      if (!glob.pub) continue;
      const target = this.resolve(glob.target, scope);
      if (target?.kind !== "item" || target.item.module === undefined || target.item.module === scope) continue;
      for (const [name, item] of this.publicNames(target.item.module)) if (!names.has(name)) names.set(name, item);
    }
    return names;
  }
}

/** A spelled path (`::a::b`, `crate::a`, `super::super::a`) as a `use` target; `undefined` on an empty segment. */
function rustSpelledTarget(spelling: string): RustUseTarget | undefined {
  const absolute = spelling.startsWith("::");
  const segments = (absolute ? spelling.slice(2) : spelling).split("::");
  if (segments.some((segment) => segment.length === 0)) return undefined;
  if (segments[0] === "crate" || segments[0] === "self") {
    return { prefix: segments[0], superDepth: 0, segments: segments.slice(1) };
  }
  if (segments[0] !== "super") return { prefix: null, superDepth: 0, segments };
  let rest = segments;
  let superDepth = 0;
  while (rest[0] === "super") {
    superDepth++;
    rest = rest.slice(1);
  }
  return { prefix: "super", superDepth, segments: rest };
}

/** The path a table names an item by: its shortest public path, else its declaration path. */
export function rustCanonicalPathOf(item: RustDeclaredItem): string {
  return item.publicPath ?? item.declPath;
}
