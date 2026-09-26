/**
 * Regex-based import/export extraction from source code.
 *
 * Every scan runs over {@link maskNonCodeText}'s mask, never the raw text, so
 * import-shaped prose in comments, docstrings and string / template literals
 * is not harvested as a dependency (bd tea-rags-mcp-mjq5n). A specifier is a
 * string literal itself, so it is located in the mask (delimiters survive) and
 * read from the original source at the same offsets.
 */

import { maskNonCodeText } from "./non-code-text-mask.js";

export function extractImportsExports(
  code: string,
  language: string,
): {
  imports: string[];
  exports: string[];
} {
  const imports: string[] = [];
  const exports: string[] = [];

  if (language === "typescript" || language === "javascript") {
    const masked = maskNonCodeText(code, "ecmascript");

    // Extract imports
    for (const match of masked.matchAll(/import\s+.*?\s+from\s+(['"])[^'"\n]*\1/g)) {
      imports.push(literalContents(code, match));
    }

    // Extract require statements
    for (const match of masked.matchAll(/require\s*\(\s*(['"])[^'"\n]*\1\s*\)/g)) {
      imports.push(literalContents(code, match));
    }

    // Extract exports - regular declarations
    const exportMatches = masked.matchAll(/export\s+(?:class|function|const|let|var)\s+(\w+)/g);
    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    // Extract export default
    if (/export\s+default\b/.test(masked)) {
      exports.push("default");
    }

    // Extract named exports from other modules: export { name } from 'module'
    const reExportMatches = masked.matchAll(/export\s+\{\s*(\w+)\s*\}/g);
    for (const match of reExportMatches) {
      exports.push(match[1]);
    }
  } else if (language === "python") {
    const masked = maskNonCodeText(code, "python");

    // Extract imports. A comment after the import list is masked to blanks,
    // so the captured list is trimmed rather than carrying them.
    const importMatches = masked.matchAll(/(?:from\s+(\S+)\s+)?import\s+([^;\n]+)/g);
    for (const match of importMatches) {
      imports.push(match[1] || match[2].trimEnd());
    }

    // Extract functions/classes (rough)
    const defMatches = masked.matchAll(/^(?:def|class)\s+(\w+)/gm);
    for (const match of defMatches) {
      exports.push(match[1]);
    }
  }

  return { imports, exports };
}

/**
 * Original-source contents of the LAST string literal in a match over the mask,
 * whose quote character is capture group 1. The mask blanks literal contents
 * but keeps both quotes at their original offsets, so the last two occurrences
 * of that quote in the masked match are the literal's delimiters.
 */
function literalContents(code: string, match: RegExpMatchArray): string {
  const [text, quote] = match;
  const start = match.index ?? 0;
  const close = text.lastIndexOf(quote);
  const open = text.lastIndexOf(quote, close - 1);
  return code.slice(start + open + 1, start + close);
}
