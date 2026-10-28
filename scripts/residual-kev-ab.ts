#!/usr/bin/env tsx
/**
 * Labelled A/B of Kev residual questions. Each labelled site is looked up in a
 * codegraph database (READ_ONLY), its question is built with the pass's own
 * code (receiver groups and tournaments, `requestSources`, `kevState`), and
 * the questions of one method are packed into requests under the pass's caps.
 * Variant A asks the default state; B adds the receiver-origin section
 * (`CODEGRAPH_RESIDUAL_ORIGIN_CONTEXT`). Kev is leased from the GPU broker
 * (lease, heartbeat and release are the brokered provider's) and asked with 16
 * requests in flight.
 *
 * Scoring per site: the pick's class against the label's truth — `correct`,
 * `partial` (inside a CORRECT_PARTIAL dispatch set), `wrong`, or `unscorable`
 * (a WRONG label with no stated truth and a new pick). A truth absent from the
 * menu, EXTERNAL and an external WRONG expect "none". Written per variant:
 * `<out>/<variant>.json` + `.md`; `<out>/diff.md` lists the sites whose outcome
 * differs between the variants.
 *
 *   npx tsx scripts/residual-kev-ab.ts --graph-db <cg.duckdb> --project-root <repo> \
 *     --labels a.jsonl,b.jsonl --out <dir> [--variants A,B] [--broker <url>] \
 *     [--concurrency 16] [--menu-limit 40] [--limit N] [--dry-run]
 *
 * `--dry-run` prints each request's state per variant with its estimated
 * token count (characters / 3) and calls nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DuckDbGraphSession } from "../src/core/adapters/duckdb/graph-session.js";
import { DuckDbResidualEdgeStore } from "../src/core/adapters/duckdb/residual-edge-store.js";
import { candidateClass, KEV_PROMPT_TEMPLATE, kevState } from "../src/core/adapters/kev/kev-residual-provider.js";
import type {
  ResidualAnswer,
  ResidualCallSiteRow,
  ResidualQuestion,
  ResidualVerdict,
} from "../src/core/contracts/types/codegraph-residual.js";
import {
  collectReceiverGroups,
  DEFAULT_TOURNAMENT_FLOOR,
  GroupTournament,
} from "../src/core/domains/trajectory/codegraph/residual/receiver-group-tournament.js";
import {
  DEFAULT_MAX_CRITERIA_PER_REQUEST,
  DEFAULT_MAX_QUESTIONS_PER_REQUEST,
  errorCode,
  requestSources,
} from "../src/core/domains/trajectory/codegraph/residual/residual-ask-queue.js";
import { ResidualModelProviderFactory } from "../src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import { estimateStateTokens } from "../src/core/domains/trajectory/codegraph/residual/residual-origin-context.js";
import {
  residualQuestionFold,
  residualQuestionHash,
} from "../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";

/** A raw label row; the files disagree on field names. */
export interface LabelRow {
  id?: string;
  label?: string;
  verdict?: string;
  pick?: string | null;
  target?: string | null;
  truth?: string | null;
  note?: string | null;
  [key: string]: unknown;
}

export interface LabelTruth {
  /** Classes a right answer names; empty when the label states none. */
  classes: string[];
  expectNone: boolean;
  /** The truth is a dispatch set; a pick inside it is partial. */
  partial: boolean;
  /** The class the labelled answer picked, when the label calls it wrong. */
  knownWrong?: string;
}

export type SiteOutcome = "correct" | "partial" | "wrong" | "unscorable";

const CONSTANT = /\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*/gu;

/** Class names a free-text truth mentions; all-caps words (EXTERNAL, API) are not classes. */
function mentionedClasses(text: string): string[] {
  return [...new Set((text.match(CONSTANT) ?? []).filter((c) => !/^[A-Z0-9]+$/u.test(c)))];
}

function classMatches(a: string, b: string): boolean {
  return a === b || a.endsWith(`::${b}`) || b.endsWith(`::${a}`);
}

/** The label's statement of truth: its `truth` field, else the `truth:` clause of its note. */
function truthText(row: LabelRow): string {
  if (typeof row.truth === "string") return row.truth;
  const note = typeof row.note === "string" ? row.note : "";
  const clause = /truth:\s*([^;]*)/iu.exec(note);
  return clause === null ? "" : clause[1];
}

export function labelTruth(row: LabelRow): LabelTruth | undefined {
  const label = row.label ?? row.verdict ?? "";
  if (label === "UNDECIDABLE") return undefined;
  const picked = row.pick ?? row.target ?? null;
  const previous = picked === null ? undefined : candidateClass(picked);
  const text = truthText(row);
  const stated = mentionedClasses(text);
  switch (label) {
    case "EXTERNAL":
    case "WRONG_OFF_MENU":
      return { classes: label === "EXTERNAL" ? [] : stated, expectNone: true, partial: false };
    case "CORRECT":
      return { classes: stated.length > 0 ? stated : previous ? [previous] : [], expectNone: false, partial: false };
    case "CORRECT_PARTIAL":
      return { classes: [...new Set([...stated, ...(previous ? [previous] : [])])], expectNone: false, partial: true };
    case "WRONG": {
      const external = /\bexternal\b/iu.test(text);
      const classes = external ? [] : stated.filter((c) => previous === undefined || !classMatches(c, previous));
      return { classes, expectNone: external, partial: false, ...(previous ? { knownWrong: previous } : {}) };
    }
    default:
      return { classes: stated, expectNone: false, partial: false };
  }
}

/** `pickClass` — the class picked, `null` for none; `menu` — the classes the question offered. */
export function scoreAnswer(
  truth: LabelTruth | undefined,
  pickClass: string | null,
  menu: readonly string[],
): SiteOutcome {
  if (truth === undefined) return "unscorable";
  const onMenu = truth.classes.filter((t) => menu.some((m) => classMatches(m, t)));
  const expectNone = truth.expectNone || (truth.classes.length > 0 && onMenu.length === 0);
  if (pickClass === null) {
    if (expectNone) return "correct";
    return truth.classes.length === 0 ? "unscorable" : "wrong";
  }
  if (expectNone) return "wrong";
  if (onMenu.some((t) => classMatches(pickClass, t))) return truth.partial ? "partial" : "correct";
  if (truth.classes.length > 0) return "wrong";
  return truth.knownWrong !== undefined && classMatches(pickClass, truth.knownWrong) ? "wrong" : "unscorable";
}

export interface ScoredAnswer {
  outcome: SiteOutcome;
  pick: string | null;
  p: number;
}

export interface VariantSummary {
  answered: number;
  scorable: number;
  correct: number;
  partial: number;
  wrong: number;
  /** (correct + partial) / scorable. */
  accuracy: number;
  /** Class answers at p ≥ 0.7, of all class answers. */
  confidentClassShare: number;
  /** None answers at p ≥ 0.8, of all none answers. */
  confidentNoneShare: number;
  meanPCorrect: number;
  meanPWrong: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const share = (hits: number, of: number): number => (of === 0 ? 0 : hits / of);

export function summarize(answers: readonly ScoredAnswer[]): VariantSummary {
  const count = (o: SiteOutcome) => answers.filter((a) => a.outcome === o).length;
  const right = answers.filter((a) => a.outcome === "correct" || a.outcome === "partial");
  const classes = answers.filter((a) => a.pick !== null);
  const nones = answers.filter((a) => a.pick === null);
  const scorable = answers.length - count("unscorable");
  return {
    answered: answers.length,
    scorable,
    correct: count("correct"),
    partial: count("partial"),
    wrong: count("wrong"),
    accuracy: share(right.length, scorable),
    confidentClassShare: share(classes.filter((a) => a.p >= 0.7).length, classes.length),
    confidentNoneShare: share(nones.filter((a) => a.p >= 0.8).length, nones.length),
    meanPCorrect: mean(right.map((a) => a.p)),
    meanPWrong: mean(answers.filter((a) => a.outcome === "wrong").map((a) => a.p)),
  };
}

// ---------------------------------------------------------------- live part

type Variant = "A" | "B";

interface LabelledSite {
  id: string;
  source: string;
  row: LabelRow;
  truth: LabelTruth | undefined;
  site: ResidualCallSiteRow;
  question: ResidualQuestion;
  /** Menu as classes. */
  menu: string[];
}

interface AbRequest {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  lines: number[];
  questions: ResidualQuestion[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function readLabels(paths: readonly string[]): { source: string; row: LabelRow }[] {
  return paths.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ source: path, row: JSON.parse(line) as LabelRow })),
  );
}

const noneVerdict = (q: ResidualQuestion): ResidualVerdict => ({
  siteKey: q.siteKey,
  menuHash: q.menuHash,
  model: "kev",
  modelVersion: "ab",
  pick: null,
  p: 0,
  probabilities: {},
  questionPayload: "",
  createdAt: 0,
  lastSeenAt: 0,
});

/** The group's first-round question holding a wanted class; past a name-prior block 1 when that block lacks it. */
function groupQuestion(
  tournament: GroupTournament,
  wanted: readonly string[],
  accept: number,
): ResidualQuestion | undefined {
  const holding = (qs: ResidualQuestion[]) =>
    qs.find((q) => q.candidates.some((c) => wanted.some((w) => classMatches(c, w))));
  const first = tournament.questions();
  const hit = holding(first);
  if (hit !== undefined || !tournament.hasNamePrior) return hit ?? first[0];
  tournament.advance(noneVerdict, DEFAULT_TOURNAMENT_FLOOR, accept);
  return holding(tournament.questions()) ?? first[0];
}

function buildSites(
  labels: { source: string; row: LabelRow }[],
  rows: ResidualCallSiteRow[],
  fold: string,
  menuLimit: number,
): { sites: LabelledSite[]; missing: string[] } {
  const hash = (menuHash: string) => residualQuestionHash(menuHash, fold);
  const { groups } = collectReceiverGroups(rows);
  const groupOf = new Map<string, (typeof groups)[number]>();
  for (const g of groups) for (const r of g.rows) groupOf.set(`${r.sourceRelPath}\u0000${r.siteKey}`, g);
  const byKey = new Map(rows.map((r) => [`${r.sourceRelPath}\u0000${r.siteKey}`, r]));
  const sites: LabelledSite[] = [];
  const missing: string[] = [];
  for (const [index, { source, row }] of labels.entries()) {
    const id = `${source.split("/").slice(-2).join("/")}#${str(row.id) ?? index}`;
    const file = str(row.source_rel_path) ?? str(row.file) ?? "";
    const site = byKey.get(`${file}\u0000${str(row.site_key) ?? ""}`);
    if (site === undefined) {
      missing.push(id);
      continue;
    }
    const truth = labelTruth(row);
    const picked = row.pick ?? row.target ?? null;
    const wanted = [...(truth?.classes ?? []), ...(picked === null ? [] : [candidateClass(picked)])];
    const group = groupOf.get(`${site.sourceRelPath}\u0000${site.siteKey}`);
    const question =
      group === undefined
        ? {
            siteKey: site.siteKey,
            menuHash: hash(site.menuHash),
            receiverText: site.receiverText,
            member: site.member,
            kind: site.kind,
            candidates: site.candidates,
          }
        : groupQuestion(new GroupTournament(group, menuLimit, hash), wanted, 0.7);
    if (question === undefined) {
      missing.push(id);
      continue;
    }
    const menu = question.subject === "class" ? question.candidates : question.candidates.map(candidateClass);
    sites.push({ id, source, row, truth, site, question, menu });
  }
  return { sites, missing };
}

/** One method's distinct questions, chunked under the pass's per-request caps. */
function packRequests(sites: readonly LabelledSite[]): AbRequest[] {
  const byMethod = new Map<string, LabelledSite[]>();
  for (const s of sites) {
    const key = `${s.site.sourceRelPath}\u0000${s.site.methodSymbolId}`;
    byMethod.set(key, [...(byMethod.get(key) ?? []), s]);
  }
  const requests: AbRequest[] = [];
  for (const members of byMethod.values()) {
    const [{ site }] = members;
    const seen = new Set<string>();
    let current: AbRequest | undefined;
    let criteria = 0;
    for (const s of members) {
      if (seen.has(s.question.siteKey)) continue;
      seen.add(s.question.siteKey);
      const size = s.question.candidates.length;
      if (
        current === undefined ||
        current.questions.length >= DEFAULT_MAX_QUESTIONS_PER_REQUEST ||
        criteria + size > DEFAULT_MAX_CRITERIA_PER_REQUEST
      ) {
        current = { ...site, lines: [], questions: [] };
        criteria = 0;
        requests.push(current);
      }
      current.questions.push(s.question);
      current.lines.push(s.site.line);
      criteria += size;
    }
    for (const r of requests) r.lines.sort((a, b) => a - b);
  }
  return requests;
}

function fileReader(projectRoot: string): (relPath: string) => string {
  const cache = new Map<string, string>();
  return (relPath) => {
    let text = cache.get(relPath);
    if (text === undefined) {
      text = readFileSync(join(projectRoot, relPath), "utf8");
      cache.set(relPath, text);
    }
    return text;
  };
}

function sources(request: AbRequest, variant: Variant, readFile: (relPath: string) => string) {
  const fileText = readFile(request.sourceRelPath);
  const methodSource = fileText
    .split("\n")
    .slice(request.methodStartLine - 1, request.methodEndLine)
    .join("\n");
  return requestSources(request, methodSource, variant === "B" ? fileText : undefined);
}

async function pool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

function renderSummary(variant: Variant, s: VariantSummary, missing: number, failed: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `# Residual Kev A/B — variant ${variant}${variant === "B" ? " (receiver-origin context)" : ""}`,
    "",
    "| metric | value |",
    "|---|---|",
    `| answered | ${s.answered} |`,
    `| scorable | ${s.scorable} |`,
    `| correct / partial / wrong | ${s.correct} / ${s.partial} / ${s.wrong} |`,
    `| accuracy (correct+partial)/scorable | ${pct(s.accuracy)} |`,
    `| class answers p ≥ 0.7 | ${pct(s.confidentClassShare)} |`,
    `| none answers p ≥ 0.8 | ${pct(s.confidentNoneShare)} |`,
    `| mean p correct / wrong | ${s.meanPCorrect.toFixed(3)} / ${s.meanPWrong.toFixed(3)} |`,
    `| labels not found in the graph | ${missing} |`,
    `| requests failed | ${failed} |`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "graph-db": { type: "string" },
      "project-root": { type: "string" },
      labels: { type: "string" },
      out: { type: "string", default: "residual-kev-ab" },
      variants: { type: "string", default: "A,B" },
      broker: { type: "string", default: "http://192.168.1.71:8008" },
      concurrency: { type: "string", default: "16" },
      "menu-limit": { type: "string", default: "40" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const graphDb = values["graph-db"];
  const projectRoot = values["project-root"];
  if (graphDb === undefined || projectRoot === undefined || values.labels === undefined) {
    throw new Error("--graph-db, --project-root and --labels are required");
  }
  const variants = values.variants.split(",").map((v) => v.trim()) as Variant[];
  const menuLimit = Number(values["menu-limit"]);
  let labels = readLabels(values.labels.split(","));
  if (values.limit !== undefined) labels = labels.slice(0, Number(values.limit));

  const session = new DuckDbGraphSession({ path: graphDb, accessMode: "READ_ONLY" });
  await session.open();
  // READ_ONLY: the store only reads residual sites here and never applies model
  // edges, so the index rebuild + checkpoint it would run after a sync are unreachable.
  const readOnlyMaintenance = {
    rebuildEdgeFileTargetIndex: async () => Promise.resolve(),
    checkpoint: async () => Promise.resolve(),
  };
  const rows = await new DuckDbResidualEdgeStore(session, readOnlyMaintenance)
    .readResidualCallSites()
    .finally(async () => session.close());
  const readFile = fileReader(projectRoot);
  const provider = ResidualModelProviderFactory.create("kev", { kevSessionUrl: values.broker, kevThreshold: 0.7 });
  mkdirSync(values.out, { recursive: true });
  const scored = new Map<Variant, Map<string, ScoredAnswer>>();

  for (const variant of variants) {
    const fold = residualQuestionFold({ promptTemplate: KEV_PROMPT_TEMPLATE, originContext: variant === "B" });
    const { sites, missing } = buildSites(labels, rows, fold, menuLimit);
    const requests = packRequests(sites);
    console.error(
      `[${variant}] ${sites.length} labelled sites, ${missing.length} missing, ${requests.length} requests`,
    );
    if (values["dry-run"]) {
      for (const request of requests) {
        const { whole, windowed } = sources(request, variant, readFile);
        const state = kevState(request.sourceRelPath, whole);
        console.log(`===== [${variant}] ${request.methodSymbolId} — ~${estimateStateTokens(state)} tokens`);
        if (windowed !== undefined) {
          console.log(`(window fallback ~${estimateStateTokens(kevState(request.sourceRelPath, windowed))} tokens)`);
        }
        console.log(state);
        for (const q of request.questions) console.log(`  ? ${q.receiverText} .${q.member} [${q.candidates.length}]`);
      }
      continue;
    }
    const answers = new Map<string, ResidualAnswer>();
    let failed = 0;
    const lease = await provider.acquire?.();
    try {
      await pool(requests, Number(values.concurrency), async (request) => {
        const { whole, windowed } = sources(request, variant, readFile);
        const group = { ...request, methodSource: whole };
        try {
          let got: ResidualAnswer[];
          try {
            got = await provider.resolveGroup(group);
          } catch (error) {
            if (errorCode(error) !== "INFRA_KEV_STATE_TOO_LONG" || windowed === undefined) throw error;
            got = await provider.resolveGroup({ ...group, methodSource: windowed });
          }
          for (const a of got) answers.set(a.siteKey, a);
        } catch (error) {
          failed++;
          console.error(
            `[${variant}] ${request.methodSymbolId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } finally {
      await lease?.release();
    }
    const perSite = new Map<string, ScoredAnswer>();
    const rowsOut = [];
    for (const s of sites) {
      const answer = answers.get(s.question.siteKey);
      if (answer === undefined) continue;
      const pick =
        answer.pick === null ? null : s.question.subject === "class" ? answer.pick : candidateClass(answer.pick);
      const result: ScoredAnswer = { outcome: scoreAnswer(s.truth, pick, s.menu), pick, p: answer.p };
      perSite.set(s.id, result);
      rowsOut.push({ id: s.id, receiver: s.question.receiverText, menu: s.menu.length, label: s.row.label, ...result });
    }
    scored.set(variant, perSite);
    const summary = summarize([...perSite.values()]);
    writeFileSync(join(values.out, `${variant}.json`), JSON.stringify({ variant, summary, sites: rowsOut }, null, 2));
    writeFileSync(join(values.out, `${variant}.md`), renderSummary(variant, summary, missing.length, failed));
    console.error(renderSummary(variant, summary, missing.length, failed));
  }

  const [a, b] = [scored.get("A"), scored.get("B")];
  if (a !== undefined && b !== undefined) {
    const lines = ["# Per-site diff A → B", "", "| site | A | B |", "|---|---|---|"];
    for (const [id, x] of a) {
      const y = b.get(id);
      if (y === undefined || (x.outcome === y.outcome && x.pick === y.pick)) continue;
      const cell = (v: ScoredAnswer) => `${v.outcome} ${v.pick ?? "none"} @${v.p.toFixed(3)}`;
      lines.push(`| ${id} | ${cell(x)} | ${cell(y)} |`);
    }
    writeFileSync(join(values.out, "diff.md"), `${lines.join("\n")}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
