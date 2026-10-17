/**
 * Receiver-origin context (`CODEGRAPH_RESIDUAL_ORIGIN_CONTEXT`): a short
 * section appended to a question's method source naming where each receiver's
 * value comes from — the assignment lines the state does not already show
 * (same method for a local, anywhere in the file for an ivar, at most
 * {@link MAX_ASSIGNMENT_LINES}), and, when that value is the result of a call
 * to a method defined in the same file (`foo`, `self.foo`, the collection a
 * block parameter iterates), the head of that method's definition. Ruby only;
 * read from the file text, no walker pass. The section lives within a token
 * budget: an entry that does not fit is dropped, never cut.
 */

/** Kev refuses a state over this many tokens (`LEAN_MAX_STATE`). */
export const RESIDUAL_MAX_STATE_TOKENS = 2048;
/** The most tokens the origin section may take, whatever room the state leaves. */
export const MAX_ORIGIN_SECTION_TOKENS = 384;
/** Assignment lines shown per receiver. */
export const MAX_ASSIGNMENT_LINES = 3;
/** Body lines shown after a definition line. */
export const MAX_DEFINITION_BODY_LINES = 8;

const SECTION_HEADER = "# --- receiver origins (lines outside the method above) ---";

/** Conservative token count for code: three characters a token. */
export function estimateStateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface OriginContextInput {
  fileText: string;
  methodStartLine: number;
  methodEndLine: number;
  /** Whether the state already shows this 1-based file line. */
  visibleLines: (line: number) => boolean;
  /** Receiver texts of the request's questions. */
  receivers: readonly string[];
  /** Tokens the section may take; nothing fits → empty string. */
  maxTokens: number;
}

interface Entry {
  label: string;
  lines: number[];
}

const KEYWORDS = new Set([
  "if",
  "unless",
  "case",
  "begin",
  "nil",
  "true",
  "false",
  "lambda",
  "proc",
  "not",
  "super",
  "yield",
  "self",
  "new",
  "while",
  "until",
  "return",
]);

const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The variable or method a receiver chain starts at: `@x.y` → `@x`, `self.foo.bar` → `foo`; a constant or `self` → none. */
export function receiverHead(receiverText: string): string | undefined {
  const text = receiverText.trim().replace(/^self\./u, "");
  const match = /^@{0,2}[A-Za-z_]\w*[?!]?/u.exec(text);
  if (match === null) return undefined;
  const [head] = match;
  if (/^[A-Z]/u.test(head) || KEYWORDS.has(head)) return undefined;
  return head;
}

/** The project-method call an expression starts with: `foo.bar`, `self.foo(x)`, `foo` → `foo`. */
function callHead(expression: string): string | undefined {
  const text = expression.trim().replace(/^self\./u, "");
  const match = /^([a-z_]\w*[?!]?)(?=$|[\s.(&[])/u.exec(text);
  if (match === null || KEYWORDS.has(match[1])) return undefined;
  return match[1];
}

/** Section text for the request's receivers; empty when nothing is known or nothing fits. */
export function receiverOriginSection(input: OriginContextInput): string {
  const fileLines = input.fileText.split("\n");
  const entries: Entry[] = [];
  const shownLines = new Set<number>();
  const definedShown = new Set<string>();
  const add = (label: string, lines: number[]): void => {
    const fresh = lines.filter((n) => !input.visibleLines(n) && !shownLines.has(n));
    if (fresh.length === 0) return;
    for (const n of fresh) shownLines.add(n);
    entries.push({ label, lines: fresh });
  };
  const addDefinition = (name: string): void => {
    if (definedShown.has(name)) return;
    definedShown.add(name);
    const lines = definitionHead(fileLines, name, input);
    if (lines !== undefined) add(`def ${name}`, lines);
  };

  const heads = [...new Set(input.receivers.map(receiverHead).filter((h): h is string => h !== undefined))];
  for (const head of heads) {
    const origins = assignmentLines(fileLines, head, input);
    add(head, origins.slice(0, MAX_ASSIGNMENT_LINES));
    const calls = origins.map((n) => originCall(fileLines[n - 1], head)).filter((c): c is string => c !== undefined);
    if (origins.length === 0 && !head.startsWith("@") && !isParameter(fileLines[input.methodStartLine - 1], head)) {
      calls.push(head);
    }
    for (const call of new Set(calls)) addDefinition(call);
  }
  return render(entries, fileLines, input.maxTokens);
}

/** 1-based lines that give `head` its value: a local in its method, an ivar anywhere in the file. */
function assignmentLines(fileLines: readonly string[], head: string, input: OriginContextInput): number[] {
  const name = escape(head);
  const assigns = new RegExp(`(^|[^\\w@.:])${name}\\s*(\\|\\|=|=(?![=~>]))`, "u");
  const blockParam = new RegExp(`\\|[^|]*(?<![\\w@])${name}(?![\\w?!])[^|]*\\|`, "u");
  const ivar = head.startsWith("@");
  const [from, to] = ivar ? [1, fileLines.length] : [input.methodStartLine + 1, input.methodEndLine];
  const lines: number[] = [];
  for (let n = from; n <= to; n++) {
    const text = fileLines[n - 1] ?? "";
    if (assigns.test(text) || (!ivar && /\bdo\s*\||\{\s*\|/u.test(text) && blockParam.test(text))) lines.push(n);
  }
  return lines;
}

/** The call a line's value comes from: the right side of `head = …`, or the collection `….each do |head|` iterates. */
function originCall(text: string, head: string): string | undefined {
  const assigned = new RegExp(`${escape(head)}\\s*(?:\\|\\|=|=(?![=~>]))(.*)$`, "u").exec(text);
  if (assigned !== null) return callHead(assigned[1]);
  return callHead(text);
}

function isParameter(defLine: string | undefined, head: string): boolean {
  if (defLine === undefined) return false;
  const params = /^\s*def\s+[\w.?!=]+\s*\(?(.*?)\)?\s*$/u.exec(defLine)?.[1] ?? "";
  return new RegExp(`(^|[\\s,(*&])${escape(head)}(?![\\w?!])`, "u").test(params);
}

/** `def name` / `def self.name` outside the asking method: its line and up to {@link MAX_DEFINITION_BODY_LINES} more. */
function definitionHead(fileLines: readonly string[], name: string, input: OriginContextInput): number[] | undefined {
  const def = new RegExp(`^(\\s*)def\\s+(?:self\\.)?${escape(name)}(?![\\w?!=])`, "u");
  for (let n = 1; n <= fileLines.length; n++) {
    if (n >= input.methodStartLine && n <= input.methodEndLine) continue;
    const match = def.exec(fileLines[n - 1]);
    if (match === null) continue;
    const indent = match[1];
    const lines = [n];
    for (let k = n + 1; k <= Math.min(fileLines.length, n + MAX_DEFINITION_BODY_LINES); k++) {
      lines.push(k);
      if (fileLines[k - 1] === `${indent}end`) break;
    }
    return lines;
  }
  return undefined;
}

/** Entries in order while the section fits `maxTokens`; gaps inside an entry marked `…`. */
function render(entries: readonly Entry[], fileLines: readonly string[], maxTokens: number): string {
  const out: string[] = [SECTION_HEADER];
  for (const entry of entries) {
    const block = [`# ${entry.label}`];
    let previous = -1;
    for (const n of entry.lines) {
      if (previous !== -1 && n > previous + 1) block.push("…");
      block.push(fileLines[n - 1]);
      previous = n;
    }
    if (estimateStateTokens([...out, ...block].join("\n")) > maxTokens) continue;
    out.push(...block);
  }
  return out.length === 1 ? "" : out.join("\n");
}

export interface OriginStateInput {
  sourceRelPath: string;
  methodStartLine: number;
  methodEndLine: number;
  receivers: readonly string[];
  /** The whole file; absent = the variant is off and the source goes out unchanged. */
  fileText: string | undefined;
  visibleLines: (line: number) => boolean;
}

/**
 * `methodSource` with the origin section appended, budgeted so the state stays
 * under {@link RESIDUAL_MAX_STATE_TOKENS}; byte-identical when the variant is
 * off, nothing is known, or nothing fits.
 */
export function sourceWithOrigins(methodSource: string, input: OriginStateInput): string {
  if (input.fileText === undefined) return methodSource;
  const used = estimateStateTokens(`# file: ${input.sourceRelPath}\n${methodSource}\n`);
  const room = Math.min(MAX_ORIGIN_SECTION_TOKENS, RESIDUAL_MAX_STATE_TOKENS - used);
  if (room <= 0) return methodSource;
  const section = receiverOriginSection({
    fileText: input.fileText,
    methodStartLine: input.methodStartLine,
    methodEndLine: input.methodEndLine,
    visibleLines: input.visibleLines,
    receivers: input.receivers,
    maxTokens: room,
  });
  return section === "" ? methodSource : `${methodSource}\n${section}`;
}
