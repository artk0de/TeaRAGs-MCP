/**
 * Which STATEMENT bound a residual row's receiver name (bd tea-rags-mcp-1v12o,
 * E5.0a).
 *
 * `scripts/lib/py-residual-families.ts` answers which MECHANISM would resolve a
 * row. This answers one level finer and only for the bare-name population: what
 * the receiver identifier IS. Exactly one binding per row, precedence
 * most-specific-first, `unbound` REPORTED rather than hidden — a classifier
 * that cannot say so is not a measurement.
 *
 * `self` and `cls` are not parameters here. They are E4.4's class-object
 * family, and counting them inflates `paramUnannotated` by an order of
 * magnitude (spec D7).
 */
export const PY_RECEIVER_BINDINGS = [
  "paramUnannotated",
  "paramAnnotated",
  "loopTarget",
  "comprehension",
  "tupleUnpack",
  "walrus",
  "exceptAs",
  "withAs",
  "assignCallProject",
  "assignCallExternal",
  "assignAlias",
  "assignOther",
  "moduleLevel",
  "unbound",
] as const;
export type PyReceiverBinding = (typeof PY_RECEIVER_BINDINGS)[number];

export interface PyParam {
  name: string;
  annotated: boolean;
  annotation: string | null;
}
export interface PyBindingSourceView {
  linesOf: (relPath: string) => readonly string[];
  isProjectClass: (name: string) => boolean;
  isProjectDef: (name: string) => boolean;
}
export interface PyBindingAttribution {
  binding: PyReceiverBinding;
  detail: string;
  defLine: number | null;
}

/** Names the fold must never treat as parameters (spec D7). */
export const IMPLICIT_RECEIVERS: ReadonlySet<string> = new Set(["self", "cls"]);

export const indentOf = (s: string): number => s.length - s.trimStart().length;

/**
 * Balanced-bracket span starting at the `(` at (line, col). Returns the INNER
 * text and the line it closed on; `null` when it does not close within 60
 * lines, which is a signature no report should guess at.
 */
export function bracketSpan(
  src: readonly string[],
  line: number,
  col: number,
): { text: string; endLine: number } | null {
  let depth = 0;
  let out = "";
  let l = line;
  let c = col;
  for (; l < src.length && l < line + 60; l++) {
    const s = src[l] ?? "";
    for (; c < s.length; c++) {
      const ch = s[c];
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) return { text: out, endLine: l };
      }
      out += ch;
    }
    out += " ";
    c = 0;
  }
  return null;
}

/** Split on TOP-LEVEL commas, respecting brackets and string literals. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Parse the `def` at `line` (0-based) into its name and parameter list. */
export function parsePythonDef(src: readonly string[], line: number): { name: string; params: PyParam[] } | null {
  const s = src[line] ?? "";
  const m = /(?:async\s+)?def\s+(\w+)\s*\(/.exec(s);
  if (m === null) return null;
  const span = bracketSpan(src, line, s.indexOf("(", m.index));
  if (span === null) return null;
  const params = splitTopLevel(span.text)
    .map((raw) => {
      const bare = raw.replace(/^\*+/, "").trim();
      const eq = bare.indexOf("=");
      const head = (eq === -1 ? bare : bare.slice(0, eq)).trim();
      const colon = head.indexOf(":");
      if (colon === -1) return { name: head, annotated: false, annotation: null };
      return { name: head.slice(0, colon).trim(), annotated: true, annotation: head.slice(colon + 1).trim() };
    })
    .filter((p) => /^[A-Za-z_]\w*$/.test(p.name));
  return { name: m[1], params };
}

/**
 * The `def` enclosing a 1-based call line.
 *
 * Walks up for the nearest line INDENTED LESS than the call that is a `def`; a
 * `class` header reached first means the call sits in a class body and has no
 * enclosing def. Every other dedented line — an `if`, a comment, a closing
 * bracket — is skipped WITHOUT lowering the watermark, which is the whole
 * correctness of the scan: a moving watermark drops to 0 on one flush-left
 * comment and orphans every row below it.
 */
export function enclosingPythonDef(
  src: readonly string[],
  callLine1: number,
): { line: number; name: string; params: PyParam[]; isMethod: boolean } | null {
  const idx = callLine1 - 1;
  if (idx < 0 || idx >= src.length) return null;
  const callIndent = indentOf(src[idx]);
  for (let i = idx; i >= 0; i--) {
    const s = src[i];
    if (s.trim() === "") continue;
    if (indentOf(s) >= callIndent) continue;
    if (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(s)) {
      const parsed = parsePythonDef(src, i);
      if (parsed === null) continue;
      const first = parsed.params[0]?.name;
      return { line: i, name: parsed.name, params: parsed.params, isMethod: IMPLICIT_RECEIVERS.has(first ?? "") };
    }
    if (/^\s*class\s+\w/.test(s)) return null;
  }
  return null;
}

/**
 * What an assignment's right-hand side says about the bound name.
 *
 * A DOTTED callee is tested at both ends. `Repo.from_session(s)` is an
 * in-project call because `Repo` is an in-project class, and the last segment
 * alone — `from_session` — names nothing the corpus declares at top level; a
 * last-segment-only test reads every classmethod factory as external, which is
 * polar's single largest binding family.
 */
function classifyRhs(rhs: string, view: PyBindingSourceView): { binding: PyReceiverBinding; detail: string } {
  const t = rhs.trim().replace(/^await\s+/, "");
  const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(t);
  if (call !== null) {
    const dotted = call[1];
    const segments = dotted.split(".");
    const head = segments[0];
    const tail = segments[segments.length - 1];
    const inProject =
      view.isProjectClass(tail) ||
      view.isProjectDef(tail) ||
      (segments.length > 1 && (view.isProjectClass(head) || view.isProjectDef(head)));
    return { binding: inProject ? "assignCallProject" : "assignCallExternal", detail: dotted.slice(0, 60) };
  }
  if (/^[A-Za-z_][\w.]*$/.test(t)) return { binding: "assignAlias", detail: t.slice(0, 60) };
  return { binding: "assignOther", detail: t.slice(0, 60) };
}

/**
 * The ONE binding statement for a residual row's receiver name. Precedence:
 * parameter → loop / comprehension → tuple unpack → walrus → `except` / `with`
 * → assignment → module scope → `unbound`, first match wins.
 */
export function classifyReceiverBinding(
  row: { relPath: string; startLine: number; receiver: string | null; receiverKind: string },
  view: PyBindingSourceView,
): PyBindingAttribution {
  const name = row.receiver ?? "";
  const src = view.linesOf(row.relPath);
  if (!/^[A-Za-z_]\w*$/.test(name) || src.length === 0) return { binding: "unbound", detail: "", defLine: null };
  const def = enclosingPythonDef(src, row.startLine);
  const defLine = def?.line ?? null;
  if (def !== null && !IMPLICIT_RECEIVERS.has(name)) {
    const param = def.params.find((p) => p.name === name);
    if (param !== undefined) {
      return { binding: param.annotated ? "paramAnnotated" : "paramUnannotated", detail: `def ${def.name}`, defLine };
    }
  }
  const stop = def?.line ?? 0;
  // The CALL's own line is scanned for the compound binders only. `for a in
  // xs: a.m()` and `if (a := g()): a.m()` bind on the line they call from, and
  // starting one line above reads both as `unbound`; the assignment branches
  // stay excluded there so `obj = obj.refresh()` is still read from the
  // binding above it rather than from itself.
  for (let i = row.startLine - 1; i >= stop; i--) {
    const callLine = i === row.startLine - 1;
    const line = (src[i] ?? "").trim();
    const forOne = new RegExp(`\\bfor\\s+${name}\\s+in\\s+([^:]+)`).exec(line);
    if (forOne !== null) {
      const comprehension = /^[[({]/.test(line) || /[[({][^\])}]*\bfor\s/.test(line);
      return {
        binding: comprehension ? "comprehension" : "loopTarget",
        detail: forOne[1].trim().slice(0, 60),
        defLine,
      };
    }
    if (new RegExp(`\\bfor\\s+[\\w\\s,]*\\b${name}\\b[\\w\\s,]*\\s+in\\s+`).test(line)) {
      return { binding: "tupleUnpack", detail: line.slice(0, 60), defLine };
    }
    if (new RegExp(`\\b${name}\\s*:=`).test(line)) return { binding: "walrus", detail: line.slice(0, 60), defLine };
    if (new RegExp(`\\bexcept\\b.*\\bas\\s+${name}\\b`).test(line)) {
      return { binding: "exceptAs", detail: line.slice(0, 60), defLine };
    }
    if (new RegExp(`\\bwith\\b.*\\bas\\s+${name}\\b`).test(line)) {
      return { binding: "withAs", detail: line.slice(0, 60), defLine };
    }
    if (callLine) continue;
    const assign = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*(.+)$`).exec(line);
    if (assign !== null) return { ...classifyRhs(assign[1], view), defLine };
    if (line.includes(",") && new RegExp(`^[\\w\\s,*]*\\b${name}\\b[\\w\\s,*]*=[^=]`).test(line)) {
      return { binding: "tupleUnpack", detail: line.slice(0, 60), defLine };
    }
  }
  for (const moduleLine of src) {
    if (indentOf(moduleLine) !== 0) continue;
    const assign = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*(.+)$`).exec(moduleLine.trim());
    if (assign === null) continue;
    const rhs = classifyRhs(assign[1], view);
    return {
      binding: rhs.binding === "assignOther" ? "moduleLevel" : rhs.binding,
      detail: `module: ${rhs.detail}`,
      defLine,
    };
  }
  return { binding: "unbound", detail: "", defLine };
}
