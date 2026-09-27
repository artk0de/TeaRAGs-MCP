#!/usr/bin/env tsx
/**
 * naming-rename-eval.ts (bd tea-rags-mcp-tun7x)
 *
 * Eval of `get_naming_lexicon` type-name judgement whose ground truth is the
 * project's OWN type renames. Every `Old → New` a commit message on the ref
 * names is a name its owner later judged wrong; the harness asks the tool to
 * judge `Old` as a draft at `New`'s path and scores whether it flagged the
 * name, and whether the flag pointed at the name the owner chose. A control of
 * never-renamed types gives the false-flag rate.
 *
 * Two modes:
 *
 *   --extract  Rebuild the fixture `scripts/lib/naming-rename-pairs.json` from
 *              `git log <ref>` + the declarations under `src/` in the working
 *              tree. A pair is kept when both names are PascalCase, NEW is
 *              declared (class|interface|type|enum) in exactly one `src/**.ts`
 *              file, OLD is declared nowhere under `src/`, and the words differ.
 *              Hand-dropped pairs live in the fixture's `dropped` list with a
 *              reason and survive re-extraction. The control is drawn here too
 *              (seeded) and frozen into the fixture.
 *   (default)  Judge the fixture through the REAL tool —
 *              `node build/cli/index.js call get_naming_lexicon` — and print the
 *              report (`--json` for the raw scored rows).
 *
 * Draft placement:
 *   - a rename item is `{name: OLD, kind: "type", path: NEW's path, extends:
 *     NEW's base}` — the file the owner put the concept in, with the base class
 *     it carries, so family / directory role evidence applies exactly as it
 *     would have to the draft. NEW itself is in the index; the eval therefore
 *     measures "given today's vocabulary, would the tool have steered OLD to
 *     NEW", not the tool's verdict at the time OLD was written.
 *   - a control item is judged at its OWN path. A sibling path in the same
 *     directory was the first design (judge the name against the index rather
 *     than against itself), but COLLISION excludes only the draft's own file:
 *     at a sibling path every control collides with its own declaration and
 *     never reaches the role / alternative stages the false-flag rate is about.
 *     At its own path the type contributes one row to its head count and its
 *     directory's role census — a small self-support bias toward CONFORMS.
 *
 * Preconditions:
 *   - a built checkout (`npm run build`) — the tool runs from `build/`;
 *   - a codegraph index of tea-rags with `cg_type_declarations` (collection
 *     `code_8b243ffe`, `CODEGRAPH_ENABLED=true`), and the embedding endpoint the
 *     index was built with (alternatives are gated by embedding similarity);
 *   - `--extract` only: a checkout of the ref (the working tree is scanned for
 *     declarations).
 * Deterministic given the fixture, the index and the embedding model: the
 * control is frozen in the fixture, drafts are sent in fixture order, and the
 * tool is read-only. One trap: when concept search or embedding fails mid-batch
 * the tool does NOT error — it pushes a `type-name alignment skipped` notice and
 * judges the rest of the batch without concept names or any alternative by
 * meaning. The first baseline run hit exactly that (zero head-by-meaning
 * alternatives across 57 drafts, a different table from every later run), so a
 * batch carrying any notice is re-sent and the run aborts if it persists.
 *
 * Usage:
 *   npx tsx scripts/naming-rename-eval.ts --extract [--ref main]
 *   npx tsx scripts/naming-rename-eval.ts [--json] [--collection code_8b243ffe]
 *                                         [--path /Users/artk0re/Dev/Tools/tea-rags-mcp]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  classifyRename,
  deprecatedTerms,
  extractRenamePairs,
  firstDeclarationTimes,
  parseNamingLexiconOutput,
  sampleControlTypes,
  scanTypeDeclarations,
  scoreNamingOutcome,
  tallyScoredItems,
  type EvalNameVerdict,
  type RenameClass,
  type RenamePair,
  type ScoreCounts,
  type ScoredEvalItem,
} from "./lib/naming-rename-eval.js";

const REPO_ROOT = process.cwd();
const FIXTURE_PATH = join(REPO_ROOT, "scripts/lib/naming-rename-pairs.json");
const CLI_PATH = join(REPO_ROOT, "build/cli/index.js");
const CONTROL_SEED = 20260927;
const CONTROL_MIN_AGE_DAYS = 90;
const CONTROL_MIN_SIZE = 40;
const BATCH_SIZE = 25;
const DAY_SECONDS = 86_400;

interface FixturePair extends RenamePair {
  sha: string;
  class: Exclude<RenameClass, "move">;
  newPath: string;
  newExtends?: string;
}

interface FixtureDrop extends RenamePair {
  sha: string;
  reason: string;
}

interface FixtureControl {
  name: string;
  path: string;
  extends?: string;
  firstDeclaredAt: string;
}

interface RenameFixture {
  ref: string;
  refSha: string;
  refTime: string;
  pairs: FixturePair[];
  /** Hand-verified false pairs; the reason is kept across re-extraction. */
  dropped: FixtureDrop[];
  /** Pairs the automatic filter rejected, with the rule that rejected them. */
  rejected: FixtureDrop[];
  control: { seed: number; minAgeDays: number; types: FixtureControl[] };
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 30 });
}

interface DeclarationSite {
  path: string;
  extendsName?: string;
}

/** Every type declared under `src/` (`.ts`, not `.d.ts`), name → the files declaring it. */
function scanSourceDeclarations(): Map<string, DeclarationSite[]> {
  const sites = new Map<string, DeclarationSite[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const path = relative(REPO_ROOT, absolute);
        for (const declaration of scanTypeDeclarations(readFileSync(absolute, "utf8"))) {
          const list = sites.get(declaration.name) ?? [];
          if (!list.some((site) => site.path === path)) {
            list.push({ path, ...(declaration.extendsName ? { extendsName: declaration.extendsName } : {}) });
          }
          sites.set(declaration.name, list);
        }
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return sites;
}

function readFixture(): RenameFixture | undefined {
  return existsSync(FIXTURE_PATH) ? (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RenameFixture) : undefined;
}

function extract(ref: string): void {
  const refSha = git(["rev-parse", ref]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  if (refSha !== headSha) {
    console.error(
      `warning: HEAD ${headSha.slice(0, 9)} != ${ref} ${refSha.slice(0, 9)}; declarations come from the working tree`,
    );
  }
  const refTime = Number(git(["log", "-1", "--format=%ct", ref]).trim());
  const previous = readFixture();
  const manualDrops = new Map((previous?.dropped ?? []).map((drop) => [`${drop.oldName}>${drop.newName}`, drop]));

  const declarations = scanSourceDeclarations();
  const renamedNames = new Set<string>();
  const pairs: FixturePair[] = [];
  const dropped: FixtureDrop[] = [];
  const seen = new Set<string>();
  const rejected: FixtureDrop[] = [];

  // Oldest first: a pair named twice is attributed to the commit that introduced it.
  const log = git(["log", "--reverse", "--format=%x1e%H%n%s%n%b", ref]);
  for (const record of log.split("\u001e")) {
    if (record.trim() === "") continue;
    const sha = record.slice(0, 40);
    for (const pair of extractRenamePairs(record.slice(41))) {
      renamedNames.add(pair.oldName);
      renamedNames.add(pair.newName);
      const key = `${pair.oldName}>${pair.newName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const newSites = declarations.get(pair.newName) ?? [];
      if (newSites.length === 0) {
        rejected.push({ ...pair, sha, reason: "NEW not declared under src/" });
        continue;
      }
      if (newSites.length > 1) {
        rejected.push({ ...pair, sha, reason: "NEW declared in more than one src/ file" });
        continue;
      }
      if (declarations.has(pair.oldName)) {
        rejected.push({ ...pair, sha, reason: "OLD still declared under src/" });
        continue;
      }
      const renameClass = classifyRename(pair.oldName, pair.newName);
      if (renameClass === "move") {
        rejected.push({ ...pair, sha, reason: "same words (move)" });
        continue;
      }
      const manual = manualDrops.get(key);
      if (manual) {
        dropped.push({ ...pair, sha, reason: manual.reason });
        continue;
      }
      const site = newSites[0];
      pairs.push({
        ...pair,
        sha,
        class: renameClass,
        newPath: site.path,
        ...(site.extendsName ? { newExtends: site.extendsName } : {}),
      });
    }
  }

  const firstDeclared = firstDeclarationTimes(git(["log", "--format=%x1e%ct", "-p", "--unified=0", ref, "--", "src"]));
  const cutoff = refTime - CONTROL_MIN_AGE_DAYS * DAY_SECONDS;
  const eligible = [...declarations.entries()]
    .filter(([name, sites]) => {
      const born = firstDeclared.get(name);
      return sites.length === 1 && !renamedNames.has(name) && born !== undefined && born <= cutoff;
    })
    .map(([name]) => name);
  const size = Math.max(CONTROL_MIN_SIZE, 2 * pairs.length);
  const control = sampleControlTypes(eligible, size, CONTROL_SEED).map((name) => {
    const site = (declarations.get(name) as DeclarationSite[])[0];
    return {
      name,
      path: site.path,
      ...(site.extendsName ? { extends: site.extendsName } : {}),
      firstDeclaredAt: new Date((firstDeclared.get(name) as number) * 1000).toISOString().slice(0, 10),
    };
  });

  const fixture: RenameFixture = {
    ref,
    refSha,
    refTime: new Date(refTime * 1000).toISOString(),
    pairs,
    dropped,
    rejected,
    control: { seed: CONTROL_SEED, minAgeDays: CONTROL_MIN_AGE_DAYS, types: control },
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`pairs kept: ${pairs.length}, hand-dropped: ${dropped.length}, auto-rejected: ${rejected.length}`);
  console.log(`control: ${control.length} of ${eligible.length} eligible types`);
  for (const pair of pairs) {
    console.log(
      `  ${pair.sha.slice(0, 9)} ${pair.class.padEnd(10)} ${pair.oldName} -> ${pair.newName}  (${pair.newPath})`,
    );
  }
}

interface DraftRequest {
  name: string;
  kind: "type";
  path: string;
  extends?: string;
}

/** Attempts per batch: a notice (an embedding or search hiccup) voids the batch, so it is re-sent. */
const BATCH_ATTEMPTS = 3;

function judgeBatch(batch: readonly DraftRequest[], collection: string, path: string): EvalNameVerdict[] {
  const request = JSON.stringify({ collection, path, names: batch });
  let lastNotices: string[] = [];
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    const stdout = execFileSync("node", [CLI_PATH, "call", "get_naming_lexicon", request], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      env: { ...process.env, CODEGRAPH_ENABLED: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { names, notices } = parseNamingLexiconOutput(stdout);
    if (notices.length === 0) {
      if (names.length !== batch.length || names.some((verdict, i) => verdict.name !== batch[i]?.name)) {
        throw new Error(`tool answered ${names.length}/${batch.length} drafts`);
      }
      return names;
    }
    lastNotices = notices;
    console.error(`batch attempt ${attempt}/${BATCH_ATTEMPTS} voided by notices: ${JSON.stringify(notices)}`);
  }
  throw new Error(`batch still carries notices after ${BATCH_ATTEMPTS} attempts: ${JSON.stringify(lastNotices)}`);
}

function judge(drafts: readonly DraftRequest[], collection: string, path: string): EvalNameVerdict[] {
  const verdicts: EvalNameVerdict[] = [];
  for (let start = 0; start < drafts.length; start += BATCH_SIZE) {
    verdicts.push(...judgeBatch(drafts.slice(start, start + BATCH_SIZE), collection, path));
  }
  return verdicts;
}

function rate(part: number, total: number): string {
  return total === 0 ? "-" : `${((100 * part) / total).toFixed(1)}%`;
}

function countsRow(group: string, counts: ScoreCounts): string {
  return `| ${group} | ${counts.total} | ${counts.caught} (${rate(counts.caught, counts.total)}) | ${counts["flagged-other"]} | ${counts.silent} (${rate(counts.silent, counts.total)}) |`;
}

function run(): void {
  const fixture = readFixture();
  if (!fixture) throw new Error(`no fixture at ${FIXTURE_PATH}; run --extract first`);
  if (!existsSync(CLI_PATH)) throw new Error(`no ${CLI_PATH}; run npm run build first`);
  const collection = argValue("--collection") ?? "code_8b243ffe";
  const path = argValue("--path") ?? "/Users/artk0re/Dev/Tools/tea-rags-mcp";

  const renameDrafts: DraftRequest[] = fixture.pairs.map((pair) => ({
    name: pair.oldName,
    kind: "type",
    path: pair.newPath,
    ...(pair.newExtends ? { extends: pair.newExtends } : {}),
  }));
  const controlDrafts: DraftRequest[] = fixture.control.types.map((type) => ({
    name: type.name,
    kind: "type",
    path: type.path,
    ...(type.extends ? { extends: type.extends } : {}),
  }));
  const verdicts = judge([...renameDrafts, ...controlDrafts], collection, path);

  const renameRows = fixture.pairs.map((pair, i) => {
    const verdict = verdicts[i];
    return { pair, verdict, scored: { group: pair.class, ...scoreNamingOutcome(verdict, pair) } };
  });
  const controlRows = fixture.control.types.map((type, i) => {
    const verdict = verdicts[renameDrafts.length + i];
    return { type, verdict, scored: { group: "control", ...scoreNamingOutcome(verdict) } };
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ renames: renameRows, control: controlRows }, null, 2));
    return;
  }

  const renameItems: ScoredEvalItem[] = renameRows.map((row) => row.scored);
  const tally = tallyScoredItems(renameItems);
  const all = tallyScoredItems(renameItems.map((item) => ({ ...item, group: "all" })));
  const controlTally = tallyScoredItems(controlRows.map((row) => row.scored));

  console.log(`# naming rename eval — ${fixture.ref} ${fixture.refSha.slice(0, 9)}, ${collection}\n`);
  console.log("## Rename pairs\n");
  console.log("| class | n | caught | flagged-other | silent |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const group of ["head", "qualifier", "both", "role-added"]) {
    const counts = tally.byGroup[group];
    if (counts) console.log(countsRow(group, counts));
  }
  if (all.byGroup.all) console.log(countsRow("**all**", all.byGroup.all));

  console.log("\n### Outcome per class\n");
  const outcomes = ["MISFIT", "COLLISION", "NEW_TERM+alt", "NEW_TERM", "CONFORMS+alt", "CONFORMS"];
  console.log(`| class | ${outcomes.join(" | ")} |`);
  console.log(`| --- | ${outcomes.map(() => "---").join(" | ")} |`);
  for (const group of ["head", "qualifier", "both", "role-added", "control"]) {
    const rows = group === "control" ? controlRows : renameRows.filter((row) => row.scored.group === group);
    if (rows.length === 0) continue;
    const cells = outcomes.map((outcome) => rows.filter((row) => row.scored.outcome === outcome).length);
    console.log(`| ${group} | ${cells.join(" | ")} |`);
  }

  console.log("\n### Mechanism (renames)\n");
  console.log("| mechanism | caught | flagged-other |");
  console.log("| --- | --- | --- |");
  for (const [mechanism, counts] of Object.entries(all.byMechanism).sort()) {
    console.log(`| ${mechanism} | ${counts.caught ?? 0} | ${counts["flagged-other"] ?? 0} |`);
  }

  const { control } = controlTally.byGroup;
  console.log("\n## Control (never renamed, older than 90 days)\n");
  if (control) {
    console.log(
      `false-flag rate: ${control["false-flag"]}/${control.total} (${rate(control["false-flag"], control.total)})\n`,
    );
  }
  console.log("| mechanism | false flags |");
  console.log("| --- | --- |");
  for (const [mechanism, counts] of Object.entries(controlTally.byMechanism).sort()) {
    console.log(`| ${mechanism} | ${counts["false-flag"] ?? 0} |`);
  }
  for (const row of controlRows.filter((r) => r.scored.score === "false-flag")) {
    console.log(`- ${row.type.name} (${dirname(row.type.path)}): ${describeVerdict(row.verdict)}`);
  }

  console.log("\n## Silent misses\n");
  for (const row of renameRows.filter((r) => r.scored.score === "silent")) {
    console.log(`- [${row.pair.class}] ${row.pair.oldName} → ${row.pair.newName}`);
  }
  console.log("\n## Flagged, not toward the new name\n");
  for (const row of renameRows.filter((r) => r.scored.score === "flagged-other")) {
    console.log(`- [${row.pair.class}] ${row.pair.oldName} → ${row.pair.newName}: ${describeVerdict(row.verdict)}`);
  }
  console.log("\n## Caught\n");
  for (const row of renameRows.filter((r) => r.scored.score === "caught")) {
    console.log(`- [${row.pair.class}] ${row.pair.oldName} → ${row.pair.newName}: ${describeVerdict(row.verdict)}`);
  }

  console.log("\n## Deprecated terms (renamed away from)\n");
  console.log("| word | slot | count | replaced by |");
  console.log("| --- | --- | --- | --- |");
  for (const term of deprecatedTerms(fixture.pairs)) {
    const replacedBy = Object.entries(term.replacedBy)
      .map(([word, count]) => `${word}×${count}`)
      .join(", ");
    console.log(`| ${term.word} | ${term.slot} | ${term.count} | ${replacedBy} |`);
  }
}

function describeVerdict(verdict: EvalNameVerdict): string {
  switch (verdict.verdict) {
    case "MISFIT":
      return `MISFIT → ${verdict.suggestion} (role ${verdict.role?.word ?? "?"} by ${verdict.role?.evidence ?? "?"})`;
    case "COLLISION":
      return `COLLISION with ${verdict.existing.relPath}`;
    case "NEW_TERM":
    case "CONFORMS": {
      const alternatives = (verdict.alternatives ?? []).map((alternative) => alternative.word).join(", ");
      return alternatives === "" ? verdict.verdict : `${verdict.verdict} alt [${alternatives}]`;
    }
  }
}

if (process.argv.includes("--extract")) extract(argValue("--ref") ?? "main");
else run();
