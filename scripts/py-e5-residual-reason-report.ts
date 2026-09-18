/**
 * E5.0a — WHY the bare-name residual stays untyped (bd tea-rags-mcp-1v12o.1.1).
 *
 * Usage:
 *   npx tsx scripts/py-e5-residual-reason-report.ts --corpus polar \
 *     --rows ~/.claude/jobs/dffe3647/tmp/e44b/A-polar.ndjson \
 *     --corpus-root ~/Dev/Tools/tea-rags-bench/corpora/polar --json /tmp/e5/polar.json
 *
 * The corpus root must be the corpus's REAL root from
 * `scripts/lib/codegraph-corpora.json` — flask and ugnest do not live under
 * `tea-rags-bench/corpora/`, and passing the wrong root is a silent zero on
 * every source read rather than an error (E4.6 plan, decision 1).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  annotationNominal,
  calleeReturnNominal,
  classifyBindingReason,
  importNarrowsToOne,
  PY_BINDING_REASONS,
  type PyDefFacts,
  type PyReasonView,
} from "./lib/py-binding-reasons.js";
import {
  classifyReceiverBinding,
  enclosingPythonDef,
  indentOf,
  PY_RECEIVER_BINDINGS,
  type PyBindingAttribution,
} from "./lib/py-receiver-binding.js";

const RESIDUAL = new Set(["missed", "fileOnly", "wrongFile", "skippedInProject"]);
const BARE_KINDS = new Set(["dynamic", "localVar", "selfMember"]);
const SKIP_DIRS = new Set([".venv", "venv", "node_modules", "__pycache__", "site-packages", ".tox", "build", "dist"]);

interface DumpRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
  verdict: string;
}

interface Corpus {
  lines: Map<string, string[]>;
  classFiles: Map<string, string[]>;
  protocols: Set<string>;
  defs: Map<string, PyDefFacts[]>;
  imports: Map<string, string[]>;
  typeVars: Map<string, Set<string>>;
  fieldAnnotations: Map<string, Map<string, string>>;
}

function emptyCorpus(): Corpus {
  return {
    lines: new Map(),
    classFiles: new Map(),
    protocols: new Set(),
    defs: new Map(),
    imports: new Map(),
    typeVars: new Map(),
    fieldAnnotations: new Map(),
  };
}

/** Every `return <expr>` and every `yield` inside the def opened at `line`. */
function defBody(src: readonly string[], line: number): { returnExprs: string[]; hasYield: boolean } {
  const own = indentOf(src[line]);
  const returnExprs: string[] = [];
  let hasYield = false;
  for (let i = line + 1; i < src.length; i++) {
    const s = src[i];
    if (s.trim() === "") continue;
    if (indentOf(s) <= own) break;
    if (/^\s*(?:async\s+)?def\s/.test(s)) continue;
    if (/\byield\b/.test(s)) hasYield = true;
    const ret = /^\s*return\s+(.+?)\s*$/.exec(s);
    if (ret !== null) returnExprs.push(ret[1]);
  }
  return { returnExprs, hasYield };
}

function indexFile(rel: string, src: string[], corpus: Corpus): void {
  const imports: string[] = [];
  const typeVars = new Set<string>();
  const fields = new Map<string, string>();
  let openClass: { name: string; indent: number } | null = null;
  let decorators: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    // A parenthesised `from x import (\n  A,\n  B,\n)` carries its NAMES on the
    // following lines; indexing the head alone makes every such import look
    // like it binds nothing, and polar writes most of its model imports this
    // way. Join until the bracket closes.
    if (/^\s*(?:from\s+[.\w]+\s+)?import\s/.test(s)) {
      if (!s.includes("(")) imports.push(s);
      else {
        let joined = s;
        for (let j = i + 1; j < src.length && !joined.includes(")"); j++) joined += ` ${src[j].trim()}`;
        imports.push(joined);
      }
    }
    const tv = /^\s*(\w+)\s*=\s*TypeVar\s*\(/.exec(s);
    if (tv !== null) typeVars.add(tv[1]);
    if (/^\s*@/.test(s)) {
      decorators.push(s.trim());
      continue;
    }
    const cls = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(s);
    if (cls !== null) {
      const name = cls[2];
      const files = corpus.classFiles.get(name) ?? [];
      if (!files.includes(rel)) files.push(rel);
      corpus.classFiles.set(name, files);
      if (/\bProtocol\b/.test(cls[3] ?? "")) corpus.protocols.add(name);
      openClass = { name, indent: cls[1].length };
      decorators = [];
      continue;
    }
    const field = /^\s+(\w+)\s*:\s*([^=#]+?)\s*(?:=|$)/.exec(s);
    if (field !== null && openClass !== null && indentOf(s) > openClass.indent) {
      fields.set(`${openClass.name}.${field[1]}`, field[2].trim());
    }
    const def = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(s);
    if (def === null) {
      decorators = [];
      continue;
    }
    const name = def[2];
    const returnType = /\)\s*->\s*([^:]+):\s*$/.exec(s);
    const body = defBody(src, i);
    const list = corpus.defs.get(name) ?? [];
    list.push({
      relPath: rel,
      line: i,
      returnAnnotation: returnType === null ? null : returnType[1].trim(),
      isClassMethod: decorators.some((d) => d.includes("classmethod")),
      isAsync: /^\s*async\s+def/.test(s),
      hasYield: body.hasYield,
      returnExprs: body.returnExprs,
    });
    corpus.defs.set(name, list);
    decorators = [];
    if (openClass !== null && def[1].length <= openClass.indent) openClass = null;
  }
  corpus.imports.set(rel, imports);
  corpus.typeVars.set(rel, typeVars);
  corpus.fieldAnnotations.set(rel, fields);
}

function loadCorpus(root: string): Corpus {
  const corpus = emptyCorpus();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith(".py")) continue;
      let src: string[];
      try {
        src = readFileSync(full, "utf8").split("\n");
      } catch {
        continue;
      }
      const rel = relative(root, full);
      corpus.lines.set(rel, src);
      indexFile(rel, src, corpus);
    }
  }
  return corpus;
}

/** Corpus files a dotted module path could name, relative imports resolved against `from`. */
function moduleFiles(module: string, fromFile: string, corpus: Corpus): string[] {
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const tail = module.slice(dots).split(".").filter(Boolean).join("/");
  const base =
    dots === 0
      ? tail
      : [...dir.split("/").slice(0, dir === "" ? 0 : -(dots - 1) || undefined), tail].filter((s) => s !== "").join("/");
  const suffixes = [`${base}.py`, `${base}/__init__.py`];
  return [...corpus.lines.keys()].filter((f) => suffixes.some((s) => f === s || f.endsWith(`/${s}`)));
}

/**
 * Does the caller's import set pick exactly one candidate, with ONE re-export
 * hop allowed? `from polar.models import Subscription` lands on a package
 * `__init__.py`, and `resolveTypeFile` already follows that hop
 * (`resolveExportedName`) — so counting the hop is what separates "the caller
 * did write it down" from "the run would have to guess".
 */
function narrowsWithReexport(callerFile: string, name: string, candidates: readonly string[], corpus: Corpus): boolean {
  const reached = new Set<string>();
  for (const line of corpus.imports.get(callerFile) ?? []) {
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (from === null) continue;
    const names = from[2].replace(/[()]/g, "").split(",");
    if (!names.some((n) => ((n.split(/\s+as\s+/)[0] ?? "").trim().split(".").pop() ?? "") === name)) continue;
    for (const file of moduleFiles(from[1], callerFile, corpus)) {
      reached.add(file);
      for (const inner of corpus.imports.get(file) ?? []) {
        const hop = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(inner);
        if (hop === null) continue;
        const exported = hop[2].replace(/[()]/g, "").split(",");
        if (!exported.some((n) => ((n.split(/\s+as\s+/)[0] ?? "").trim().split(".").pop() ?? "") === name)) continue;
        for (const target of moduleFiles(hop[1], file, corpus)) reached.add(target);
      }
    }
  }
  return candidates.filter((c) => reached.has(c)).length === 1;
}

/** Files declaring this short name as a class OR as a `def` — the namesake candidate set. */
function declaringFiles(name: string, corpus: Corpus): string[] {
  const files = new Set(corpus.classFiles.get(name) ?? []);
  for (const def of corpus.defs.get(name) ?? []) files.add(def.relPath);
  return [...files];
}

/**
 * The type NAME a row's receiver would have to be keyed by, when the row shape
 * determines one. `null` is reported, never guessed at: the E-table's
 * `notDerivable` line is what keeps the namesake count honest.
 */
function receiverTypeName(
  row: DumpRow,
  attribution: PyBindingAttribution,
  corpus: Corpus,
  view: PyReasonView,
): string | null {
  const src = corpus.lines.get(row.relPath) ?? [];
  if (attribution.binding === "paramAnnotated") {
    const def = enclosingPythonDef(src, row.startLine);
    const annotation = def?.params.find((p) => p.name === row.receiver)?.annotation;
    return annotation === undefined || annotation === null ? null : annotationNominal(annotation);
  }
  if (attribution.binding === "assignCallProject" || attribution.binding === "assignCallExternal") {
    const nominal = calleeReturnNominal(attribution.detail, view);
    if (nominal !== null) return nominal;
    // No single return type BECAUSE the callee itself is ambiguous — the name
    // the run would have to disambiguate is then the callee's own.
    const tail = attribution.detail.split(".").pop() as string;
    return declaringFiles(tail, corpus).length >= 2 ? tail : null;
  }
  const field = /^self\.(\w+)$/.exec(row.receiver ?? "");
  if (field === null) return null;
  for (let i = row.startLine - 1; i >= 0; i--) {
    const cls = /^\s*class\s+(\w+)/.exec(src[i] ?? "");
    if (cls === null) continue;
    const annotation = corpus.fieldAnnotations.get(row.relPath)?.get(`${cls[1]}.${field[1]}`);
    return annotation === undefined ? null : annotationNominal(annotation);
  }
  return null;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const rowsPath = flag("rows") as string;
const corpusName = flag("corpus") ?? "corpus";
const corpus = loadCorpus(flag("corpus-root") as string);

const bindingView = {
  linesOf: (rel: string) => corpus.lines.get(rel) ?? [],
  isProjectClass: (n: string) => (corpus.classFiles.get(n) ?? []).length > 0,
  isProjectDef: (n: string) => (corpus.defs.get(n) ?? []).length > 0,
};
const reasonView: PyReasonView = {
  linesOf: bindingView.linesOf,
  defsNamed: (n: string) => corpus.defs.get(n) ?? [],
  classFilesNamed: (n: string) => corpus.classFiles.get(n) ?? [],
  importLinesOf: (rel: string) => corpus.imports.get(rel) ?? [],
  isProtocolClass: (n: string) => corpus.protocols.has(n),
  typeVarNames: (rel: string) => corpus.typeVars.get(rel) ?? new Set<string>(),
  fieldAnnotationOf: (rel: string, callLine1: number, field: string) => {
    const src = corpus.lines.get(rel) ?? [];
    for (let i = callLine1 - 1; i >= 0; i--) {
      const cls = /^\s*class\s+(\w+)/.exec(src[i] ?? "");
      if (cls === null) continue;
      return corpus.fieldAnnotations.get(rel)?.get(`${cls[1]}.${field}`) ?? null;
    }
    return null;
  },
};

const rows: DumpRow[] = readFileSync(rowsPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as DumpRow)
  .filter((r) => RESIDUAL.has(r.verdict));

const binding: Record<string, number> = {};
const reason: Record<string, number> = {};
const samples: Record<string, string[]> = {};
const namesake = {
  ambiguous: 0,
  importNarrows: 0,
  reexportNarrows: 0,
  unique: 0,
  notDerivable: 0,
  names: {} as Record<string, number>,
};
let bareNames = 0;

for (const row of rows) {
  const attribution = classifyReceiverBinding(row, bindingView);
  const typeName = receiverTypeName(row, attribution, corpus, reasonView);
  if (typeName === null) namesake.notDerivable++;
  else {
    const files = declaringFiles(typeName, corpus);
    if (files.length < 2) namesake.unique++;
    else {
      namesake.ambiguous++;
      namesake.names[typeName] = (namesake.names[typeName] ?? 0) + 1;
      if (importNarrowsToOne(row.relPath, typeName, files, reasonView)) namesake.importNarrows++;
      if (narrowsWithReexport(row.relPath, typeName, files, corpus)) namesake.reexportNarrows++;
    }
  }
  const bare = BARE_KINDS.has(row.receiverKind) && /^[A-Za-z_]\w*$/.test(row.receiver ?? "");
  if (!bare) continue;
  bareNames++;
  binding[attribution.binding] = (binding[attribution.binding] ?? 0) + 1;
  const why = classifyBindingReason(row, attribution, reasonView);
  reason[why] = (reason[why] ?? 0) + 1;
  const slot = (samples[why] ??= []);
  if (slot.length < 8) {
    slot.push(
      `${row.relPath}:${row.startLine} ${row.callText.slice(0, 52)} <= ${attribution.binding} ${attribution.detail}`,
    );
  }
}

const report = {
  corpus: corpusName,
  residualRows: rows.length,
  bareNameReceivers: bareNames,
  binding: Object.fromEntries(PY_RECEIVER_BINDINGS.map((b) => [b, binding[b] ?? 0])),
  reason: Object.fromEntries(PY_BINDING_REASONS.map((r) => [r, reason[r] ?? 0])),
  namesake,
  samples,
};
const out = flag("json");
if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
