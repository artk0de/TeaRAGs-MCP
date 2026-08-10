/**
 * "Does this import specifier's basename name this receiver?" — the kebab-case →
 * PascalCase convention comparator (bd tea-rags-mcp-kiuw), hoisted out of
 * `TSImportBasenameSymbolResolutionStrategy` for bd tea-rags-mcp-4kx9f.
 *
 * It moved because two callers now need the same answer and they cannot import
 * each other: the STRATEGY uses it to pick a target file, and
 * `targetsExternalImport` uses it to recognise the receiver the strategy would
 * have matched — and the strategy already imports the classifier for its guard,
 * so leaving the comparator behind would close a cycle. Neither copy nor cycle:
 * one module both sides depend on.
 */

/**
 * Match the basename of an import specifier against a receiver name,
 * normalizing both sides so the common TS kebab-case → PascalCase file/class
 * naming convention resolves. Examples:
 *
 *   "../rank-module.js" → basename "rank-module.js" → norm "rankmodule"
 *   "RankModule"                                    → norm "rankmodule"
 *   "./foo.ts"          → basename "foo.ts"         → norm "foo"
 *   "Foo"                                           → norm "foo"
 *
 * Arbitrary-name cases (filename unrelated to class) are handled by the
 * symbol-table FQN fallback in `receiverSymbol` — this comparator intentionally
 * only catches the cheap mirror cases.
 */
export function importSpecifierNamesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return normalizeIdentifier(last) === normalizeIdentifier(receiver);
}

function normalizeIdentifier(value: string): string {
  // Strip known source extensions before character normalization so `.d.ts`
  // and the dotted compound extensions still flatten cleanly.
  const stripped = stripSourceExtension(value);
  let out = "";
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) out += stripped[i];
    else if (isUpper) out += String.fromCharCode(code + 32);
  }
  return out;
}

function stripSourceExtension(value: string): string {
  // Recognised TS / JS source suffixes. `.d.ts` is checked before the
  // single-extension variants so the longer suffix wins.
  const lowered = value.toLowerCase();
  if (lowered.endsWith(".d.ts")) return value.slice(0, -5);
  if (lowered.endsWith(".tsx") || lowered.endsWith(".jsx") || lowered.endsWith(".mjs") || lowered.endsWith(".cjs")) {
    return value.slice(0, -4);
  }
  if (lowered.endsWith(".ts") || lowered.endsWith(".js")) return value.slice(0, -3);
  return value;
}
