/**
 * Family attribution report over an oracle row dump (bd tea-rags-mcp-w205u,
 * E4.0.4). Reads one corpus's `--oracle merged --dispatch` dump, assigns every
 * RESIDUAL row exactly one family via `scripts/lib/py-residual-families.ts`,
 * and prints the family × receiverKind table plus the edge-density families
 * counted over the whole population.
 *
 * The residual is `missed | fileOnly | wrongFile | skippedInProject`, plus
 * `bothUnresolved` rows whose oracle target is in-project. That last set is
 * EMPTY by construction on all five corpora — `classifyPyVerdict` cannot emit
 * `bothUnresolved` for an oracle answer it located in-project — and the report
 * prints its count so the reader can see it was checked rather than assumed.
 *
 * Usage:
 *   npx tsx scripts/py-e4-family-report.ts --rows <dump.ndjson> \
 *     --corpus-root <abs path> [--corpus <name>] [--json out.json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyResidualFamily,
  PY_FAMILY_INCREMENT,
  PY_RESIDUAL_FAMILIES,
  PY_TIER2_FAMILIES,
  type PyResidualFamily,
  type PyResidualRow,
  type PyResidualSourceView,
} from "./lib/py-residual-families.js";

interface DumpRow extends PyResidualRow {
  answeredBy: string;
  oracleEngine: string;
  oracleOrigin: string | null;
  dispatchOutcome: string;
  fanSize: number;
}

const RESIDUAL_VERDICTS = new Set(["missed", "fileOnly", "wrongFile", "skippedInProject"]);
const IN_PROJECT_ORIGINS = new Set(["project", "generatedInRepo"]);

/**
 * Corpus-wide facts tier 2 needs that are not in any single caller file:
 * which classes subclass `Protocol`, and which names are `@pytest.fixture`
 * defs. One walk, both answers — the walk is the expensive part, not the regex.
 */
function scanCorpusFacts(corpusRoot: string): { protocols: Set<string>; fixtures: Set<string> } {
  const protocols = new Set<string>();
  const fixtures = new Set<string>();
  const stack = [corpusRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "__pycache__") continue;
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
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(/^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) {
        if (/\bProtocol\b/.test(match[2] ?? "")) protocols.add(match[1]);
      }
      for (const match of text.matchAll(/@(?:pytest\.)?fixture[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)/g)) {
        fixtures.add(match[1]);
      }
    }
  }
  return { protocols, fixtures };
}

/** The file-reading half of the view, one memoised read per caller file. */
function buildSourceView(
  corpusRoot: string,
  facts: { protocols: Set<string>; fixtures: Set<string> },
): PyResidualSourceView {
  const lines = new Map<string, string[]>();
  const imports = new Map<string, Set<string>>();
  const typeVars = new Map<string, Set<string>>();
  const linesOf = (relPath: string): string[] => {
    const cached = lines.get(relPath);
    if (cached !== undefined) return cached;
    let read: string[];
    try {
      read = readFileSync(join(corpusRoot, relPath), "utf8").split("\n");
    } catch {
      read = [];
    }
    lines.set(relPath, read);
    return read;
  };
  return {
    importBindings: (relPath) => bindingsFor(relPath, imports, linesOf, collectImportBindings),
    typeVarNames: (relPath) => bindingsFor(relPath, typeVars, linesOf, collectTypeVarNames),
    bindingLine: (relPath, line, name) => findBindingLine(linesOf(relPath), line, name),
    enclosingReturnAnnotation: (relPath, line) => findEnclosingReturn(linesOf(relPath), line),
    enclosingDefParams: (relPath, line) => findEnclosingParams(linesOf(relPath), line),
    isProtocolClass: (className) => facts.protocols.has(className),
    isProjectFixture: (name) => facts.fixtures.has(name),
  };
}

function bindingsFor(
  relPath: string,
  cache: Map<string, Set<string>>,
  linesOf: (relPath: string) => string[],
  collect: (source: string[]) => Set<string>,
): ReadonlySet<string> {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;
  const built = collect(linesOf(relPath));
  cache.set(relPath, built);
  return built;
}

/**
 * Names an `import` statement binds, including the parenthesised multi-line
 * `from x import (\n a,\n b,\n)` form polar writes everywhere. `import a.b`
 * binds `a`, `import a.b as c` binds `c`.
 *
 * An `as` clause binds ONE name — the alias — on both statement forms (bd
 * tea-rags-mcp-w205u, E4.6a). The `from` branch used to split its tail on
 * whitespace, which bound the source spelling too:
 * `from polar.subscription.service import subscription as subscription_service`
 * added `subscription`, and 8 polar rows whose receiver is an annotated `def`
 * parameter of that name read as import-bound and landed in
 * `moduleAliasMember`. Their real shape belongs to E4.1's population.
 *
 * A parenthesised statement is accumulated whole rather than scanned line by
 * line, because a clause and its alias can straddle the line break.
 */
export function collectImportBindings(source: readonly string[]): Set<string> {
  const bound = new Set<string>();
  let pending: string | null = null;
  for (const raw of source) {
    const line = raw.trim();
    if (pending !== null) {
      pending += ` ${line}`;
      if (!line.includes(")")) continue;
      addImportClauses(bound, pending);
      pending = null;
      continue;
    }
    const from = /^from\s+[.\w]+\s+import\s+(.*)$/.exec(line);
    if (from !== null) {
      const tail = from[1];
      if (tail.startsWith("(") && !tail.includes(")")) pending = tail;
      else addImportClauses(bound, tail);
      continue;
    }
    const plain = /^import\s+(.*)$/.exec(line);
    if (plain !== null) addImportClauses(bound, plain[1]);
  }
  return bound;
}

/** Every comma-separated clause of one import statement's tail; parens are noise. */
function addImportClauses(bound: Set<string>, tail: string): void {
  for (const clause of tail.replace(/[()]/g, " ").split(",")) addImportClause(bound, clause);
}

/**
 * One clause — `x`, `x.y`, `x as y`. The alias wins when present; otherwise the
 * name's FIRST segment, which is what `import a.b` puts in scope.
 */
function addImportClause(bound: Set<string>, clause: string): void {
  const alias = /\s+as\s+([A-Za-z_]\w*)\s*$/.exec(clause);
  if (alias !== null) {
    bound.add(alias[1]);
    return;
  }
  const head = clause.trim().split(".")[0] ?? "";
  if (/^[A-Za-z_]\w*$/.test(head)) bound.add(head);
}

/** Names bound by a `TypeVar(` call — `T = TypeVar("T")`. */
export function collectTypeVarNames(source: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of source) {
    const match = /^([A-Za-z_]\w*)\s*=\s*TypeVar\(/.exec(line.trim());
    if (match !== null) names.add(match[1]);
  }
  return names;
}

/**
 * The nearest assignment, annotation or annotated parameter of `name` at or
 * above `line` (1-based). Returns the source line so the caller can read the
 * annotation off it; `null` when the backwards scan found nothing, which is
 * what the report's own miss rate counts.
 */
export function findBindingLine(source: readonly string[], line: number, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const own = new RegExp(`^\\s*(?:self\\.)?${escaped}\\s*(?::|=[^=])`);
  const param = new RegExp(`[(,]\\s*${escaped}\\s*:\\s*[^,)=]+`);
  for (let index = Math.min(line, source.length) - 1; index >= 0; index--) {
    const text = source[index] ?? "";
    if (own.test(text)) return text;
    if (param.test(text) && /\bdef\s/.test(text)) return text.slice(text.indexOf(name));
  }
  return null;
}

/** The enclosing `def`'s return annotation at `line`, or `null`. */
export function findEnclosingReturn(source: readonly string[], line: number): string | null {
  for (let index = Math.min(line, source.length) - 1; index >= 0; index--) {
    const text = source[index] ?? "";
    if (!/^\s*(?:async\s+)?def\s/.test(text)) continue;
    const match = /->\s*"?([A-Za-z_][\w.[\]]*)/.exec(text);
    if (match === null) return null;
    const parts = match[1].split(".");
    return parts[parts.length - 1] ?? null;
  }
  return null;
}

/** The enclosing `def`'s parameter names at `line` — the pytest-fixture test. */
export function findEnclosingParams(source: readonly string[], line: number): Set<string> {
  const params = new Set<string>();
  for (let index = Math.min(line, source.length) - 1; index >= 0; index--) {
    const text = source[index] ?? "";
    if (!/^\s*(?:async\s+)?def\s/.test(text)) continue;
    // Params can span lines; read forward from the `def` until the closing paren.
    let depth = 0;
    let joined = "";
    for (let cursor = index; cursor < source.length; cursor++) {
      const part = source[cursor] ?? "";
      joined += part;
      depth += (part.match(/\(/g) ?? []).length - (part.match(/\)/g) ?? []).length;
      if (cursor > index || part.includes("(")) {
        if (depth <= 0) break;
      }
    }
    const inner = joined.slice(joined.indexOf("(") + 1, joined.lastIndexOf(")"));
    for (const raw of inner.split(",")) {
      const match = /^\s*\**([A-Za-z_]\w*)/.exec(raw);
      if (match !== null) params.add(match[1]);
    }
    return params;
  }
  return params;
}

interface FamilyBucket {
  rows: DumpRow[];
  byKind: Map<string, number>;
  bindingMisses: number;
}

/** Is this row part of the residual the attribution runs over? */
function isResidual(row: DumpRow): boolean {
  if (RESIDUAL_VERDICTS.has(row.verdict)) return true;
  return row.verdict === "bothUnresolved" && row.oracleOrigin !== null && IN_PROJECT_ORIGINS.has(row.oracleOrigin);
}

/**
 * The edge-density families, counted over the WHOLE population rather than the
 * residual. E3 measured 2,550 polar SQLAlchemy rows and 223 pydantic rows with
 * 0 `missed`: they are `agreeExternal` / `bothUnresolved` by construction, so
 * their column is `edgesGained` potential and never recall (spec E4.0 D).
 */
function countEdgeDensity(rows: readonly DumpRow[], view: PyResidualSourceView): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (isResidual(row)) continue;
    const { family } = classifyResidualFamily(row, view);
    if (family !== "sqlalchemyRow" && family !== "pydanticRow" && family !== "transparentWrapper") continue;
    const byVerdict = counts.get(family) ?? new Map<string, number>();
    byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
    counts.set(family, byVerdict);
  }
  return counts;
}

function readArg(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const rowsPath = readArg(argv, "--rows");
  const corpusRoot = readArg(argv, "--corpus-root");
  if (rowsPath === undefined || corpusRoot === undefined) {
    throw new Error("usage: --rows <dump.ndjson> --corpus-root <abs path> [--corpus name] [--json out]");
  }
  const corpus = readArg(argv, "--corpus") ?? relative(join(corpusRoot, ".."), corpusRoot);
  const rows: DumpRow[] = readFileSync(rowsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DumpRow);
  const view = buildSourceView(corpusRoot, scanCorpusFacts(corpusRoot));

  const residual = rows.filter(isResidual);
  const bothUnresolvedInProject = residual.filter((row) => row.verdict === "bothUnresolved").length;
  const buckets = new Map<PyResidualFamily, FamilyBucket>();
  for (const row of residual) {
    const { family, bindingFound } = classifyResidualFamily(row, view);
    const bucket = buckets.get(family) ?? { rows: [], byKind: new Map<string, number>(), bindingMisses: 0 };
    bucket.rows.push(row);
    bucket.byKind.set(row.receiverKind, (bucket.byKind.get(row.receiverKind) ?? 0) + 1);
    if (!bindingFound) bucket.bindingMisses++;
    buckets.set(family, bucket);
  }
  const edgeDensity = countEdgeDensity(rows, view);

  const report = {
    corpus,
    sites: rows.length,
    residual: residual.length,
    bothUnresolvedInProject,
    bindingMissRate: residual.length === 0 ? 0 : totalBindingMisses(buckets) / residual.length,
    families: PY_RESIDUAL_FAMILIES.filter((family) => buckets.has(family)).map((family) => {
      const bucket = buckets.get(family) as FamilyBucket;
      return {
        family,
        increment: PY_FAMILY_INCREMENT[family],
        tier: PY_TIER2_FAMILIES.has(family) ? 2 : 1,
        count: bucket.rows.length,
        byKind: Object.fromEntries([...bucket.byKind].sort((a, b) => b[1] - a[1])),
        bindingMisses: bucket.bindingMisses,
        examples: bucket.rows.slice(0, 3).map((row) => ({
          at: `${row.relPath}:${String(row.startLine)}`,
          callText: row.callText.replace(/\s+/g, " ").slice(0, 70),
          answeredBy: row.answeredBy,
          oracleTarget: row.oracleTargetSymbolId,
        })),
      };
    }),
    edgeDensity: Object.fromEntries(
      [...edgeDensity].map(([family, byVerdict]) => [family, Object.fromEntries(byVerdict)]),
    ),
  };
  const jsonOut = readArg(argv, "--json");
  if (jsonOut !== undefined) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  process.stdout.write(formatReport(report));
}

function totalBindingMisses(buckets: ReadonlyMap<PyResidualFamily, FamilyBucket>): number {
  let total = 0;
  for (const bucket of buckets.values()) total += bucket.bindingMisses;
  return total;
}

interface FamilyReport {
  corpus: string;
  sites: number;
  residual: number;
  bothUnresolvedInProject: number;
  bindingMissRate: number;
  families: {
    family: string;
    increment: string;
    tier: number;
    count: number;
    byKind: Record<string, number>;
    bindingMisses: number;
    examples: { at: string; callText: string; answeredBy: string; oracleTarget: string | null }[];
  }[];
  edgeDensity: Record<string, Record<string, number>>;
}

function formatReport(report: FamilyReport): string {
  const lines = [
    `${report.corpus} — ${String(report.sites)} sites, residual ${String(report.residual)}` +
      ` (bothUnresolved-inProject ${String(report.bothUnresolvedInProject)}),` +
      ` binding-line miss ${(report.bindingMissRate * 100).toFixed(1)}%`,
    "",
    "family                 inc    tier  count   share  receiverKind split",
  ];
  for (const family of report.families) {
    const share = report.residual === 0 ? 0 : (family.count / report.residual) * 100;
    const kinds = Object.entries(family.byKind)
      .map(([kind, count]) => `${kind} ${String(count)}`)
      .join(", ");
    lines.push(
      `${family.family.padEnd(22)} ${family.increment.padEnd(6)} ${String(family.tier)}   ` +
        `${String(family.count).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${kinds}`,
    );
    for (const example of family.examples) lines.push(`    ${example.at}  ${example.callText}`);
  }
  lines.push("", "edge-density families (whole population, outside the recall denominator)");
  for (const [family, byVerdict] of Object.entries(report.edgeDensity)) {
    const total = Object.values(byVerdict).reduce((sum, count) => sum + count, 0);
    lines.push(`  ${family.padEnd(20)} ${String(total).padStart(6)}  ${JSON.stringify(byVerdict)}`);
  }
  return `${lines.join("\n")}\n`;
}

// Only when RUN, never when imported — the same entrypoint guard
// `py-codegraph-jedi-oracle.ts` carries, so the source-view collectors below can
// be unit-tested without the CLI's argument contract firing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
