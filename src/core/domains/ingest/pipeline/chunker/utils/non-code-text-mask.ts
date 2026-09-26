/**
 * Offset-preserving mask over the text a regex scan must NOT read as code
 * (bd tea-rags-mcp-mjq5n).
 *
 * The regex import/export scan in `import-extractor.ts` has no notion of
 * lexical context: a JSDoc example `import Button from './Button'`, a probe
 * string embedding React source, or a Python docstring usage block all look
 * exactly like a real import. This module blanks those regions so the scan
 * only ever matches CODE.
 *
 * Contract:
 *  - the result has the SAME length as the input, so a match offset in the mask
 *    is the same offset in the original source;
 *  - comment text is replaced by spaces;
 *  - string / template / regex literal CONTENTS are replaced by spaces, their
 *    delimiters are kept, so a caller can locate a literal in the mask and read
 *    its real contents from the original at the same offsets;
 *  - `${ … }` substitutions inside a template literal stay code;
 *  - line breaks are always kept, so `^`/`$` anchored scans still see lines.
 *
 * Single-quoted and double-quoted literals (and regex literals) end at a line
 * break even when unterminated — a stray apostrophe in JSX text or prose can
 * then corrupt at most the rest of its own line, never the rest of the file.
 */

/** Lexical family whose comment/string grammar the mask applies. */
export type NonCodeMaskSyntax = "ecmascript" | "python";

export function maskNonCodeText(code: string, syntax: NonCodeMaskSyntax): string {
  const out = code.split("");
  if (syntax === "python") maskPython(code, out);
  else maskEcmascript(code, out);
  return out.join("");
}

function blank(code: string, out: string[], from: number, to: number): void {
  for (let i = from; i < to && i < code.length; i++) {
    const ch = code[i];
    if (ch !== "\n" && ch !== "\r") out[i] = " ";
  }
}

/** Index just past the closing `quote` of a one-line literal opened before `start`. */
function endOfLineBoundedLiteral(code: string, start: number, quote: string): number {
  let i = start;
  while (i < code.length && code[i] !== quote && code[i] !== "\n") {
    i += code[i] === "\\" ? 2 : 1;
  }
  return Math.min(i, code.length);
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** Punctuators after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_PUNCTUATORS = "(,=:[!&|?{};+-*%<>~^";

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function maskEcmascript(code: string, out: string[]): void {
  const n = code.length;
  // Brace depth at which each open `${` substitution returns to its template.
  const templateReturnDepth: number[] = [];
  let braceDepth = 0;
  let inTemplateText = false;
  // What preceded a `/` decides regex vs division: the last significant code
  // character ("" at file start) and, when that was a word, the word itself.
  let lastSignificant = "";
  let lastWord = "";
  let i = 0;

  while (i < n) {
    const ch = code[i];

    if (inTemplateText) {
      if (ch === "\\") {
        blank(code, out, i, i + 2);
        i += 2;
      } else if (ch === "`") {
        inTemplateText = false;
        lastSignificant = "`";
        lastWord = "";
        i++;
      } else if (ch === "$" && code[i + 1] === "{") {
        templateReturnDepth.push(braceDepth);
        braceDepth++;
        inTemplateText = false;
        lastSignificant = "{";
        lastWord = "";
        i += 2;
      } else {
        blank(code, out, i, i + 1);
        i++;
      }
      continue;
    }

    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(code, out, i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(code, out, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = endOfLineBoundedLiteral(code, i + 1, ch);
      blank(code, out, i + 1, close);
      i = close + 1;
      lastSignificant = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`") {
      inTemplateText = true;
      i++;
      continue;
    }
    if (ch === "/" && regexLiteralAllowed(lastSignificant, lastWord)) {
      const close = endOfRegexLiteral(code, i + 1);
      blank(code, out, i + 1, close);
      i = close + 1;
      // A regex literal is an operand: a `/` right after it divides.
      lastSignificant = ")";
      lastWord = "";
      continue;
    }
    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (templateReturnDepth.length > 0 && braceDepth === templateReturnDepth[templateReturnDepth.length - 1]) {
        templateReturnDepth.pop();
        inTemplateText = true;
        i++;
        continue;
      }
    }

    if (isIdentifierChar(ch)) {
      let end = i + 1;
      while (end < n && isIdentifierChar(code[end])) end++;
      lastWord = code.slice(i, end);
      lastSignificant = "a";
      i = end;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastSignificant = ch;
      lastWord = "";
    }
    i++;
  }
}

function regexLiteralAllowed(lastSignificant: string, lastWord: string): boolean {
  if (lastSignificant === "") return true;
  if (lastSignificant === "a") return REGEX_PRECEDING_KEYWORDS.has(lastWord);
  return lastSignificant === "}" || REGEX_PRECEDING_PUNCTUATORS.includes(lastSignificant);
}

/** Index of the closing `/` of a regex literal whose body starts at `start`. */
function endOfRegexLiteral(code: string, start: number): number {
  let inClass = false;
  let i = start;
  while (i < code.length && code[i] !== "\n") {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
    i++;
  }
  return Math.min(i, code.length);
}

function maskPython(code: string, out: string[]): void {
  const n = code.length;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (ch === "#") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(code, out, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (code.startsWith(triple, i)) {
        let j = i + 3;
        while (j < n && !code.startsWith(triple, j)) j += code[j] === "\\" ? 2 : 1;
        blank(code, out, i + 3, j);
        i = Math.min(j, n) + 3;
      } else {
        const close = endOfLineBoundedLiteral(code, i + 1, ch);
        blank(code, out, i + 1, close);
        i = close + 1;
      }
      continue;
    }
    i++;
  }
}
