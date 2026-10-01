/**
 * The Swift SDK substrate, read — what the standard library, Foundation,
 * Dispatch, Combine and the UI frameworks declare, as the resolver asks it
 * (bd tea-rags-mcp-y99pg).
 *
 * The data is GENERATED (`./sdk-vocabulary.generated.json`, by
 * `scripts/gen-swift-sdk-vocabulary.ts` from `swift-symbolgraph-extract`) and
 * replaces the hand-written name lists the resolver used to carry: which
 * UpperCamelCase names are SDK types, which supertypes an SDK type has, and
 * whether a name may be an SDK protocol. It answers three more questions no
 * list could: which members a type declares (its own, then its superclass
 * chain's and its conformances', walked here exactly as Swift's member lookup
 * walks them), what each member's declared or returned type is, and what a
 * closure a member takes is called with — and, for the module-level
 * functions that take one, what that closure is called with.
 *
 * Constructed only through {@link swiftSdkVocabulary}: the JSON is read and
 * parsed once per process, on first use, and every resolver shares the result
 * — it is immutable, so nothing about a run can leak through it. The data is a
 * file beside this module, never an import: importing the language domain
 * (every chunker worker does) must not pay for 2.3 MB a run without Swift never
 * reads (bd tea-rags-mcp-bbo1h.3). `npm run build` copies it into `build/`.
 */

import { readFileSync } from "node:fs";

/** The generated asset, resolved beside this module in `src/` and in `build/` alike. */
const VOCABULARY_ASSET = new URL("./sdk-vocabulary.generated.json", import.meta.url);

/** What a member of an SDK type is. */
export type SwiftSdkMemberKind = "property" | "method" | "init" | "case" | "subscript";

/** One declared shape of an SDK member; overloads that agree collapse to one. */
export interface SwiftSdkMember {
  readonly kind: SwiftSdkMemberKind;
  readonly isStatic: boolean;
  /** A property's declared type, a method's / subscript's return; `null` for `Void` and for a case. */
  readonly returns: string | null;
  /** Each parameter's type when it is a function type, positionally; `""` for any other parameter. */
  readonly closureParameters: readonly string[];
  /** The member's own generic parameters, each with its first conformance or superclass constraint. */
  readonly genericParameters: ReadonlyMap<string, string | null>;
}

/** The kind of an SDK type. */
export type SwiftSdkTypeKind = "struct" | "class" | "enum" | "protocol" | "actor";

/** An SDK type, as the substrate records it. */
export interface SwiftSdkType {
  readonly path: string;
  readonly kind: SwiftSdkTypeKind;
  /** Generic parameters, outer type's first for a nested type (`AsyncStream.Continuation` → `Element`). */
  readonly genericParameters: readonly string[];
  /** A generic parameter's first conformance or superclass constraint (`Result`'s `Failure` → `Error`). */
  readonly genericConstraints: Readonly<Record<string, string>>;
  readonly superclass: string | undefined;
  readonly conformances: readonly string[];
  /** Member type aliases and associated-type defaults (`Array.SubSequence` → `ArraySlice<Element>`). */
  readonly aliases: Readonly<Record<string, string>>;
  /** Every member name the type itself declares. */
  readonly memberNames: readonly string[];
}

interface RawType {
  readonly k: string;
  readonly g?: readonly string[];
  readonly gc?: Readonly<Record<string, string>>;
  readonly sup?: string;
  readonly c?: readonly string[];
  readonly t?: Readonly<Record<string, string>>;
  readonly m: Readonly<Record<string, readonly string[]>>;
}

interface RawVocabulary {
  readonly v: number;
  /** Provenance — generator, toolchain, SDKs, modules. Never read by resolution. */
  readonly meta?: unknown;
  readonly types: Readonly<Record<string, RawType>>;
  /** Module-level functions that take a closure, by base name (bd tea-rags-mcp-y99pg.29). */
  readonly functions?: Readonly<Record<string, readonly string[]>>;
  /** The standard library's value-returning free functions, by full name with labels (bd tea-rags-mcp-3j7rg). */
  readonly labelled?: Readonly<Record<string, readonly string[]>>;
}

const TYPE_KINDS: Readonly<Record<string, SwiftSdkTypeKind>> = {
  s: "struct",
  c: "class",
  e: "enum",
  p: "protocol",
  a: "actor",
};

const MEMBER_KINDS: Readonly<Record<string, SwiftSdkMemberKind>> = {
  p: "property",
  m: "method",
  i: "init",
  c: "case",
  x: "subscript",
};

/** A member found by {@link SwiftSdkVocabulary#findMember}: its shapes and the type declaring them. */
export interface SwiftSdkMemberHit {
  readonly owner: SwiftSdkType;
  readonly members: readonly SwiftSdkMember[];
}

export class SwiftSdkVocabulary {
  private readonly typeCache = new Map<string, SwiftSdkType>();
  private readonly memberCache = new Map<string, readonly SwiftSdkMember[]>();
  private readonly supertypeCache = new Map<string, readonly string[]>();
  private readonly functionCache = new Map<string, readonly SwiftSdkMember[]>();
  private readonly labelledFunctionCache = new Map<string, readonly SwiftSdkMember[]>();

  constructor(private readonly raw: RawVocabulary) {}

  /** Whether the SDK declares a type of this full path. */
  hasType(path: string): boolean {
    return Object.hasOwn(this.raw.types, path);
  }

  type(path: string): SwiftSdkType | undefined {
    const cached = this.typeCache.get(path);
    if (cached !== undefined) return cached;
    if (!this.hasType(path)) return undefined;
    const raw = this.raw.types[path];
    const type: SwiftSdkType = {
      path,
      kind: TYPE_KINDS[raw.k] ?? "struct",
      genericParameters: raw.g ?? [],
      genericConstraints: raw.gc ?? {},
      superclass: raw.sup,
      conformances: raw.c ?? [],
      aliases: raw.t ?? {},
      memberNames: Object.keys(raw.m),
    };
    this.typeCache.set(path, type);
    return type;
  }

  /** The shapes `path` ITSELF declares for `name` — no supertype is read. */
  ownMembers(path: string, name: string): readonly SwiftSdkMember[] {
    const key = `${path}\u0000${name}`;
    const cached = this.memberCache.get(key);
    if (cached !== undefined) return cached;
    const raw = this.hasType(path) ? this.raw.types[path].m : undefined;
    const signatures = raw !== undefined && Object.hasOwn(raw, name) ? raw[name] : [];
    const members = signatures.map(parseSignature);
    this.memberCache.set(key, members);
    return members;
  }

  /**
   * The shapes of the module-level function `name` — only one taking a
   * closure is recorded, since a closure parameter is all resolution reads off
   * a free function (bd tea-rags-mcp-y99pg.29).
   */
  globalFunctions(name: string): readonly SwiftSdkMember[] {
    const cached = this.functionCache.get(name);
    if (cached !== undefined) return cached;
    const raw = this.raw.functions;
    const shapes = raw !== undefined && Object.hasOwn(raw, name) ? raw[name].map(parseSignature) : [];
    this.functionCache.set(name, shapes);
    return shapes;
  }

  /**
   * The shapes of the standard library's free function whose FULL name —
   * labels included, `_` for an unlabelled parameter — is `fullName`
   * (`stride(from:to:by:)`, bd tea-rags-mcp-3j7rg). Only value-returning
   * functions are recorded: a chain head reads nothing else.
   */
  labelledGlobalFunction(fullName: string): readonly SwiftSdkMember[] {
    const cached = this.labelledFunctionCache.get(fullName);
    if (cached !== undefined) return cached;
    const raw = this.raw.labelled;
    const shapes = raw !== undefined && Object.hasOwn(raw, fullName) ? raw[fullName].map(parseSignature) : [];
    this.labelledFunctionCache.set(fullName, shapes);
    return shapes;
  }

  /**
   * The direct supertypes of `path`: its superclass first — Swift requires it
   * first in a clause — then its conformances, as the substrate lists them.
   */
  directSupertypes(path: string): readonly string[] {
    const type = this.type(path);
    if (type === undefined) return [];
    return type.superclass === undefined ? type.conformances : [type.superclass, ...type.conformances];
  }

  /**
   * `path` and every type its member lookup reads, in Swift's order: the
   * superclass chain, then the conformances of each class on it, breadth
   * first, each type once.
   */
  supertypes(path: string): readonly string[] {
    const cached = this.supertypeCache.get(path);
    if (cached !== undefined) return cached;
    const order: string[] = [];
    const seen = new Set<string>();
    const classes: string[] = [];
    for (let current: string | undefined = path; current !== undefined && !seen.has(current); ) {
      seen.add(current);
      classes.push(current);
      current = this.type(current)?.superclass;
    }
    order.push(...classes);
    const queue = classes.flatMap((c) => this.type(c)?.conformances ?? []);
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(...this.directSupertypes(next));
    }
    this.supertypeCache.set(path, order);
    return order;
  }

  /** The first type in `path`'s lookup order declaring `name`, with that type's shapes of it. */
  findMember(path: string, name: string): SwiftSdkMemberHit | undefined {
    for (const candidate of this.supertypes(path)) {
      const members = this.ownMembers(candidate, name);
      const owner = this.type(candidate);
      if (members.length > 0 && owner !== undefined) return { owner, members };
    }
    return undefined;
  }

  /** The member type alias `name` as `path`'s lookup order first declares it, with its declaring type. */
  findAlias(path: string, name: string): { readonly text: string; readonly owner: SwiftSdkType } | undefined {
    for (const candidate of this.supertypes(path)) {
      const owner = this.type(candidate);
      if (owner !== undefined && Object.hasOwn(owner.aliases, name)) return { text: owner.aliases[name], owner };
    }
    return undefined;
  }
}

/** `code[^g1,g2:C][>returns][|closure]*` — the generator's signature string. */
function parseSignature(signature: string): SwiftSdkMember {
  const [head, ...closures] = signature.split("|");
  const code = /^[a-zA-Z]+/.exec(head)?.[0] ?? "m";
  let rest = head.slice(code.length);
  const genericParameters = new Map<string, string | null>();
  if (rest.startsWith("^")) {
    const end = rest.indexOf(">");
    const list = end === -1 ? rest.slice(1) : rest.slice(1, end);
    rest = end === -1 ? "" : rest.slice(end);
    for (const entry of list.split(",")) {
      const [name, constraint] = entry.split(":");
      if (name) genericParameters.set(name, constraint ?? null);
    }
  }
  const returns = rest.startsWith(">") ? rest.slice(1) : null;
  return {
    kind: MEMBER_KINDS[code[0]] ?? "method",
    isStatic: code.includes("S"),
    returns,
    closureParameters: closures,
    genericParameters,
  };
}

let shared: SwiftSdkVocabulary | undefined;

/** The process-wide SDK vocabulary, read and parsed on first use. */
export function swiftSdkVocabulary(): SwiftSdkVocabulary {
  shared ??= new SwiftSdkVocabulary(JSON.parse(readFileSync(VOCABULARY_ASSET, "utf8")) as RawVocabulary);
  return shared;
}
