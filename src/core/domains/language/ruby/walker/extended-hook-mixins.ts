/**
 * The modules a Ruby module's `def self.extended(base)` hook mixes into `base`
 * (bd tea-rags-mcp-89k7k.35.31).
 *
 * `extend M` puts M on the singleton class only — but Ruby then calls
 * `M.extended(klass)`, and a hook body like `klass.include(Loader)` puts Loader
 * on the INSTANCE ancestry. graphql-ruby's `GraphQL::Schema::Member::HasArguments`
 * is the measured shape: `Resolver` extends it, and `super` in
 * `Subscription#load_application_object_failed` reaches the hook-included
 * `HasArguments::ArgumentObjectLoader`. Only `base.include(X)` /
 * `base.prepend(X)` (and `base.send(:include, X)`) on the hook's own parameter
 * count; a `base.extend(X)` stays on the singleton side, so it is not recorded.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { RubyExtendedHookMixin } from "../../../../contracts/types/codegraph.js";
import { readScopeResolution } from "./shared/index.js";

const HOOK_MIXIN_KINDS: ReadonlySet<string> = new Set(["include", "prepend"]);
const SEND_METHODS: ReadonlySet<string> = new Set(["send", "public_send", "__send__"]);
/** Bodies whose `self` / locals are not the hook's: their calls are not the hook's injections. */
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set([
  "method",
  "singleton_method",
  "class",
  "module",
  "singleton_class",
]);
const CONSTANT_PATH_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

function constantText(node: AstNode): string | null {
  const text =
    node.type === "constant" ? node.text : node.type === "scope_resolution" ? readScopeResolution(node) : null;
  return text !== null && CONSTANT_PATH_RE.test(text) ? text : null;
}

/** The single positional parameter of `def self.extended(base)`, or null for any other method. */
function extendedHookParam(node: AstNode): string | null {
  if (node.type !== "singleton_method") return null;
  if (node.childForFieldName("object")?.type !== "self") return null;
  if (node.childForFieldName("name")?.text !== "extended") return null;
  const param = node.childForFieldName("parameters")?.namedChildren[0];
  return param?.type === "identifier" ? param.text : null;
}

/**
 * The injections one call makes on `param`: `param.include(A, B)` is Ruby's
 * `include B; include A` (A ends nearer), so the modules come back in that
 * declaration order — the order `classAncestors` keeps, later = nearer.
 */
function injectionsOfCall(node: AstNode, param: string): RubyExtendedHookMixin[] {
  if (node.type !== "call") return [];
  const receiver = node.childForFieldName("receiver");
  if (receiver?.type !== "identifier" || receiver.text !== param) return [];
  const method = node.childForFieldName("method")?.text;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  let kind: string | undefined = method;
  let moduleArgs = args;
  if (method !== undefined && SEND_METHODS.has(method)) {
    const selector = args[0];
    kind = selector?.type === "simple_symbol" ? selector.text.slice(1) : undefined;
    moduleArgs = args.slice(1);
  }
  if (kind === undefined || !HOOK_MIXIN_KINDS.has(kind)) return [];
  const modules = moduleArgs.map(constantText).filter((name): name is string => name !== null);
  return modules.reverse().map((module) => ({ kind: kind as RubyExtendedHookMixin["kind"], module }));
}

function collectInjections(node: AstNode, param: string, out: RubyExtendedHookMixin[]): void {
  out.push(...injectionsOfCall(node, param));
  for (const child of node.namedChildren) {
    if (!OPAQUE_NODE_TYPES.has(child.type)) collectInjections(child, param, out);
  }
}

/**
 * The injections every `def self.extended(param)` among a module body's direct
 * statements makes, in source order, each module AS WRITTEN — the caller
 * canonicalizes once it knows every namespace the file declares.
 */
export function extendedHookMixinsOfBody(statements: readonly AstNode[]): RubyExtendedHookMixin[] {
  const out: RubyExtendedHookMixin[] = [];
  for (const statement of statements) {
    const param = extendedHookParam(statement);
    if (param === null) continue;
    const body = statement.childForFieldName("body");
    if (body) collectInjections(body, param, out);
  }
  return out;
}

/**
 * `raw` as the hook module `moduleFq`'s body names it: Ruby's `Module.nesting`
 * order — `moduleFq` itself, then each enclosing namespace innermost first
 * (none for a COMPACT `module A::B::M`, which opens only itself), then the top
 * level — answered by the first candidate this file declares. A name the file
 * does not declare stays as written: the walker does not resolve.
 */
export function canonicalizeHookMixin(
  raw: string,
  moduleFq: string,
  declared: ReadonlySet<string>,
  compact: boolean,
): string {
  const candidates = [`${moduleFq}::${raw}`];
  if (!compact) {
    const segments = moduleFq.split("::");
    for (let i = segments.length - 1; i >= 1; i--) candidates.push(`${segments.slice(0, i).join("::")}::${raw}`);
  }
  candidates.push(raw);
  return candidates.find((candidate) => declared.has(candidate)) ?? raw;
}
