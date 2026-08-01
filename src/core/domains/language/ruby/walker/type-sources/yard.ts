import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { RUBY_NIL_TYPE_REF, rubyUnionOf } from "../../type-ref.js";
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
/** A parsed `@!method` directive: its own coordinate + the `@return` its block declares. */
interface YardMethodDirective {
  /** 0-based line of the `# @!method ...` directive itself. */
  readonly line: number;
  readonly methodName: string;
  /** `@!method self.NAME` → class coordinate (`Class.NAME`); bare NAME → instance. */
  readonly classForm: boolean;
  /** Single-bare-constant `@return [T]` inside the directive's block, else null. */
  readonly returnBracket: string | null;
}

/**
 * `# @!method NAME` / `# @!method self.NAME(args)` directive blocks (bd
 * tea-rags-mcp-8ypeu). A directive documents a method that does NOT exist as a
 * following `def` (typically metaprogrammed), so every tag inside its block —
 * nested (deeper-indented comments) or flat (same-indent comments) — belongs to
 * the DIRECTIVE's own coordinate, never to the next `def`. Without this, a
 * `# @!method self.call … @return [Result]` above `def initialize` emits the
 * poisonous declared fact `Class#initialize → Result`.
 *
 * The block ends at: a blank line, a bare `#` separator (claimed, so the next
 * tag reaches the def), another directive, or any non-comment line.
 */
function collectYardMethodDirectives(code: string): {
  claimedLines: Set<number>;
  directives: YardMethodDirective[];
} {
  const lines = code.split(/\r?\n/);
  const claimedLines = new Set<number>();
  const directives: YardMethodDirective[] = [];
  const directiveRegex = /^(\s*)#\s*@!method\s+(self\.)?(\w+)/;
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const dir = directiveRegex.exec(raw);
    if (!dir) continue;
    const indent = (dir[1] ?? "").length;
    // Body indent AFTER the '#' of the directive line itself — the yardstick
    // nested tags are measured against ('# @!method x' -> 1; '#   @return' -> 3).
    const directiveBodyIndent = (/^\s*#(\s*)/.exec(raw)?.[1] ?? "").length;
    claimedLines.add(i);
    let returnBracket: string | null = null;
    // The block's SHAPE is set by its first line: deeper-indented (nested — the
    // canonical YARD form) means a same-indent comment ENDS the block (it
    // documents the next def); same-indent first line means a flat block that
    // runs over same-indent comments.
    let nestedShape: boolean | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const blockRaw = lines[j] ?? "";
      const trimmed = blockRaw.trim();
      if (trimmed === "" || !trimmed.startsWith("#")) break; // blank / code — block over
      if (trimmed === "#") {
        claimedLines.add(j); // bare separator: claimed, but ends the block
        break;
      }
      if (directiveRegex.test(blockRaw)) break; // next directive starts its own block
      const commentBodyIndent = (/^\s*#(\s*)/.exec(blockRaw)?.[1] ?? "").length;
      if (nestedShape === null) nestedShape = commentBodyIndent > directiveBodyIndent;
      if (nestedShape && commentBodyIndent <= directiveBodyIndent) break; // same-indent after nested = next def's doc
      const blockIndent = blockRaw.length - blockRaw.trimStart().length;
      if (blockIndent < indent) break; // dedented comment belongs elsewhere
      claimedLines.add(j);
      const ret = returnRegex.exec(blockRaw);
      if (ret) {
        const inner = (ret[1] ?? "").trim();
        // Same single-bare-constant discipline as def-bound `@return`s.
        if (YARD_CONST.test(inner)) returnBracket = inner;
      }
    }
    directives.push({ line: i, methodName: dir[3] ?? "", classForm: dir[2] !== undefined, returnBracket });
    i = j - 1; // resume after the block (outer loop's i++ lands on j)
  }
  return { claimedLines, directives };
}

function collectYardRawParamBrackets(code: string): Map<number, Record<string, string>> {
  const lines = code.split(/\r?\n/);
  const out = new Map<number, Record<string, string>>();
  let pending: Record<string, string> | null = null;
  // YARD accepts BOTH orders: `@param name [Type]` (name-first) and
  // `@param [Type] name` (bracket-first, the form mastodon/most Rails use).
  const yardNameFirst = /^\s*#\s*@param\s+(\w+)\s+\[([^\]]+)\]/;
  const yardBracketFirst = /^\s*#\s*@param\s+\[([^\]]+)\]\s+(\w+)/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  // `@!method` directive blocks own their tags (bd 8ypeu) — a directive's
  // `@param` must not leak onto the following def.
  const { claimedLines } = collectYardMethodDirectives(code);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (claimedLines.has(i)) continue;
    const nameFirst = yardNameFirst.exec(raw);
    const bracketFirst = nameFirst ? null : yardBracketFirst.exec(raw);
    const name = nameFirst?.[1] ?? bracketFirst?.[2];
    const bracket = nameFirst?.[2] ?? bracketFirst?.[1];
    if (name || bracket) {
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
  // YARD accepts BOTH orders: `@param name [Type]` (name-first) and
  // `@param [Type] name` (bracket-first, the form mastodon/most Rails use).
  const yardNameFirst = /^\s*#\s*@param\s+(\w+)\s+\[([^\]]+)\]/;
  const yardBracketFirst = /^\s*#\s*@param\s+\[([^\]]+)\]\s+(\w+)/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  // `@!method` directive blocks own their tags (bd 8ypeu) — a directive's
  // `@param` must not leak onto the following def.
  const { claimedLines } = collectYardMethodDirectives(code);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (claimedLines.has(i)) continue;
    const nameFirst = yardNameFirst.exec(raw);
    const bracketFirst = nameFirst ? null : yardBracketFirst.exec(raw);
    const name = nameFirst?.[1] ?? bracketFirst?.[2];
    const bracket = nameFirst?.[2] ?? bracketFirst?.[1];
    if (name && bracket) {
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
  // Mirror of collectYardReturnFacts' `@!attribute` ownership guard: a `@return`
  // nested under a `@!attribute` documents the attribute accessor, so it binds
  // to a following def ONLY when the def IS the same-named reader.
  let pendingAttrOwner: string | null = null;
  let seenAttrName: string | null = null;
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  const attrRegex = /^\s*#\s*@!attribute\s+\[(?:r|w|rw)\]\s+(\w+)/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  // `@!method` directive blocks own every tag inside them (bd 8ypeu) — their
  // `@return` names the DIRECTIVE's coordinate, never the following def.
  const { claimedLines } = collectYardMethodDirectives(code);
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (claimedLines.has(i)) continue;
    const attrMatch = attrRegex.exec(raw);
    if (attrMatch) {
      seenAttrName = attrMatch[1] ?? null;
      continue;
    }
    const m = returnRegex.exec(raw);
    if (m) {
      const inner = (m[1] ?? "").trim();
      // Single bare constant only — a collection `[Array<T>]` return is a
      // collection, not a dispatch target, so it is NOT recorded.
      pendingReturn = YARD_CONST.test(inner) ? inner : null;
      pendingAttrOwner = seenAttrName;
      seenAttrName = null;
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const defMatch = defRegex.exec(raw);
    // defMatch[1] is the method name (\w+) when the line is a `def`. An
    // attribute-owned return binds only to the same-named reader def.
    if (pendingReturn && defMatch?.[1] && (pendingAttrOwner === null || pendingAttrOwner === defMatch[1])) {
      out[defMatch[1]] = pendingReturn;
    }
    pendingReturn = null;
    pendingAttrOwner = null;
    seenAttrName = null;
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
/**
 * Innermost enclosing class/module scope for an arbitrary 1-based LINE — the
 * range-based sibling of {@link buildDefScopeMap} for lines that are not defs
 * (a `@!method` directive sits on a comment line, bd 8ypeu). Same name
 * resolution (`readScopeResolution`, `::` splitting); DFS order means a later
 * matching range is always the inner one, so last-match wins. A missing root
 * (stub trees) yields `() => []` — the flat-key fallback.
 */
function buildClassRangeScopeLookup(root: AstNode | undefined): (line: number) => string[] {
  const ranges: { start: number; end: number; scope: string[] }[] = [];
  if (root) {
    const walkRanges = (node: AstNode, scope: string[]): void => {
      if (node.type === "class" || node.type === "module") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
          const nextScope = [...scope, ...localName.split("::")];
          ranges.push({ start: node.startPosition.row + 1, end: node.endPosition.row + 1, scope: nextScope });
          const body = node.childForFieldName("body");
          for (const child of (body ?? node).children) walkRanges(child, nextScope);
          return;
        }
      }
      for (const child of node.children) walkRanges(child, scope);
    };
    walkRanges(root, []);
  }
  return (line: number): string[] => {
    let found: string[] = [];
    for (const r of ranges) {
      if (r.start <= line && line <= r.end) found = r.scope; // DFS: later = inner
    }
    return found;
  };
}

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
  const attrRegex = /^\s*#\s*@!attribute\s+\[(?:r|w|rw)\]\s+(\w+)/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  const lines = input.code.split(/\r?\n/);
  // `@!method` directives (bd 8ypeu): each block's `@return` types the
  // DIRECTIVE's own coordinate — `self.NAME` → class form (`Class.NAME`),
  // bare NAME → instance (`Class#NAME`) — attributed to the ENCLOSING class
  // scope (the directive documents a metaprogrammed member of that class; a
  // stub tree yields `[]`, preserving the flat-key fallback).
  const { claimedLines, directives } = collectYardMethodDirectives(input.code);
  const classScopeAt = buildClassRangeScopeLookup(input.tree?.rootNode);
  for (const directive of directives) {
    if (directive.returnBracket === null) continue;
    const type = yardBracketToRef(directive.returnBracket);
    if (!type) continue;
    facts.push({
      kind: "return",
      source: "yard",
      symbolScope: classScopeAt(directive.line + 1),
      methodName: directive.methodName,
      type,
      ...(directive.classForm ? { classForm: true } : {}),
    });
  }
  let pendingReturn: string | null = null;
  // Name of the `@!attribute` that OWNS `pendingReturn` (the nested `@return`
  // under a `@!attribute` directive documents the attribute accessor, not the
  // next unrelated `def`). `null` → a normal def-bound `@return`.
  let pendingAttrOwner: string | null = null;
  // Most recent `@!attribute` name awaiting its nested `@return`.
  let seenAttrName: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (claimedLines.has(i)) continue;
    const attrMatch = attrRegex.exec(raw);
    if (attrMatch) {
      seenAttrName = attrMatch[1] ?? null;
      continue;
    }
    const m = returnRegex.exec(raw);
    if (m) {
      const inner = (m[1] ?? "").trim();
      // A bare constant, or a nilable / multi-nominal union — see
      // `yardReturnBracket` for what stays dropped and why.
      pendingReturn = yardReturnBracket(inner);
      // Claim this `@return` for the pending attribute (if any). It will attach
      // to a following `def` ONLY when that def IS the attribute reader (same
      // name); `seenAttrName` resets so a later bare `@return` stays def-bound.
      pendingAttrOwner = seenAttrName;
      seenAttrName = null;
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const defMatch = defRegex.exec(raw);
    // An attribute-owned `@return` attaches only to the same-named reader def;
    // a plain (`pendingAttrOwner === null`) `@return` attaches to any next def.
    if (pendingReturn && defMatch?.[1] && (pendingAttrOwner === null || pendingAttrOwner === defMatch[1])) {
      const type = yardBracketToRef(pendingReturn);
      if (type) {
        const symbolScope = scopeByDefLine.get(i + 1) ?? [];
        facts.push({ kind: "return", source: "yard", symbolScope, methodName: defMatch[1], type });
      }
    }
    pendingReturn = null;
    pendingAttrOwner = null;
    seenAttrName = null;
  }
  return facts;
}

/**
 * The bracket tokens that name Ruby's ABSENCE rather than a class
 * (bd tea-rags-mcp-27q0z). `@return [Firm, nil]` is how a Ruby codebase says
 * "this may not find one" — on taxdome it is 26 of the 33 brackets the channel
 * used to drop. `NilClass` is the same statement spelled as a class, and both
 * map to the one arm that dispatches to nothing.
 *
 * `TrueClass` / `FalseClass` are deliberately absent: they are real classes and
 * already parse as nominals, so nothing is gained by special-casing them.
 */
const YARD_NIL_TOKENS = new Set(["nil", "NilClass"]);

/**
 * Parse a single non-comma bracket token ("User", "Array<Post>", "Acme::Post",
 * "nil") → RubyTypeRef. Returns undefined for unrecognized / lowercase tokens.
 */
function parseSingleBracketToken(token: string): RubyTypeRef | undefined {
  const trimmed = token.trim();
  if (YARD_NIL_TOKENS.has(trimmed)) return RUBY_NIL_TYPE_REF;
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
 * - Nil literal `"nil"` / `"NilClass"` → the nil arm (bd tea-rags-mcp-27q0z).
 * - Union `"A, B"` / `"A, nil"` → built through `rubyUnionOf`, which flattens,
 *   dedupes, and collapses a one-arm result back to that arm.
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
    return rubyUnionOf(members);
  }
  // ── Single token (container or bare constant) ────────────────────────────
  return parseSingleBracketToken(trimmed);
}

/**
 * The `@return` brackets this channel turns into a FACT, as the raw string
 * (`null` = stay silent). A return fact keys a coordinate the resolver trusts
 * over inference, so the shapes accepted are deliberately narrower than
 * {@link yardBracketToRef} understands:
 *
 *  - a single bare constant — the pre-27q0z shape, unchanged;
 *  - a comma list of bare constants and nil literals carrying AT LEAST ONE
 *    nominal arm (`[Firm, nil]`, `[User, Actor]`) — the nilable/union widening.
 *
 * Everything else stays dropped, and each exclusion earns its place: a
 * collection return (`[Array<Owner>]`, and now `[Array<Owner>, nil]`) genuinely
 * IS a collection rather than a dispatch target, an unparseable arm
 * (`Hash<Integer, Array<Actor>>`) makes the whole bracket a guess, and a
 * bracket with no nominal arm at all (`[nil]`) states no type — parking it at a
 * coordinate would shadow the body inference that could still answer there.
 */
function yardReturnBracket(inner: string): string | null {
  if (YARD_CONST.test(inner)) return inner;
  if (!inner.includes(",")) return null;
  let nominalArms = 0;
  for (const raw of inner.split(",")) {
    const token = raw.trim();
    if (YARD_NIL_TOKENS.has(token)) continue;
    if (!YARD_CONST.test(token)) return null;
    nominalArms += 1;
  }
  return nominalArms > 0 ? inner : null;
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
