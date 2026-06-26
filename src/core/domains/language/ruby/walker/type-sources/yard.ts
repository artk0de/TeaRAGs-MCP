import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { readScopeResolution } from "../ast-utils.js";
import type { RubyExtractInput } from "../walker.js";
import type { RubyInlineTypeSource, RubyTypeFact } from "./types.js";

/**
 * A bare-bracket YARD type — `[Foo]`, `[Acme::User]` — captured to a single
 * constant name. `null` for any shape we deliberately do NOT bind (union types
 * `[A, B]`, hashes `[Hash{...}]`, lowercase / non-constant tokens). The one
 * structured form we DO unwrap is a single-element collection container
 * (`Array<T>` / `Enumerable<T>` / `[T]`-style) whose element type is itself a
 * bare constant — `@param x [Array<Post>]` binds the ELEMENT type `Post`
 * (brg9), because `x` is iterated/element-accessed in the body, not used as an
 * Array (bd cai0/brg9).
 */
export const YARD_CONST = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;
const YARD_ELEMENT_CONTAINER = /^(?:Array|Enumerable|Set|Collection|ActiveRecord::Relation)<([\w:]+)>$/;

function parseYardBracketType(inner: string): string | null {
  const trimmed = inner.trim();
  // `Array<Post>` / `Enumerable<Acme::Post>` → element type.
  const container = YARD_ELEMENT_CONTAINER.exec(trimmed);
  if (container) {
    const element = container[1];
    return YARD_CONST.test(element) ? element : null;
  }
  // Bare constant `Foo` / `Acme::User`.
  return YARD_CONST.test(trimmed) ? trimmed : null;
}

/**
 * Like `collectYardParamTypes` but stores the RAW bracket string
 * (e.g. `"Array<Post>"`, `"String, Integer"`, `"User"`) instead of
 * the parsed element/constant name. Used by `rubyYardTypeSource` so
 * `yardBracketToRef` can produce the full `RubyTypeRef` (including
 * union/container forms). Does NOT break `ast-inference.ts` which
 * consumes `collectYardParamTypes` (the string-returning variant) directly.
 */
function collectYardRawParamBrackets(code: string): Map<number, Record<string, string>> {
  const lines = code.split(/\r?\n/);
  const out = new Map<number, Record<string, string>>();
  let pending: Record<string, string> | null = null;
  const yardRegex = /^\s*#\s*@param\s+(\w+)\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const yardMatch = yardRegex.exec(raw);
    if (yardMatch) {
      const [, name, bracket] = yardMatch;
      // Keep the RAW bracket string; yardBracketToRef will validate it.
      if (name && bracket) {
        if (!pending) pending = {};
        pending[name] = bracket.trim();
      }
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (pending && defRegex.test(raw)) {
      out.set(i + 1, pending);
    }
    pending = null;
  }
  return out;
}

/**
 * Parse YARD `# @param NAME [TYPE]` lines and group them by the line
 * number of the `def NAME(...)` they precede. The grammar is light: any
 * comment line matching the pattern attaches to the NEXT non-comment,
 * non-blank line that starts with `def` (with optional `self.` prefix).
 *
 * `[TYPE]` is parsed by `parseYardBracketType`: a bare constant binds
 * directly; a single-element collection (`Array<T>`) binds the ELEMENT type
 * `T` (brg9) so `x.first` / `x.each { |e| … }` element-method calls resolve.
 * Bracket-less types (`# @param x String`), unions, and lowercase tokens are
 * rejected — the bracket form is the canonical Sorbet/Solargraph/Steep
 * convention.
 */
export function collectYardParamTypes(code: string): Map<number, Record<string, string>> {
  const lines = code.split(/\r?\n/);
  const out = new Map<number, Record<string, string>>();
  let pending: Record<string, string> | null = null;
  const yardRegex = /^\s*#\s*@param\s+(\w+)\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const yardMatch = yardRegex.exec(raw);
    if (yardMatch) {
      // SAFETY: regex capture groups (\w+) and ([^\]]+) are non-optional —
      // a successful match guarantees both name and the bracket body exist.
      const [, name, bracket] = yardMatch;
      const type = parseYardBracketType(bracket);
      if (type) {
        if (!pending) pending = {};
        pending[name] = type;
      }
      continue;
    }
    // Blank or other comment — preserve pending block.
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    // First non-blank, non-comment line. If it's a `def`, attach.
    if (pending && defRegex.test(raw)) {
      out.set(i + 1, pending);
    }
    pending = null;
  }
  return out;
}

/**
 * Parse YARD `# @return [TYPE]` lines and key them by the method NAME of the
 * `def NAME(...)` they precede (brg9). Mirrors `collectYardParamTypes`'
 * comment-block attachment, but produces a `functionName → returnTypeName`
 * map matching `FileExtraction.functionReturnTypes` (the same channel the Go
 * walker fills) so a resolver can bind `x = obj.foo` to `foo`'s return type.
 *
 * Only a SINGLE bare constant return is recorded — `[Array<User>]` and other
 * collection containers are skipped (a collection isn't a single instance the
 * caller's `x.method` dispatches on), matching the Go walker's "single concrete
 * return only" discipline. `parseYardBracketType` would unwrap the element type
 * for a param, but a `@return` of a collection genuinely IS a collection, so we
 * reject containers here rather than unwrap them.
 */
export function collectYardReturnTypes(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  let pendingReturn: string | null = null;
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (const raw of code.split(/\r?\n/)) {
    const m = returnRegex.exec(raw);
    if (m) {
      const inner = (m[1] ?? "").trim();
      // Single bare constant only — a collection `[Array<T>]` return is a
      // collection, not a dispatch target, so it is NOT recorded.
      pendingReturn = YARD_CONST.test(inner) ? inner : null;
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const defMatch = defRegex.exec(raw);
    // defMatch[1] is the method name (\w+) when the line is a `def`.
    if (pendingReturn && defMatch?.[1]) {
      out[defMatch[1]] = pendingReturn;
    }
    pendingReturn = null;
  }
  return out;
}

/**
 * Map each method `def` line (1-based) to its enclosing class/module FQ scope as
 * a `::`-split array (`["Acme","Widget"]`), mirroring the scope-stack walk in
 * `collectRubyDefinedConstants` / `collectRubyIvarFieldTypes` (extend the scope
 * by `[...scope, ...localName.split("::")]`, resolve `class A::B` headers via
 * `readScopeResolution`). The array is the same shape `structuredReturnTypesMap`
 * joins with `::` and the resolver forms `recv.name` from, so a `@return` fact
 * keyed by its def line resolves to the codegraph fq class. A missing `rootNode`
 * (stub trees in unit tests) yields an empty map → callers fall back to `[]`
 * (the prior flat-key behaviour, preserved for top-level annotations).
 */
function buildDefScopeMap(root: AstNode | undefined): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!root) return out;
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const body = node.childForFieldName("body");
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    // `def NAME` / `def self.NAME` — the def line carries the enclosing scope.
    // Keep descending so nested classes/defs inside a method body still map.
    if (node.type === "method" || node.type === "singleton_method") {
      out.set(node.startPosition.row + 1, scope);
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return out;
}

/**
 * Scope-aware sibling of {@link collectYardReturnTypes} producing `kind:"return"`
 * facts whose `symbolScope` is the enclosing class/module (bd 9bliu YARD-scope
 * follow-up). Same comment-block attachment + single-bare-constant discipline as
 * `collectYardReturnTypes`, but the def line is carried so {@link buildDefScopeMap}
 * resolves the fq scope. Populating `symbolScope` makes
 * `RubyTypeFactStore.structuredReturnTypesMap()` emit real `"Class#method"` keys
 * (the precise engine path) instead of flat `"#method"`; `returnTypeByMethod()`
 * (keyed by bare method name) is unaffected — scope is additive there.
 */
function collectYardReturnFacts(input: RubyExtractInput): RubyTypeFact[] {
  const scopeByDefLine = buildDefScopeMap(input.tree?.rootNode);
  const facts: RubyTypeFact[] = [];
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  const lines = input.code.split(/\r?\n/);
  let pendingReturn: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const m = returnRegex.exec(raw);
    if (m) {
      const inner = (m[1] ?? "").trim();
      // Single bare constant only — a collection `[Array<T>]` return is a
      // collection, not a dispatch target (matches collectYardReturnTypes).
      pendingReturn = YARD_CONST.test(inner) ? inner : null;
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const defMatch = defRegex.exec(raw);
    if (pendingReturn && defMatch?.[1]) {
      const type = yardBracketToRef(pendingReturn);
      if (type) {
        const symbolScope = scopeByDefLine.get(i + 1) ?? [];
        facts.push({ kind: "return", source: "yard", symbolScope, methodName: defMatch[1], type });
      }
    }
    pendingReturn = null;
  }
  return facts;
}

/**
 * Parse a single non-comma bracket token ("User", "Array<Post>", "Acme::Post") → RubyTypeRef.
 * Returns undefined for unrecognized / lowercase tokens.
 */
function parseSingleBracketToken(token: string): RubyTypeRef | undefined {
  const trimmed = token.trim();
  const container = YARD_ELEMENT_CONTAINER.exec(trimmed);
  if (container) {
    const element = container[1];
    if (!YARD_CONST.test(element)) return undefined;
    return { form: "container", element: { form: "instance", name: element } };
  }
  if (YARD_CONST.test(trimmed)) return { form: "instance", name: trimmed };
  return undefined;
}

/**
 * Bracket type string → RubyTypeRef (INFRA-A).
 *
 * - Bare constant `"User"` / `"Acme::Post"` → `{form:"instance", name}`.
 * - Container `"Array<Post>"` → `{form:"container", element:{form:"instance",name:"Post"}}`.
 * - Union `"A, B"` / `"A, B, C"` → `{form:"union", members:[...]}`.
 *   Any member that fails `YARD_CONST` (or is itself unrecognized) → entire union dropped.
 */
function yardBracketToRef(raw: string): RubyTypeRef | undefined {
  const trimmed = raw.trim();
  // ── Union: comma-separated members ─────────────────────────────────────────
  if (trimmed.includes(",")) {
    const memberTokens = trimmed.split(",");
    const members: RubyTypeRef[] = [];
    for (const token of memberTokens) {
      const ref = parseSingleBracketToken(token);
      if (ref === undefined) return undefined; // any invalid member → drop whole union
      members.push(ref);
    }
    return members.length >= 2 ? { form: "union", members } : members[0];
  }
  // ── Single token (container or bare constant) ────────────────────────────
  return parseSingleBracketToken(trimmed);
}

/**
 * Parse YARD `# @type [TYPE] name` lines and emit `kind:"local"` facts.
 * Conservative: requires both bracket type and a trailing name token.
 * Line number is 1-based index of the comment line itself.
 */
function collectYardLocalTypeFacts(code: string): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  // `# @type [Type] varName` — bracket is required; trailing name is required.
  const typeRegex = /^\s*#\s*@type\s+\[([^\]]+)\]\s+(\w+)/;
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const m = typeRegex.exec(raw);
    if (!m) continue;
    const [, bracket, name] = m;
    if (!bracket || !name) continue;
    const type = yardBracketToRef(bracket.trim());
    if (!type) continue;
    facts.push({
      kind: "local",
      source: "yard",
      symbolScope: [],
      name,
      line: i + 1, // 1-based line of the @type comment
      type,
    });
  }
  return facts;
}

/**
 * Parse `# @!attribute [r|w|rw] name` / `# @return [TYPE]` pairs and emit
 * `kind:"attr"` facts. The two tags must appear as consecutive comment lines
 * (other comments may intervene; a blank line or non-comment line resets).
 * The `@return [TYPE]` line provides the type; `@!attribute` provides the name.
 * Conservative: only emits when both tags are present and type passes yardBracketToRef.
 */
function collectYardAttrFacts(code: string): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  const attrRegex = /^\s*#\s*@!attribute\s+\[(?:r|w|rw)\]\s+(\w+)/;
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  const lines = code.split(/\r?\n/);
  let pendingAttrName: string | null = null;
  for (const raw of lines) {
    const attrMatch = attrRegex.exec(raw);
    if (attrMatch) {
      pendingAttrName = attrMatch[1] ?? null;
      continue;
    }
    const retMatch = returnRegex.exec(raw);
    if (retMatch && pendingAttrName) {
      const bracket = (retMatch[1] ?? "").trim();
      const type = yardBracketToRef(bracket);
      if (type) {
        facts.push({
          kind: "attr",
          source: "yard",
          symbolScope: [],
          name: pendingAttrName,
          type,
        });
      }
      pendingAttrName = null;
      continue;
    }
    // Blank or other comment line — preserve pendingAttrName across non-return comment lines.
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    // Non-comment, non-blank line resets state.
    pendingAttrName = null;
  }
  return facts;
}

/**
 * Parse `# @option OPTS [TYPE] :key` lines and emit `kind:"param"` facts keyed
 * by the option key name (`:key` → `"key"`). Conservative: requires bracket type
 * and a colon-prefixed key; attaches to the NEXT non-comment `def` line.
 * Does NOT collide with the named `opts` param fact (different `name` value).
 */
function collectYardOptionFacts(code: string): RubyTypeFact[] {
  const facts: RubyTypeFact[] = [];
  // `# @option OPTS_NAME [Type] :key` (optional trailing description ignored)
  const optionRegex = /^\s*#\s*@option\s+\w+\s+\[([^\]]+)\]\s+:(\w+)/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  const lines = code.split(/\r?\n/);
  let pending: { name: string; type: RubyTypeRef }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const optMatch = optionRegex.exec(raw);
    if (optMatch) {
      const [, bracket, key] = optMatch;
      if (!bracket || !key) continue;
      const type = yardBracketToRef(bracket.trim());
      if (type) pending.push({ name: key, type });
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    // Non-comment, non-blank: if it's a def, emit accumulated option facts.
    if (pending.length > 0 && defRegex.test(raw)) {
      const defLine = i + 1;
      for (const { name, type } of pending) {
        facts.push({
          kind: "param",
          source: "yard",
          symbolScope: [],
          name,
          line: defLine,
          type,
        });
      }
    }
    pending = [];
  }
  return facts;
}

export const rubyYardTypeSource: RubyInlineTypeSource = {
  name: "yard",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const facts: RubyTypeFact[] = [];
    // @param: raw bracket strings → full RubyTypeRef (union/container via yardBracketToRef)
    for (const [defLine, params] of collectYardRawParamBrackets(input.code)) {
      for (const [name, raw] of Object.entries(params)) {
        const type = yardBracketToRef(raw);
        if (type) {
          facts.push({
            kind: "param",
            source: "yard",
            symbolScope: [],
            methodName: undefined,
            name,
            line: defLine,
            type,
          });
        }
      }
    }
    // @return: scope-aware facts carrying the enclosing class/module scope
    // (bd 9bliu YARD-scope follow-up) so structuredReturnTypesMap emits real
    // `"Class#method"` keys. collectYardReturnTypes stays as the flat,
    // code-only sidecar reader (barrel-exported); this is its scoped sibling.
    facts.push(...collectYardReturnFacts(input));
    // @type [TYPE] name → local var facts
    facts.push(...collectYardLocalTypeFacts(input.code));
    // @!attribute [r|w|rw] name + @return [TYPE] → attr facts
    facts.push(...collectYardAttrFacts(input.code));
    // @option OPTS [TYPE] :key → param facts (option key scoped)
    facts.push(...collectYardOptionFacts(input.code));
    return facts;
  },
};
