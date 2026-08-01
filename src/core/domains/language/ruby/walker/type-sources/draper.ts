/**
 * Draper decorated-model RETURN-type source (bd tea-rags-mcp-adx5p.9).
 *
 * A Draper decorator wraps one model and exposes it as `object` / `model`, so
 * every `object.<method>` inside the decorator is a call on that model. Nothing
 * declares those two readers — the gem's base class defines them — which leaves
 * the receiver untyped and the call unresolved. This source states the type.
 *
 * The DECORATED-MODEL name comes from, in order:
 *   1. `decorates :article` — the explicit declaration (camelized: `Article`);
 *   2. the class name minus its `Decorator` suffix (`UserDecorator` → `User`).
 *
 * SILENCE (precision, never fabricate): a class that opts into neither
 * `delegate_all` nor `decorates` is not a decorator; a class with no explicit
 * `decorates` and no `Decorator` suffix names no model. Both emit nothing.
 *
 * Gem-gated like the rest of the pack: the verbs are honoured only while the
 * project's composed catalogue carries them, so a project-defined `decorates`
 * in an app without draper types nothing.
 *
 * Structure mirrors `associations.ts` — the same scope-tracking walk, the same
 * `source:` tag for the store's precedence merge — and stays runtime-decoupled
 * from `walker.ts` (type-import only) so `INLINE_TYPE_SOURCES` cannot cycle.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { catalogueForGemfile } from "../../gemfile.js";
import { readScopeResolution } from "../ast-utils.js";
import type { RubyExtractInput } from "../walker.js";
import type { RubyInlineTypeSource, RubyTypeFact } from "./types.js";

/**
 * Draper's own readers for the wrapped instance. `object` is the canonical name;
 * `model` is its alias on `Draper::Decorator`, and app code uses both.
 */
const DECORATED_READERS = ["object", "model"] as const;

/** The class-name suffix Draper's `decorates` inflection strips (`UserDecorator` → `User`). */
const DECORATOR_SUFFIX = "Decorator";

/** The macro that opts a class into forwarding to the wrapped model. */
const DELEGATE_ALL = "delegate_all";

/** The macro that names the decorated model explicitly. */
const DECORATES = "decorates";

/** `blog_post` → `BlogPost`: upcase each `_`-separated segment (Rails camelize). */
function camelizeModel(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** The bare name of a class-body macro call (`delegate_all`), or `null`. */
function classBodyMacroName(node: AstNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const receiver = node.childForFieldName("receiver");
  if (receiver && receiver.type !== "self") return null;
  return node.childForFieldName("method")?.text ?? null;
}

/** First `simple_symbol` argument of a macro call (`decorates :article` → "article"). */
function firstSymbolArg(node: AstNode): string | null {
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  const first = args?.namedChildren[0];
  if (first?.type !== "simple_symbol") return null;
  const base = first.text.startsWith(":") ? first.text.slice(1) : first.text;
  return base.length > 0 ? base : null;
}

/** What a class body declares about being a decorator: opt-in flag + explicit model. */
interface DecoratorDeclaration {
  isDecorator: boolean;
  declaredModel: string | null;
}

/**
 * Scan ONE class body (not its nested classes — those own their declarations) for
 * the draper opt-in macros the project's catalogue currently activates.
 */
function readDecoratorDeclaration(body: AstNode, activeVerbs: (verb: string) => boolean): DecoratorDeclaration {
  const declaration: DecoratorDeclaration = { isDecorator: false, declaredModel: null };
  const scan = (node: AstNode): void => {
    if (node.type === "class" || node.type === "module") return; // nested scope owns its own
    const macro = classBodyMacroName(node);
    if (macro === DELEGATE_ALL && activeVerbs(DELEGATE_ALL)) declaration.isDecorator = true;
    if (macro === DECORATES && activeVerbs(DECORATES)) {
      declaration.isDecorator = true;
      const sym = firstSymbolArg(node);
      if (sym !== null) declaration.declaredModel = camelizeModel(sym);
    }
    for (const child of node.children) scan(child);
  };
  for (const child of body.children) scan(child);
  return declaration;
}

/** The model a decorator wraps: the explicit `decorates` literal, else the class
 *  name minus its `Decorator` suffix. `null` when neither names one. */
function decoratedModel(declaration: DecoratorDeclaration, scope: readonly string[]): string | null {
  if (declaration.declaredModel !== null) return declaration.declaredModel;
  const className = scope[scope.length - 1] ?? "";
  if (!className.endsWith(DECORATOR_SUFFIX) || className.length === DECORATOR_SUFFIX.length) return null;
  return className.slice(0, -DECORATOR_SUFFIX.length);
}

/**
 * Walk the tree tracking the enclosing class/module scope (mirroring
 * `associations.ts`), emitting the wrapped-instance readers' return facts for
 * every class that declares itself a decorator.
 */
function collectDecoratorReturnFacts(root: AstNode, activeVerbs: (verb: string) => boolean): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  const walkScope = (node: AstNode, scope: readonly string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const nextScope = [...scope, ...localName.split("::")];
      const body = node.childForFieldName("body");
      if (body && node.type === "class") {
        const declaration = readDecoratorDeclaration(body, activeVerbs);
        const model = declaration.isDecorator ? decoratedModel(declaration, nextScope) : null;
        if (model !== null) {
          for (const reader of DECORATED_READERS) {
            facts.push({
              kind: "return",
              source: "draper",
              symbolScope: [...nextScope],
              methodName: reader,
              type: { form: "instance", name: model },
            });
          }
        }
      }
      for (const child of (body ?? node).children) walkScope(child, nextScope);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return facts;
}

export const rubyDraperTypeSource: RubyInlineTypeSource = {
  name: "draper",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const root = input.tree?.rootNode;
    if (!root) return [];
    const { entries } = catalogueForGemfile(input.gemfileContent);
    const activeVerbs = (verb: string): boolean => entries[verb] !== undefined;
    if (!activeVerbs(DELEGATE_ALL) && !activeVerbs(DECORATES)) return [];
    return collectDecoratorReturnFacts(root, activeVerbs);
  },
};
