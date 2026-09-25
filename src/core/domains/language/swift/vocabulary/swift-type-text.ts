/**
 * A Swift TYPE spelled as text, parsed into the few shapes resolution reads —
 * the SDK substrate publishes every declared and returned type as text
 * (`Result<Success, NewFailure>`, `(Self.Element) throws -> Void`,
 * `[String : Any]?`), and the resolver needs its nominal, its generic
 * arguments, an optional's wrapped type and a function type's parameters.
 *
 * Everything that does not change which members a value has is dropped on the
 * way in: attributes (`@escaping`, `@Sendable`), ownership and isolation
 * keywords (`inout`, `borrowing`, `sending`), `any` / `some`, effects
 * (`async`, `throws(E)`), tuple labels, and every member of a protocol
 * composition but the first. A spelling the grammar below does not cover
 * parses to `undefined`, never to a guess.
 */

/** A parsed Swift type. `path` is the dotted nominal (`AsyncStream.Continuation`, `Self.Element`). */
export type SwiftTypeExpr =
  | { readonly kind: "nominal"; readonly path: string; readonly args: readonly SwiftTypeExpr[] }
  | { readonly kind: "optional"; readonly wrapped: SwiftTypeExpr }
  | { readonly kind: "array"; readonly element: SwiftTypeExpr }
  | { readonly kind: "dictionary"; readonly key: SwiftTypeExpr; readonly value: SwiftTypeExpr }
  | { readonly kind: "function"; readonly params: readonly SwiftTypeExpr[]; readonly returns: SwiftTypeExpr }
  | { readonly kind: "tuple"; readonly elements: readonly SwiftTypeExpr[] }
  | { readonly kind: "metatype"; readonly instance: SwiftTypeExpr };

/** Words that qualify a type without changing its members. */
const IGNORED_WORDS: ReadonlySet<string> = new Set([
  "any",
  "some",
  "inout",
  "borrowing",
  "consuming",
  "sending",
  "__owned",
  "__shared",
  "isolated",
  "nonisolated",
  "each",
  "repeat",
]);

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? "";
  }

  startsWith(token: string): boolean {
    this.skipSpace();
    return this.text.startsWith(token, this.pos);
  }

  eat(token: string): boolean {
    if (!this.startsWith(token)) return false;
    this.pos += token.length;
    return true;
  }

  identifier(): string | undefined {
    this.skipSpace();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (!match) return undefined;
    this.pos += match[0].length;
    return match[0];
  }

  /** Skip a balanced `( … )` group starting at the cursor. */
  skipParenGroup(): boolean {
    if (!this.eat("(")) return false;
    let depth = 1;
    while (this.pos < this.text.length && depth > 0) {
      const ch = this.text[this.pos++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    return depth === 0;
  }
}

/** Parse a Swift type spelling, or `undefined` when it is not one this grammar covers. */
export function parseSwiftTypeText(text: string): SwiftTypeExpr | undefined {
  const scanner = new Scanner(text);
  const type = parseType(scanner);
  if (type === undefined) return undefined;
  scanner.skipSpace();
  return scanner.pos === text.length ? type : undefined;
}

function parseType(s: Scanner): SwiftTypeExpr | undefined {
  skipPrefixes(s);
  let base = parsePrimary(s);
  if (base === undefined) return undefined;
  for (;;) {
    if (s.eat("?") || s.eat("!")) {
      base = { kind: "optional", wrapped: base };
      continue;
    }
    if (s.startsWith("...")) {
      s.eat("...");
      base = { kind: "array", element: base };
      continue;
    }
    // `.Type` / `.Protocol` on a non-nominal (a nominal takes them in parsePrimary).
    if (s.eat(".Type") || s.eat(".Protocol")) {
      base = { kind: "metatype", instance: base };
      continue;
    }
    break;
  }
  // A protocol composition answers its first member.
  while (s.eat("&")) {
    if (parseType(s) === undefined) return undefined;
  }
  // A function type: the primary was its parenthesised parameter list.
  if (base.kind === "tuple" || s.startsWith("async") || s.startsWith("throws") || s.startsWith("rethrows")) {
    const effectsStart = s.pos;
    skipEffects(s);
    if (s.eat("->")) {
      const returns = parseType(s);
      if (returns === undefined) return undefined;
      const params = base.kind === "tuple" ? base.elements : [base];
      return { kind: "function", params, returns };
    }
    s.pos = effectsStart;
  }
  return base;
}

/** Attributes and qualifying keywords ahead of a type. */
function skipPrefixes(s: Scanner): void {
  for (;;) {
    if (s.peek() === "@") {
      s.eat("@");
      if (s.identifier() === undefined) return;
      // Attribute arguments touch the name (`@_lifetime(…)`); `@Sendable (T) -> U` is a type.
      if (s.text[s.pos] === "(") s.skipParenGroup();
      continue;
    }
    const save = s.pos;
    const word = s.identifier();
    if (word !== undefined && IGNORED_WORDS.has(word) && /^\s/.test(s.text[s.pos] ?? "")) continue;
    s.pos = save;
    return;
  }
}

/** `async`, `throws`, `throws(E)`, `rethrows`, in any order. */
function skipEffects(s: Scanner): void {
  for (;;) {
    const save = s.pos;
    const word = s.identifier();
    if (word === "async" || word === "rethrows") continue;
    if (word === "throws") {
      if (s.startsWith("(")) s.skipParenGroup();
      continue;
    }
    s.pos = save;
    return;
  }
}

function parsePrimary(s: Scanner): SwiftTypeExpr | undefined {
  const ch = s.peek();
  if (ch === "[") return parseCollection(s);
  if (ch === "(") return parseTuple(s);
  return parseNominal(s);
}

function parseCollection(s: Scanner): SwiftTypeExpr | undefined {
  s.eat("[");
  const first = parseType(s);
  if (first === undefined) return undefined;
  if (s.eat(":")) {
    const value = parseType(s);
    if (value === undefined || !s.eat("]")) return undefined;
    return { kind: "dictionary", key: first, value };
  }
  return s.eat("]") ? { kind: "array", element: first } : undefined;
}

function parseTuple(s: Scanner): SwiftTypeExpr | undefined {
  s.eat("(");
  const elements: SwiftTypeExpr[] = [];
  if (s.eat(")")) return { kind: "tuple", elements };
  for (;;) {
    skipTupleLabel(s);
    const element = parseType(s);
    if (element === undefined) return undefined;
    elements.push(element);
    if (s.eat(",")) continue;
    if (s.eat(")")) break;
    return undefined;
  }
  return elements.length === 1 && !s.startsWith("->") && !s.startsWith("throws") && !s.startsWith("async")
    ? elements[0]
    : { kind: "tuple", elements };
}

/** `name:` / `_ name:` ahead of a tuple element or a function parameter. */
function skipTupleLabel(s: Scanner): void {
  const save = s.pos;
  const first = s.identifier();
  if (first === undefined) return;
  if (s.eat(":")) return;
  const second = s.identifier();
  if (second !== undefined && s.eat(":")) return;
  s.pos = save;
}

function parseNominal(s: Scanner): SwiftTypeExpr | undefined {
  const segments: string[] = [];
  const args: SwiftTypeExpr[] = [];
  for (;;) {
    const name = s.identifier();
    if (name === undefined) return undefined;
    if (name === "Type" || name === "Protocol") {
      if (segments.length === 0) return undefined;
      return { kind: "metatype", instance: { kind: "nominal", path: segments.join("."), args } };
    }
    segments.push(name);
    if (s.startsWith("<")) {
      s.eat("<");
      for (;;) {
        const arg = parseType(s);
        if (arg === undefined) return undefined;
        args.push(arg);
        if (s.eat(",")) continue;
        if (s.eat(">")) break;
        return undefined;
      }
    }
    // A `.` continues the path only when an identifier follows it.
    const save = s.pos;
    if (s.eat(".") && /^[A-Za-z_]/.test(s.text.slice(s.pos))) continue;
    s.pos = save;
    break;
  }
  return { kind: "nominal", path: segments.join("."), args };
}

/**
 * The nominal type a parsed type IS, in the SDK's own names: `[T]` is an
 * `Array`, `[K: V]` a `Dictionary`, `T?` an `Optional`; `undefined` for a
 * function, tuple or metatype.
 */
export function swiftTypeExprNominal(expr: SwiftTypeExpr): string | undefined {
  switch (expr.kind) {
    case "nominal":
      return expr.path;
    case "array":
      return "Array";
    case "dictionary":
      return "Dictionary";
    case "optional":
      return "Optional";
    case "function":
    case "tuple":
    case "metatype":
      return undefined;
  }
}

/**
 * The nominal a type id is SPELLED as — an extension's composed id may carry
 * sugar or generic arguments (`[HTTPHeader]`, `Collection<String>`, bd
 * tea-rags-mcp-y99pg.14, .19). An id that does not parse is its own nominal.
 */
export function swiftSpelledNominal(typeId: string): string {
  const expr = parseSwiftTypeText(typeId);
  return (expr === undefined ? undefined : swiftTypeExprNominal(expr)) ?? typeId;
}
