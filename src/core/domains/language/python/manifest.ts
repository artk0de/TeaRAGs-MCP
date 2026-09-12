/**
 * Python dependency-manifest reader (bd tea-rags-mcp-w205u.1) — the Python half
 * of the gate Ruby's `gemfile.ts` is for Ruby: which distributions does this
 * project DECLARE, so a framework vocabulary loads only where the framework is.
 *
 * Two formats, because Python has two. `pyproject.toml` carries the modern
 * declaration in four places (`[project].dependencies`, every group under
 * `[project.optional-dependencies]`, `[tool.poetry.dependencies]` and every
 * `[tool.poetry.group.*.dependencies]`); `requirements*.txt` carries the older
 * one, one PEP 508 requirement per line. Both are read for the NAME only —
 * version specifiers, extras and environment markers say nothing about whether
 * a vocabulary applies.
 *
 * Deliberately NOT a TOML parser. It is a line scanner that knows where
 * dependencies live and declines everywhere else, and that restraint is the
 * point: netbox's `[project]` table declares `dynamic = ["dependencies"]` and
 * lists `"Framework :: Django"` among its trove `classifiers`, so a reader that
 * scanned the table rather than the four keys would activate Django's vocabulary
 * off metadata instead of off a dependency. A lock file is refused for the same
 * reason the Gemfile is preferred over Gemfile.lock: the lock is the resolved
 * transitive world, where a framework pulled in by something else would activate
 * grammar the project's own code never uses.
 *
 * Pure. The WALK that finds these files is `infra/dependency-manifests.ts` —
 * `domains/language` touches no filesystem.
 */

import type { DependencyManifestSource } from "../../../contracts/types/language.js";

/** Poetry spells the interpreter constraint as a dependency; it is not one. */
const POETRY_INTERPRETER_KEY = "python";

const TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*$/;
const KEY_ASSIGN = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/;
const LEADING_NAME = /^[A-Za-z0-9._-]+/;

/**
 * PEP 503 normalization: `re.sub(r"[-_.]+", "-", name).lower()`. Two spellings
 * of one distribution (`django_filter`, `Django-Filter`) must answer the same
 * membership question, and an activation family is matched EXACTLY against this
 * form — `django-filter` is a different distribution from `django`, not a
 * prefix of it.
 */
export function normalizePythonPackageName(name: string): string {
  return name
    .trim()
    .replace(/[-_.]+/g, "-")
    .toLowerCase();
}

/** Drop a `#` comment, respecting quotes so a `#` inside a string survives. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * The quoted strings on one line plus its net bracket depth, counting brackets
 * OUTSIDE strings only — `"psycopg[binary]"` is one array item, not a nested
 * array, and a scanner that counted its brackets would never see the array close.
 */
function scanTomlLine(line: string): { strings: string[]; delta: number } {
  const strings: string[] = [];
  let delta = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      if (end === -1) break;
      strings.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === "[") delta += 1;
    else if (ch === "]") delta -= 1;
    i += 1;
  }
  return { strings, delta };
}

/** `[tool.poetry.dependencies]` / `[tool.poetry.group.<g>.dependencies]`, where
 *  every KEY is a distribution name rather than every value. */
function isPoetryDependencyTable(table: string): boolean {
  return table === "tool.poetry.dependencies" || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table);
}

/** A key whose array value holds PEP 508 requirement strings. */
function isRequirementArrayKey(table: string, key: string): boolean {
  if (table === "project") return key === "dependencies";
  return table === "project.optional-dependencies";
}

/**
 * The distribution name a PEP 508 requirement opens with, or `undefined` for a
 * line that names none — a comment, a blank, or an option line (`-r base.txt`,
 * `-e .`, `--index-url …`), which points at other requirements rather than
 * declaring one.
 */
function requirementName(spec: string): string | undefined {
  let rest = spec.trim();
  if (rest === "" || rest.startsWith("#") || rest.startsWith("-")) return undefined;
  for (const cut of [";", "@", "["]) {
    const at = rest.indexOf(cut);
    if (at !== -1) rest = rest.slice(0, at);
  }
  const name = LEADING_NAME.exec(rest.trim());
  return name?.[0];
}

function parsePyproject(content: string): string[] {
  const names: string[] = [];
  let table = "";
  let openArray = false;
  let depth = 0;

  for (const raw of content.split(/\r?\n/)) {
    const line = stripTomlComment(raw);
    if (openArray) {
      const scan = scanTomlLine(line);
      for (const item of scan.strings) names.push(item);
      depth += scan.delta;
      if (depth <= 0) {
        openArray = false;
        depth = 0;
      }
      continue;
    }
    const header = TABLE_HEADER.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const assign = KEY_ASSIGN.exec(line);
    if (!assign) continue;
    const key = assign[1] ?? assign[2] ?? assign[3] ?? "";
    if (isPoetryDependencyTable(table)) {
      if (key !== POETRY_INTERPRETER_KEY) names.push(key);
      continue;
    }
    if (!isRequirementArrayKey(table, key)) continue;
    const value = assign[4] ?? "";
    if (!value.trimStart().startsWith("[")) continue;
    const scan = scanTomlLine(value);
    for (const item of scan.strings) names.push(item);
    if (scan.delta > 0) {
      openArray = true;
      depth = scan.delta;
    }
  }
  return names;
}

function parseRequirements(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const name = requirementName(raw.split("#")[0] ?? "");
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * The distributions one manifest declares, PEP 503 normalized and deduplicated
 * in first-seen order. Never throws: a manifest that is not valid TOML, or not
 * the format its name suggests, simply declares nothing — a project must not
 * fail to index because a stray `requirements.txt` holds prose.
 */
export function parsePythonManifest(fileName: string, content: string): string[] {
  const raw = fileName === "pyproject.toml" ? parsePyproject(content) : parseRequirements(content);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    const normalized = normalizePythonPackageName(fileName === "pyproject.toml" ? (requirementName(name) ?? "") : name);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Python's contribution to the manifest walk: which file names declare
 * dependencies, and how to read one. `requirements*.txt` covers the whole
 * suffixed family (`requirements-dev.txt`, `requirements_test.txt`) because a
 * project splits its declarations across them freely and the gate wants the
 * union.
 */
export const PYTHON_DEPENDENCY_MANIFEST: DependencyManifestSource = {
  matchesManifestFile: (fileName) =>
    fileName === "pyproject.toml" || (fileName.startsWith("requirements") && fileName.endsWith(".txt")),
  parseDeclaredDependencies: (fileName, content) => parsePythonManifest(fileName, content),
};
