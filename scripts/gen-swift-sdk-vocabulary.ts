/**
 * gen-swift-sdk-vocabulary.ts (bd tea-rags-mcp-y99pg)
 *
 * Generates `src/core/domains/language/swift/vocabulary/sdk-vocabulary.generated.ts`
 * — the Swift SDK substrate the resolver reads instead of hand-written type
 * and protocol name lists.
 *
 * Source: `swift-symbolgraph-extract` over the modules Swift corpora import,
 * with synthesized members SKIPPED — a member a protocol extension or a
 * superclass provides is found at resolve time by walking the conformance and
 * superclass edges the artifact keeps, which is both smaller and what Swift's
 * own member lookup does.
 *
 * What survives into the artifact is only what resolution reads: per type its
 * kind, generic parameters (and their conformance constraints), superclass,
 * conformances, member type aliases / associated-type defaults, and per member
 * its kind, staticness, declared type or return type, the types of its
 * FUNCTION-typed parameters, and its own generic parameters. Overloads that
 * agree on all of those collapse to one signature: argument labels are not
 * kept, because only the PROJECT's overloads are ever picked by label — an SDK
 * overload set answers "declared" and "returns". Type spellings are rebuilt from the
 * declaration fragments with every nominal re-spelled by its full path (the
 * fragment's USR says which type it is), so `Continuation` inside
 * `AsyncStream` reads `AsyncStream.Continuation`. Docs, availability,
 * operators, macros and `_`-prefixed names are dropped.
 *
 * Usage (macOS with Xcode; the SDK set is pinned below):
 *
 *   npx tsx scripts/gen-swift-sdk-vocabulary.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "src/core/domains/language/swift/vocabulary/sdk-vocabulary.generated.ts");

interface ModuleSpec {
  readonly module: string;
  readonly sdk: "macosx" | "iphoneos" | "watchos";
  readonly target: string;
}

const MAC = "arm64-apple-macosx14.0";
/**
 * The modules Swift corpora import (Alamofire's and Quick's sources, examples
 * and test support), plus the runtime modules their types live in. UIKit and
 * WatchKit exist only on their own platforms' SDKs.
 */
const MODULES: readonly ModuleSpec[] = [
  { module: "Swift", sdk: "macosx", target: MAC },
  { module: "_Concurrency", sdk: "macosx", target: MAC },
  { module: "_StringProcessing", sdk: "macosx", target: MAC },
  { module: "Foundation", sdk: "macosx", target: MAC },
  { module: "Dispatch", sdk: "macosx", target: MAC },
  { module: "Combine", sdk: "macosx", target: MAC },
  { module: "ObjectiveC", sdk: "macosx", target: MAC },
  { module: "Security", sdk: "macosx", target: MAC },
  { module: "SystemConfiguration", sdk: "macosx", target: MAC },
  { module: "Network", sdk: "macosx", target: MAC },
  { module: "UniformTypeIdentifiers", sdk: "macosx", target: MAC },
  { module: "XCTest", sdk: "macosx", target: MAC },
  { module: "SwiftUI", sdk: "macosx", target: MAC },
  { module: "UIKit", sdk: "iphoneos", target: "arm64-apple-ios17.0" },
  { module: "WatchKit", sdk: "watchos", target: "arm64-apple-watchos10.0" },
];

interface Fragment {
  readonly kind: string;
  readonly spelling: string;
  readonly preciseIdentifier?: string;
}

interface SymbolGraphSymbol {
  readonly kind: { readonly identifier: string };
  readonly identifier: { readonly precise: string };
  readonly pathComponents: readonly string[];
  readonly declarationFragments?: readonly Fragment[];
  readonly functionSignature?: {
    readonly parameters?: readonly { readonly name: string; readonly declarationFragments?: readonly Fragment[] }[];
    readonly returns?: readonly Fragment[];
  };
  readonly swiftGenerics?: {
    readonly parameters?: readonly { readonly name: string; readonly depth: number }[];
    readonly constraints?: readonly { readonly kind: string; readonly lhs: string; readonly rhs: string }[];
  };
}

interface SymbolGraph {
  readonly symbols: readonly SymbolGraphSymbol[];
  readonly relationships: readonly {
    readonly kind: string;
    readonly source: string;
    readonly target: string;
    readonly targetFallback?: string;
  }[];
}

const TYPE_KINDS: Readonly<Record<string, string>> = {
  "swift.struct": "s",
  "swift.class": "c",
  "swift.enum": "e",
  "swift.protocol": "p",
  "swift.actor": "a",
};

/** Member kinds kept, keyed to the artifact's one-letter code; `S` marks static. */
const MEMBER_KINDS: Readonly<Record<string, string>> = {
  "swift.property": "p",
  "swift.type.property": "pS",
  "swift.method": "m",
  "swift.type.method": "mS",
  "swift.init": "i",
  "swift.enum.case": "cS",
  "swift.subscript": "x",
  "swift.type.subscript": "xS",
};

/**
 * Marker protocols every type conforms to implicitly and that declare no
 * member: listing them on each of ~4,000 types costs size and buys nothing.
 */
const MARKER_PROTOCOLS: ReadonlySet<string> = new Set(["Copyable", "Escapable", "BitwiseCopyable", "SendableMetatype"]);

function sdkPath(sdk: ModuleSpec["sdk"]): string {
  return execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).trim();
}

function extract(spec: ModuleSpec, out: string): void {
  const sdk = sdkPath(spec.sdk);
  const platform = execFileSync("xcrun", ["--sdk", spec.sdk, "--show-sdk-platform-path"], { encoding: "utf8" }).trim();
  execFileSync(
    "xcrun",
    [
      "swift-symbolgraph-extract",
      "-module-name",
      spec.module,
      "-target",
      spec.target,
      "-sdk",
      sdk,
      "-F",
      join(platform, "Developer/Library/Frameworks"),
      "-I",
      join(platform, "Developer/usr/lib"),
      "-skip-synthesized-members",
      "-minimum-access-level",
      "public",
      "-output-dir",
      out,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function hidden(name: string): boolean {
  return name.startsWith("_");
}

/** `append(_:)` → `append`; `init(url:)` → `init`. */
function baseName(component: string): string {
  const paren = component.indexOf("(");
  return paren === -1 ? component : component.slice(0, paren);
}

function main(): void {
  const scratch = mkdtempSync(join(tmpdir(), "swift-sdk-vocab-"));
  const graphs: SymbolGraph[] = [];
  const toolchain =
    execFileSync("xcrun", ["swift", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .find((line) => line.includes("Swift version"))
      ?.trim() ?? "unknown toolchain";
  const sdkVersions = new Map<string, string>();
  try {
    for (const spec of MODULES) {
      const out = join(scratch, spec.module);
      execFileSync("mkdir", ["-p", out]);
      extract(spec, out);
      if (!sdkVersions.has(spec.sdk)) {
        sdkVersions.set(
          spec.sdk,
          execFileSync("xcrun", ["--sdk", spec.sdk, "--show-sdk-version"], { encoding: "utf8" }).trim(),
        );
      }
      for (const file of readdirSync(out)) {
        if (!file.endsWith(".symbols.json")) continue;
        graphs.push(JSON.parse(readFileSync(join(out, file), "utf8")) as SymbolGraph);
      }
      console.error(`extracted ${spec.module}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // USR → full path, for every nominal and type alias any module declares.
  const pathOfUsr = new Map<string, string>();
  for (const graph of graphs) {
    for (const s of graph.symbols) {
      const kind = s.kind.identifier;
      if (TYPE_KINDS[kind] !== undefined || kind === "swift.typealias") {
        pathOfUsr.set(s.identifier.precise, s.pathComponents.join("."));
      }
    }
  }

  /** Re-spell fragments with every nominal by its full path. */
  const render = (fragments: readonly Fragment[]): string => {
    let text = "";
    for (const f of fragments) {
      if (f.kind === "typeIdentifier" && f.preciseIdentifier !== undefined) {
        const path = pathOfUsr.get(f.preciseIdentifier);
        // A nested path after `Self.` / `T.` is an associated type: keep the spelling.
        text += path !== undefined && !text.endsWith(".") ? path : f.spelling;
      } else text += f.spelling;
    }
    return text.replace(/\s+/g, " ").trim();
  };

  /** The fragments after a declaration's first top-level `:` — a property's or parameter's type. */
  const afterColon = (fragments: readonly Fragment[]): readonly Fragment[] | null => {
    const at = fragments.findIndex((f) => f.kind === "text" && f.spelling.trimStart().startsWith(":"));
    if (at === -1) return null;
    const head = { ...fragments[at], spelling: fragments[at].spelling.trimStart().slice(1) };
    const rest = [head, ...fragments.slice(at + 1)];
    // Drop a trailing accessor block (`{ get set }`) and a default value.
    const cut = rest.findIndex((f) => f.kind === "text" && /[{=]/.test(f.spelling));
    if (cut === -1) return rest;
    const f = rest[cut];
    const keep = f.spelling.slice(0, f.spelling.search(/[{=]/));
    return [...rest.slice(0, cut), { ...f, spelling: keep }];
  };

  interface TypeEntry {
    k: string;
    g?: string[];
    gc?: Record<string, string>;
    sup?: string;
    c?: string[];
    t?: Record<string, string>;
    m: Record<string, string[]>;
  }
  const types = new Map<string, TypeEntry>();
  const entryFor = (path: string, kind = "s"): TypeEntry => {
    let entry = types.get(path);
    if (entry === undefined) {
      entry = { k: kind, m: {} };
      types.set(path, entry);
    }
    return entry;
  };
  const typeParams = (s: SymbolGraphSymbol, depth: number | null): { g: string[]; gc: Record<string, string> } => {
    const params = (s.swiftGenerics?.parameters ?? []).filter((p) => depth === null || p.depth <= depth);
    const names = params.map((p) => p.name);
    const gc: Record<string, string> = {};
    for (const c of s.swiftGenerics?.constraints ?? []) {
      if (c.kind === "conformance" && names.includes(c.lhs) && gc[c.lhs] === undefined) gc[c.lhs] = c.rhs;
      else if (c.kind === "superclass" && names.includes(c.lhs) && gc[c.lhs] === undefined) gc[c.lhs] = c.rhs;
    }
    return { g: names, gc };
  };

  // Types first, so a member of a type another module declares finds its kind.
  for (const graph of graphs) {
    for (const s of graph.symbols) {
      const code = TYPE_KINDS[s.kind.identifier];
      if (code === undefined || s.pathComponents.some(hidden)) continue;
      const path = s.pathComponents.join(".");
      const entry = entryFor(path, code);
      entry.k = code;
      const { g, gc } = typeParams(s, null);
      if (g.length > 0) entry.g = g;
      if (Object.keys(gc).length > 0) entry.gc = gc;
    }
  }

  const symbolByUsr = new Map<string, SymbolGraphSymbol>();
  for (const graph of graphs) for (const s of graph.symbols) symbolByUsr.set(s.identifier.precise, s);

  for (const graph of graphs) {
    for (const s of graph.symbols) {
      const kind = s.kind.identifier;
      const path = s.pathComponents;
      if (path.length < 2 || path.some(hidden)) continue;
      const ownerPath = path.slice(0, -1).join(".");
      const owner = types.get(ownerPath);
      if (owner === undefined) continue;
      const last = path[path.length - 1];
      if (kind === "swift.typealias" || kind === "swift.associatedtype") {
        const fragments = s.declarationFragments ?? [];
        const eq = fragments.findIndex((f) => f.kind === "text" && f.spelling.includes("="));
        if (eq === -1) continue;
        const head = fragments[eq].spelling;
        const value = render([
          { ...fragments[eq], spelling: head.slice(head.indexOf("=") + 1) },
          ...fragments.slice(eq + 1),
        ]);
        if (value.length > 0) (owner.t ??= {})[last] = value;
        continue;
      }
      const code = MEMBER_KINDS[kind];
      if (code === undefined) continue;
      const name = kind === "swift.subscript" || kind === "swift.type.subscript" ? "subscript" : baseName(last);
      if (hidden(name)) continue;
      let returns: string | null = null;
      if (code.startsWith("p")) {
        const typeFragments = afterColon(s.declarationFragments ?? []);
        returns = typeFragments === null ? null : render(typeFragments);
      } else if (code.startsWith("c")) {
        returns = null;
      } else if (s.functionSignature?.returns !== undefined) {
        const r = render(s.functionSignature.returns);
        returns = r === "()" || r === "Void" ? null : r;
      }
      const closures: string[] = [];
      for (const param of s.functionSignature?.parameters ?? []) {
        const typeFragments = afterColon(param.declarationFragments ?? []);
        const text = typeFragments === null ? "" : render(typeFragments);
        closures.push(text.includes("->") ? text : "");
      }
      while (closures.length > 0 && closures[closures.length - 1] === "") closures.pop();
      // Method-level generic parameters (depth deeper than the owner's).
      const ownerDepth = (owner.g ?? []).length > 0 ? 0 : -1;
      const own = (s.swiftGenerics?.parameters ?? []).filter(
        (p) => p.depth > ownerDepth && !(owner.g ?? []).includes(p.name),
      );
      const methodGenerics: string[] = [];
      for (const p of own) {
        const constraint = (s.swiftGenerics?.constraints ?? []).find(
          (c) => (c.kind === "conformance" || c.kind === "superclass") && c.lhs === p.name,
        );
        methodGenerics.push(constraint ? `${p.name}:${constraint.rhs}` : p.name);
      }
      // One signature string per distinct shape: kind code, `^g1,g2:Constraint`
      // for method-level generic parameters, `>returns`, then `|closure` per
      // parameter (positional; empty for a non-function one).
      for (const text of [returns ?? "", ...closures, ...methodGenerics]) {
        if (/[|^]/.test(text)) throw new Error(`signature delimiter inside a type: ${path.join(".")}: ${text}`);
      }
      let signature = code;
      if (methodGenerics.length > 0) signature += `^${methodGenerics.join(",")}`;
      if (returns !== null) signature += `>${returns}`;
      if (closures.length > 0) signature += closures.map((c) => `|${c}`).join("");
      const list = (owner.m[name] ??= []);
      if (!list.includes(signature)) list.push(signature);
    }
  }

  for (const graph of graphs) {
    for (const r of graph.relationships) {
      if (r.kind !== "conformsTo" && r.kind !== "inheritsFrom") continue;
      const source = symbolByUsr.get(r.source);
      if (source === undefined || TYPE_KINDS[source.kind.identifier] === undefined) continue;
      const sourcePath = source.pathComponents.join(".");
      const entry = types.get(sourcePath);
      if (entry === undefined) continue;
      const targetPath = pathOfUsr.get(r.target) ?? r.targetFallback?.split(".").pop();
      if (targetPath === undefined || hidden(targetPath) || targetPath === sourcePath) continue;
      if (MARKER_PROTOCOLS.has(targetPath)) continue;
      if (r.kind === "inheritsFrom" && entry.k === "c") entry.sup ??= targetPath;
      else {
        const list = (entry.c ??= []);
        if (!list.includes(targetPath)) list.push(targetPath);
      }
    }
  }

  const sorted: Record<string, TypeEntry> = {};
  for (const path of [...types.keys()].sort()) {
    const entry = types.get(path);
    if (entry === undefined) continue;
    entry.c?.sort();
    const members: Record<string, string[]> = {};
    for (const name of Object.keys(entry.m).sort()) members[name] = entry.m[name];
    entry.m = members;
    sorted[path] = entry;
  }
  const json = JSON.stringify({ v: 1, types: sorted });
  // Held in a raw template literal, so the JSON needs no second escaping pass.
  if (json.includes("`") || json.includes("${")) throw new Error("vocabulary JSON is not raw-template safe");
  const modules = MODULES.map((m) => m.module).join(", ");
  const sdks = [...sdkVersions].map(([sdk, version]) => `${sdk} ${version}`).join(", ");
  const source = `/**
 * The Swift SDK substrate: every public type of the modules below, with its
 * kind, generic parameters (and their constraints), superclass, conformances,
 * member type aliases, and members — kind, declared or returned type, the
 * types of function-typed parameters, method-level generic parameters.
 *
 * GENERATED by \`scripts/gen-swift-sdk-vocabulary.ts\` from
 * \`swift-symbolgraph-extract\` (${toolchain}; SDKs: ${sdks}).
 * Modules: ${modules}.
 * Do not edit by hand; re-run the generator when the module list or the
 * toolchain moves. Read through \`./sdk-vocabulary.ts\`, never directly.
 *
 * One JSON string rather than an object literal: parsed once, on first use,
 * it costs neither the compiler nor module load a type-check of ${types.size}
 * object literals.
 */
export const SWIFT_SDK_VOCABULARY_JSON: string = String.raw\`${json}\`;
`;
  writeFileSync(target, source, "utf8");
  console.error(`wrote ${target}: ${types.size} types, ${source.length} bytes`);
}

main();
