/**
 * cochange-forgotten-change-gate.ts (bd tea-rags-mcp-9szed, epic tea-rags-mcp-l1ot)
 *
 * Settles the go/no-go gate on the temporal-coupling epic with a MEASUREMENT.
 * The question: if a co-change matrix existed, would it have caught the
 * forgotten changes that actually happened in this repository's history?
 *
 * The corpus builds itself out of git. A hotfix that lands within 24h of a
 * prior commit, shares at least one file with it, and touches a file that
 * prior commit did NOT touch, is a documented forgotten change with a known
 * answer: the extra file is what the author should have changed the first
 * time. Nothing is labelled by hand.
 *
 * Retrodiction discipline (the correctness requirement of the whole exercise):
 * the matrix consulted for a case contains ONLY bundles whose LAST commit
 * timestamp is strictly earlier than the anchor commit's timestamp. Bundles are
 * walked in ascending end-timestamp order and a case is evaluated BEFORE the
 * bundle carrying its anchor is folded in, so no pair count can carry
 * information from the anchor's own change or anything after it.
 *
 * PRE-DECLARED PRIMARY VARIANT (fixed before the first run, so the headline
 * number cannot be shopped for):
 *   corpus      commit-level, 24h window, same author, >=1 shared file
 *   matrix      session bundles (author + 30min gap, mirrors squashOpts),
 *               bundles touching more than 15 files dropped
 *   ranking     max confidence over anchor files, support floor 2
 *   headline    per-case top-3 hit rate over the FULL corpus
 * Everything else this script prints is labelled SENSITIVITY and is reported,
 * never substituted for the headline.
 *
 * PRE-DECLARED REFINED VARIANT (COCHANGE_REFINED=1) — the single re-measure the
 * decision rule allows when the primary lands in the 25%..50% band. Same corpus,
 * byte for byte; only the matrix's noise filters move:
 *   +365d recency window   a pair last seen in 2018 is not evidence about 2026
 *   +antecedent floor 3    confidence 1.0 off two co-occurrences is arithmetic
 *   +hub cap 2%            a file everything touches predicts nothing
 *
 * DECISION RULE (bd 9szed, not softened here):
 *   top-3 > 50%   -> demand proven on real data, epic to P1
 *   top-3 < 25%   -> epic closed honestly with the number
 *   25%..50%      -> refine noise filters, re-measure EXACTLY once
 *
 * Read-only. Touches no production code, no index, no DuckDB — two `git log`
 * passes and folds over what they return. Reuses the REAL `isBugFixCommit` /
 * `MERGE_SUBJECT` / `groupIntoSessions` exports rather than re-deriving them,
 * per the forensics-harness convention in
 * `scripts/taxdome-codegraph-recall-forensics.ts`.
 *
 * Usage:
 *   npx tsx scripts/cochange-forgotten-change-gate.ts
 *   COCHANGE_REPO=/path/to/repo COCHANGE_SENSITIVITY=1 npx tsx scripts/...
 *
 * Large histories want headroom: NODE_OPTIONS=--max-old-space-size=8192.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommitInfo } from "../src/core/adapters/vcs/types.js";
import { groupIntoSessions } from "../src/core/domains/trajectory/git/infra/metrics/sessions.js";
import { isBugFixCommit, MERGE_SUBJECT } from "../src/core/domains/trajectory/git/infra/utils.js";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const REPO = process.env.COCHANGE_REPO ?? join(homedir(), "Dev/Job/taxdome");
const OUT_DIR = process.env.COCHANGE_OUT ?? join(homedir(), ".claude/jobs/cochange-gate");
const OUT_REPORT = join(OUT_DIR, "cochange-gate-report.json");

/** Hotfix must land inside this window after the anchor to count as a follow-up. */
const WINDOW_HOURS = Number(process.env.COCHANGE_WINDOW_HOURS ?? 24);
/** Mass refactors poison pairs — bundles wider than this never enter the matrix. */
const MAX_FILES = Number(process.env.COCHANGE_MAX_FILES ?? 15);
/** squashOpts default (`bootstrap/factory.ts`: sessionGapMinutes ?? 30). */
const SESSION_GAP_MIN = Number(process.env.COCHANGE_SESSION_GAP_MIN ?? 30);
/** A pair below this many co-occurrences is noise, not a rule. */
const MIN_SUPPORT = Number(process.env.COCHANGE_MIN_SUPPORT ?? 2);
/** Deepest rank reported; the decision rule reads rank 3. */
const TOP_K = Number(process.env.COCHANGE_TOP_K ?? 5);
/** Anchor and hotfix by the same author (a forgotten change is one person's). */
const SAME_AUTHOR = process.env.COCHANGE_SAME_AUTHOR !== "0";
/** How far back per file to look for a valid anchor before giving up. */
const ANCHOR_LOOKBACK = Number(process.env.COCHANGE_ANCHOR_LOOKBACK ?? 40);
/** Optional history floor, ISO date. Empty = whole history. */
const SINCE = process.env.COCHANGE_SINCE ?? "";
/** Run the labelled sensitivity variants after the primary. */
const SENSITIVITY = process.env.COCHANGE_SENSITIVITY === "1";
/**
 * The ONE re-measure the decision rule allows when the primary lands in the
 * 25%..50% band. Its three filters are pre-declared here, not tuned: a recency
 * window (a pair last seen in 2018 says nothing about 2026 in a nine-year
 * monorepo), an antecedent-occurrence floor (confidence 1.0 off two
 * co-occurrences is arithmetic, not evidence), and a hub cap (a file everything
 * touches predicts nothing).
 */
const REFINED = process.env.COCHANGE_REFINED === "1";
const REFINED_WINDOW_DAYS = Number(process.env.COCHANGE_REFINED_WINDOW_DAYS ?? 365);
const REFINED_ANTECEDENT_FLOOR = Number(process.env.COCHANGE_REFINED_ANTECEDENT_FLOOR ?? 3);
const REFINED_HUB_SHARE = Number(process.env.COCHANGE_REFINED_HUB_SHARE ?? 0.02);
/** Case detail rows kept in the JSON dump. */
const EXAMPLE_CAP = Number(process.env.COCHANGE_EXAMPLE_CAP ?? 400);

const WINDOW_SEC = WINDOW_HOURS * 3600;

const logLines: string[] = [];
const L = (s = ""): void => {
  logLines.push(s);
  console.log(s);
};
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

// ---------------------------------------------------------------------------
// git readers — streamed, so an 80MB name-only log never becomes one JS string
// ---------------------------------------------------------------------------
const RS = "\x1e";
const FS = "\x1f";

async function* gitRecords(args: string[]): AsyncGenerator<string> {
  const child = spawn("git", ["-c", "core.quotePath=false", "log", ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });
  child.stdout.setEncoding("utf8");

  let buf = "";
  for await (const chunk of child.stdout as AsyncIterable<string>) {
    buf += chunk;
    let i = buf.indexOf(RS);
    while (i !== -1) {
      const rec = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (rec.trim().length > 0) yield rec;
      i = buf.indexOf(RS);
    }
  }
  if (buf.trim().length > 0) yield buf;

  const code = await new Promise<number>((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`git log exited ${code}: ${stderr.slice(0, 400)}`);
}

/** Commit record after both passes, files interned to ids, chronological order. */
interface Commit {
  sha: string;
  ts: number;
  author: string;
  subject: string;
  isFix: boolean;
  files: number[];
}

const pathIds = new Map<string, number>();
const pathNames: string[] = [];
const internPath = (p: string): number => {
  const known = pathIds.get(p);
  if (known !== undefined) return known;
  const id = pathNames.length;
  pathNames.push(p);
  pathIds.set(p, id);
  return id;
};

/**
 * Pass 1 — full bodies, no diff. `isBugFixCommit` reads the whole body (the
 * "closes #123" rule), and a body cannot be line-streamed alongside a file
 * list, so fix classification gets its own cheap pass.
 */
async function readFixFlags(): Promise<Map<string, boolean>> {
  const args = [`--format=${FS}%H${FS}%s${FS}%b${RS}`];
  if (SINCE) args.push(`--since=${SINCE}`);
  const flags = new Map<string, boolean>();
  for await (const rec of gitRecords(args)) {
    const parts = rec.split(FS);
    // parts[0] holds the newline left over from the previous record separator
    const sha = parts[1];
    if (!sha) continue;
    const subject = parts[2] ?? "";
    const body = parts.slice(3).join(FS);
    flags.set(sha.trim(), isBugFixCommit(`${subject}\n${body}`));
  }
  return flags;
}

/** Pass 2 — name-only diffs. Merge commits emit no file list and drop out. */
async function readCommits(fixFlags: Map<string, boolean>): Promise<Commit[]> {
  const args = ["--no-renames", "--name-only", `--format=${RS}%H${FS}%ct${FS}%an${FS}%s`];
  if (SINCE) args.push(`--since=${SINCE}`);
  const out: Commit[] = [];
  for await (const rec of gitRecords(args)) {
    const lines = rec.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const [sha, ctRaw, author, ...subjectParts] = lines[0].split(FS);
    const subject = subjectParts.join(FS);
    if (!sha || lines.length === 1) continue; // merge commit or empty tree change
    if (MERGE_SUBJECT.test(subject)) continue;
    const files = Array.from(new Set(lines.slice(1))).map(internPath);
    out.push({
      sha,
      ts: Number(ctRaw),
      author: author ?? "unknown",
      subject,
      isFix: fixFlags.get(sha) ?? false,
      files,
    });
  }
  // git log is newest-first; the whole measurement is chronological.
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---------------------------------------------------------------------------
// session bundling
//
// Mirrors `groupIntoSessions` (author key, gap >= gapMinutes opens a new
// session, merge commits excluded) but keeps the FILE UNION, which the real
// export cannot return — it answers with counts only. Parity against the real
// export is asserted below rather than assumed.
// ---------------------------------------------------------------------------
interface Bundle {
  endTs: number;
  files: number[];
}

function bundleBySession(commits: Commit[], gapMinutes: number): Bundle[] {
  const gapSec = gapMinutes * 60;
  const byAuthor = new Map<string, Commit[]>();
  for (const c of commits) {
    const list = byAuthor.get(c.author);
    if (list) list.push(c);
    else byAuthor.set(c.author, [c]);
  }

  const bundles: Bundle[] = [];
  byAuthor.forEach((authorCommits) => {
    authorCommits.sort((a, b) => a.ts - b.ts);
    let start = 0;
    for (let i = 1; i <= authorCommits.length; i++) {
      const isEnd = i === authorCommits.length;
      const gap = isEnd ? Infinity : authorCommits[i].ts - authorCommits[i - 1].ts;
      if (gap >= gapSec || isEnd) {
        const slice = authorCommits.slice(start, i);
        const files = new Set<number>();
        for (const c of slice) for (const f of c.files) files.add(f);
        bundles.push({ endTs: slice[slice.length - 1].ts, files: Array.from(files) });
        start = i;
      }
    }
  });

  bundles.sort((a, b) => a.endTs - b.endTs);
  return bundles;
}

/** Each commit is its own bundle — the no-squash sensitivity variant. */
function bundlePerCommit(commits: Commit[]): Bundle[] {
  return commits.map((c) => ({ endTs: c.ts, files: c.files }));
}

/** Fidelity: our bundling must produce the same session count as production's. */
function sessionParity(commits: Commit[], gapMinutes: number): { ours: number; real: number } {
  const asCommitInfo: CommitInfo[] = commits.map((c) => ({
    sha: c.sha,
    author: c.author,
    authorEmail: "",
    timestamp: c.ts,
    body: c.subject,
    parents: [],
  }));
  return {
    ours: bundleBySession(commits, gapMinutes).length,
    real: groupIntoSessions(asCommitInfo, gapMinutes).length,
  };
}

// ---------------------------------------------------------------------------
// corpus — hotfix follow-ups with a known forgotten file
// ---------------------------------------------------------------------------
interface Case {
  anchorIdx: number;
  hotfixIdx: number;
  anchorFiles: number[];
  forgotten: number[];
  gapSec: number;
}

function buildCorpus(commits: Commit[]): { cases: Case[]; rejected: Record<string, number> } {
  // Per-file ascending list of commit indices — the anchor search space.
  const occurrences = new Map<number, number[]>();
  for (let i = 0; i < commits.length; i++) {
    for (const f of commits[i].files) {
      const list = occurrences.get(f);
      if (list) list.push(i);
      else occurrences.set(f, [i]);
    }
  }

  const rejected: Record<string, number> = {
    notFix: 0,
    hotfixTooWide: 0,
    noAnchorInWindow: 0,
    noForgottenFile: 0,
  };
  const cases: Case[] = [];

  for (let j = 0; j < commits.length; j++) {
    const b = commits[j];
    if (!b.isFix) {
      rejected.notFix++;
      continue;
    }
    if (b.files.length > MAX_FILES) {
      rejected.hotfixTooWide++;
      continue;
    }

    // Latest prior commit that shares a file, inside the window, not a mass commit.
    let anchorIdx = -1;
    for (const f of b.files) {
      const list = occurrences.get(f);
      if (!list) continue;
      // binary search for the last occurrence strictly before j
      let lo = 0;
      let hi = list.length - 1;
      let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] < j) {
          pos = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      for (let k = pos, steps = 0; k >= 0 && steps < ANCHOR_LOOKBACK; k--, steps++) {
        const i = list[k];
        const a = commits[i];
        if (b.ts - a.ts > WINDOW_SEC) break; // walking backwards — only gets older
        if (a.ts >= b.ts) continue;
        if (a.files.length > MAX_FILES) continue;
        if (SAME_AUTHOR && a.author !== b.author) continue;
        if (i > anchorIdx) anchorIdx = i;
        break; // per file, the newest valid candidate is enough
      }
    }

    if (anchorIdx < 0) {
      rejected.noAnchorInWindow++;
      continue;
    }
    const a = commits[anchorIdx];
    const anchorSet = new Set(a.files);
    const forgotten = b.files.filter((f) => !anchorSet.has(f));
    if (forgotten.length === 0) {
      rejected.noForgottenFile++;
      continue;
    }
    cases.push({
      anchorIdx,
      hotfixIdx: j,
      anchorFiles: a.files,
      forgotten,
      gapSec: b.ts - a.ts,
    });
  }

  return { cases, rejected };
}

// ---------------------------------------------------------------------------
// co-change matrix + association-rule ranking
// ---------------------------------------------------------------------------
interface Rule {
  file: number;
  support: number;
  confidence: number;
  lift: number;
}

class CoChangeMatrix {
  private readonly adjacency = new Map<number, Map<number, number>>();
  private readonly occurrence = new Map<number, number>();
  private bundleCount = 0;
  private readonly maxFiles: number;
  /** Retained window, oldest first. Empty when no recency window is configured. */
  private readonly retained: Bundle[] = [];
  private head = 0;

  constructor(maxFiles: number) {
    this.maxFiles = maxFiles;
  }

  add(bundle: Bundle): void {
    const { files } = bundle;
    if (files.length === 0 || files.length > this.maxFiles) return;
    this.bundleCount++;
    this.retained.push(bundle);
    for (const f of files) this.occurrence.set(f, (this.occurrence.get(f) ?? 0) + 1);
    // Single-file bundles still move the confidence denominator — dropping them
    // would inflate every rule whose antecedent is usually changed alone.
    if (files.length < 2) return;
    for (let i = 0; i < files.length; i++) {
      for (let k = i + 1; k < files.length; k++) {
        this.bump(files[i], files[k], 1);
        this.bump(files[k], files[i], 1);
      }
    }
  }

  /** Drop everything that finished before `cutoffTs` (recency-window filter). */
  evictBefore(cutoffTs: number): void {
    while (this.head < this.retained.length && this.retained[this.head].endTs < cutoffTs) {
      const { files } = this.retained[this.head];
      this.retained[this.head] = { endTs: 0, files: [] }; // release for GC
      this.head++;
      this.bundleCount--;
      for (const f of files) {
        const next = (this.occurrence.get(f) ?? 1) - 1;
        if (next <= 0) this.occurrence.delete(f);
        else this.occurrence.set(f, next);
      }
      if (files.length < 2) continue;
      for (let i = 0; i < files.length; i++) {
        for (let k = i + 1; k < files.length; k++) {
          this.bump(files[i], files[k], -1);
          this.bump(files[k], files[i], -1);
        }
      }
    }
  }

  private bump(a: number, b: number, delta: number): void {
    let row = this.adjacency.get(a);
    if (!row) {
      if (delta < 0) return;
      row = new Map<number, number>();
      this.adjacency.set(a, row);
    }
    const next = (row.get(b) ?? 0) + delta;
    if (next <= 0) {
      row.delete(b);
      if (row.size === 0) this.adjacency.delete(a);
    } else row.set(b, next);
  }

  /**
   * Best rule per candidate partner of `anchorFiles`, ranked by confidence.
   *
   * `antecedentFloor` refuses to trust a confidence computed off a handful of
   * observations (conf 1.0 from two co-occurrences is arithmetic, not evidence).
   * `hubMaxShare` drops files that appear in more than that share of the window's
   * bundles from BOTH sides — a file everything co-changes with predicts nothing.
   */
  rank(anchorFiles: number[], minSupport: number, antecedentFloor: number, hubMaxShare: number): Rule[] {
    const anchorSet = new Set(anchorFiles);
    const hubCap = hubMaxShare > 0 ? hubMaxShare * this.bundleCount : Infinity;
    const best = new Map<number, Rule>();
    for (const f of anchorFiles) {
      const row = this.adjacency.get(f);
      if (!row) continue;
      const fCount = this.occurrence.get(f) ?? 0;
      if (fCount < antecedentFloor || fCount === 0 || fCount > hubCap) continue;
      row.forEach((support, c) => {
        if (support < minSupport || anchorSet.has(c)) return;
        const cCount = this.occurrence.get(c) ?? 1;
        if (cCount > hubCap) return;
        const confidence = support / fCount;
        const lift = this.bundleCount === 0 ? 0 : confidence / (cCount / this.bundleCount);
        const prev = best.get(c);
        if (!prev || confidence > prev.confidence || (confidence === prev.confidence && support > prev.support)) {
          best.set(c, { file: c, support, confidence, lift });
        }
      });
    }
    return Array.from(best.values()).sort(
      (x, y) => y.confidence - x.confidence || y.support - x.support || y.lift - x.lift,
    );
  }

  get bundles(): number {
    return this.bundleCount;
  }

  get pairs(): number {
    let n = 0;
    this.adjacency.forEach((row) => {
      n += row.size;
    });
    return n / 2;
  }
}

// ---------------------------------------------------------------------------
// evaluation — one chronological walk, matrix strictly behind each anchor
// ---------------------------------------------------------------------------
interface CaseResult {
  anchor: string;
  hotfix: string;
  subject: string;
  gapMinutes: number;
  anchorFileCount: number;
  forgottenCount: number;
  candidateCount: number;
  rank: number | null; // best rank of any forgotten file, 1-based
  support: number;
  confidence: number;
  lift: number;
  novel: boolean; // every forgotten file is brand new at hotfix time
  forgottenInTop3: number; // how many of the forgotten files the top-3 covers
  forgottenExample: string;
  topCandidates: string[];
}

interface VariantParams {
  label: string;
  bundling: "session" | "commit";
  minSupport: number;
  maxFiles: number;
  /** Only bundles finishing within this many days before the anchor count. 0 = whole history. */
  windowDays: number;
  /** Minimum occurrences of an anchor file before its confidence is trusted. */
  antecedentFloor: number;
  /** Files in more than this share of window bundles are hubs and are dropped. 0 = off. */
  hubMaxShare: number;
}

interface VariantOutcome {
  params: VariantParams;
  matrixBundles: number;
  matrixPairs: number;
  results: CaseResult[];
  hit1: number;
  hit3: number;
  hitK: number;
  hit3Known: number;
  knownCases: number;
  perFileHit3: number;
  perFileTotal: number;
  emptyCandidateCases: number;
}

function evaluate(
  commits: Commit[],
  cases: Case[],
  params: VariantParams,
  firstSeen: Map<number, number>,
): VariantOutcome {
  const bundles = params.bundling === "session" ? bundleBySession(commits, SESSION_GAP_MIN) : bundlePerCommit(commits);
  const matrix = new CoChangeMatrix(params.maxFiles);

  const ordered = [...cases].sort((x, y) => commits[x.anchorIdx].ts - commits[y.anchorIdx].ts);
  const results: CaseResult[] = [];
  let bp = 0;

  for (const c of ordered) {
    const anchorTs = commits[c.anchorIdx].ts;
    // Fold in everything that provably finished before the anchor. Bundles are
    // sorted by END timestamp, so every commit inside an added bundle is older
    // than the anchor — this is where the no-lookahead guarantee lives.
    while (bp < bundles.length && bundles[bp].endTs < anchorTs) {
      matrix.add(bundles[bp]);
      bp++;
    }
    if (params.windowDays > 0) matrix.evictBefore(anchorTs - params.windowDays * 86400);

    const ranked = matrix.rank(c.anchorFiles, params.minSupport, params.antecedentFloor, params.hubMaxShare);
    const forgottenSet = new Set(c.forgotten);
    let rank: number | null = null;
    let winner: Rule | null = null;
    for (let i = 0; i < ranked.length; i++) {
      if (forgottenSet.has(ranked[i].file)) {
        rank = i + 1;
        winner = ranked[i];
        break;
      }
    }

    const hotfix = commits[c.hotfixIdx];
    const novel = c.forgotten.every((f) => (firstSeen.get(f) ?? Infinity) >= c.hotfixIdx);
    const forgottenInTop3 = ranked.slice(0, 3).filter((r) => forgottenSet.has(r.file)).length;

    results.push({
      anchor: commits[c.anchorIdx].sha.slice(0, 10),
      hotfix: hotfix.sha.slice(0, 10),
      subject: hotfix.subject.slice(0, 90),
      gapMinutes: Math.round(c.gapSec / 60),
      anchorFileCount: c.anchorFiles.length,
      forgottenCount: c.forgotten.length,
      candidateCount: ranked.length,
      rank,
      support: winner?.support ?? 0,
      confidence: winner?.confidence ?? 0,
      lift: winner?.lift ?? 0,
      novel,
      forgottenInTop3,
      forgottenExample: pathNames[c.forgotten[0]],
      topCandidates: ranked.slice(0, 3).map((r) => pathNames[r.file]),
    });
  }

  const n = results.length || 1;
  const hitsAt = (k: number): number => results.filter((r) => r.rank !== null && r.rank <= k).length;
  const known = results.filter((r) => !r.novel);
  const knownHits3 = known.filter((r) => r.rank !== null && r.rank <= 3).length;

  // Per forgotten FILE recall at 3 — a case with four missed files that surfaces
  // one is a partial catch, and the case-level rate hides that.
  let perFileHit = 0;
  let perFileTotal = 0;
  for (let i = 0; i < ordered.length; i++) {
    perFileTotal += ordered[i].forgotten.length;
    perFileHit += results[i].forgottenInTop3;
  }

  return {
    params,
    matrixBundles: matrix.bundles,
    matrixPairs: matrix.pairs,
    results,
    hit1: hitsAt(1) / n,
    hit3: hitsAt(3) / n,
    hitK: hitsAt(TOP_K) / n,
    hit3Known: known.length === 0 ? 0 : knownHits3 / known.length,
    knownCases: known.length,
    perFileHit3: perFileTotal === 0 ? 0 : perFileHit / perFileTotal,
    perFileTotal,
    emptyCandidateCases: results.filter((r) => r.candidateCount === 0).length,
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function quantiles(values: number[]): { p25: number; p50: number; p75: number; mean: number } {
  if (values.length === 0) return { p25: 0, p50: 0, p75: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

function reportVariant(v: VariantOutcome, headline: boolean): void {
  const n = v.results.length;
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L(`  ${headline ? "PRIMARY" : "SENSITIVITY"} — ${v.params.label}`);
  L("═══════════════════════════════════════════════════════════════════");
  L(`bundling: ${v.params.bundling}   minSupport: ${v.params.minSupport}   maxFiles: ${v.params.maxFiles}`);
  L(
    `windowDays: ${v.params.windowDays || "all"}   antecedentFloor: ${v.params.antecedentFloor}   hubMaxShare: ${v.params.hubMaxShare || "off"}`,
  );
  L(`matrix at end of walk:  ${v.matrixBundles} bundles, ${v.matrixPairs} distinct pairs`);
  L(`corpus size:            ${n} forgotten-change cases`);
  L(`  of which novel-only:  ${n - v.knownCases} (every missed file brand new -> unpredictable by construction)`);
  L(`  cases with 0 candidates from the matrix: ${v.emptyCandidateCases}`);
  L("");
  L(`top-1 hit rate:          ${pct(v.hit1)}`);
  L(`top-3 hit rate:          ${pct(v.hit3)}   <-- the decision number`);
  L(`top-${TOP_K} hit rate:          ${pct(v.hitK)}`);
  L(`top-3, known files only: ${pct(v.hit3Known)}  (n=${v.knownCases}) — the achievable ceiling cut`);
  L(`per-file top-3 recall:   ${pct(v.perFileHit3)}  (${v.perFileTotal} forgotten files total)`);

  const hits = v.results.filter((r) => r.rank !== null && r.rank <= 3);
  const misses = v.results.filter((r) => r.rank === null || r.rank > 3);
  const dist = (rows: CaseResult[], label: string): void => {
    const sup = quantiles(rows.map((r) => r.support));
    const conf = quantiles(rows.map((r) => r.confidence));
    const lift = quantiles(rows.map((r) => r.lift));
    L(`  ${label.padEnd(10)} n=${String(rows.length).padStart(5)}`);
    L(
      `    support    p25 ${sup.p25.toFixed(1)}  p50 ${sup.p50.toFixed(1)}  p75 ${sup.p75.toFixed(1)}  mean ${sup.mean.toFixed(2)}`,
    );
    L(
      `    confidence p25 ${conf.p25.toFixed(3)}  p50 ${conf.p50.toFixed(3)}  p75 ${conf.p75.toFixed(3)}  mean ${conf.mean.toFixed(3)}`,
    );
    L(
      `    lift       p25 ${lift.p25.toFixed(1)}  p50 ${lift.p50.toFixed(1)}  p75 ${lift.p75.toFixed(1)}  mean ${lift.mean.toFixed(2)}`,
    );
  };
  L("");
  L("rule statistics of the forgotten file (0 = the ranking never contained it):");
  dist(hits, "HITS");
  dist(misses, "MISSES");

  L("");
  L("rank histogram:");
  const buckets: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-20": 0, ">20": 0, none: 0 };
  for (const r of v.results) {
    if (r.rank === null) buckets.none++;
    else if (r.rank <= 3) buckets[String(r.rank)]++;
    else if (r.rank <= 5) buckets["4-5"]++;
    else if (r.rank <= 20) buckets["6-20"]++;
    else buckets[">20"]++;
  }
  for (const [k, c] of Object.entries(buckets)) {
    L(`    rank ${k.padEnd(5)} ${String(c).padStart(6)}  ${pct(c / (n || 1))}`);
  }

  L("");
  L("sample hits (rank of the forgotten file among the pushed partners):");
  for (const r of hits.slice(0, 8)) {
    L(
      `    #${r.rank} conf=${r.confidence.toFixed(2)} sup=${r.support} lift=${r.lift.toFixed(1)}  ${r.hotfix}  ${r.forgottenExample}`,
    );
  }
  L("sample misses (what the matrix offered instead):");
  for (const r of misses.slice(0, 8)) {
    L(`    missed ${r.forgottenExample}${r.novel ? "  [novel file]" : ""}`);
    L(`      top3: ${r.topCandidates.join(" | ") || "(nothing)"}`);
  }
}

function verdict(hit3: number): string {
  if (hit3 > 0.5) return "P1 — demand proven on real data, promote epic l1ot to P1";
  if (hit3 < 0.25) return "CLOSE — below the 25% floor, close epic l1ot honestly with this number";
  return "RE-MEASURE — between 25% and 50%, refine noise filters and re-measure exactly once";
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const t0 = Date.now();
  L("═══════════════════════════════════════════════════════════════════");
  L("  CO-CHANGE FORGOTTEN-CHANGE GATE (bd tea-rags-mcp-9szed)");
  L("═══════════════════════════════════════════════════════════════════");
  L(`repo:            ${REPO}`);
  L(`window:          ${WINDOW_HOURS}h    maxFiles: ${MAX_FILES}    sessionGap: ${SESSION_GAP_MIN}min`);
  L(`minSupport:      ${MIN_SUPPORT}    sameAuthor: ${SAME_AUTHOR}    since: ${SINCE || "(all history)"}`);
  L("");

  L("pass 1/2 — commit bodies for fix classification...");
  const fixFlags = await readFixFlags();
  L(`  ${fixFlags.size} commits classified, ${Array.from(fixFlags.values()).filter(Boolean).length} bug fixes`);

  L("pass 2/2 — name-only diffs...");
  const commits = await readCommits(fixFlags);
  const touches = commits.reduce((a, c) => a + c.files.length, 0);
  L(
    `  ${commits.length} non-merge commits with a file list, ${pathNames.length} distinct paths, ${touches} file touches`,
  );
  if (commits.length === 0) throw new Error("no commits — wrong repo path?");
  L(
    `  history spans ${new Date(commits[0].ts * 1000).toISOString().slice(0, 10)} .. ${new Date(commits[commits.length - 1].ts * 1000).toISOString().slice(0, 10)}`,
  );

  const parity = sessionParity(commits, SESSION_GAP_MIN);
  L(
    `  session-bundling fidelity vs production groupIntoSessions: ours=${parity.ours} real=${parity.real} ${parity.ours === parity.real ? "(match)" : "(DIVERGENT)"}`,
  );

  // First index at which each path is ever touched — separates "the author
  // forgot an existing file" from "the hotfix created a new file".
  const firstSeen = new Map<number, number>();
  for (let i = 0; i < commits.length; i++) {
    for (const f of commits[i].files) if (!firstSeen.has(f)) firstSeen.set(f, i);
  }

  L("");
  L("building corpus...");
  const { cases, rejected } = buildCorpus(commits);
  L("  candidate hotfixes rejected:");
  for (const [k, n] of Object.entries(rejected)) L(`      ${String(n).padStart(7)}  ${k}`);
  L(`  corpus: ${cases.length} cases`);
  if (cases.length === 0) throw new Error("empty corpus — nothing to measure");
  const gapQ = quantiles(cases.map((c) => c.gapSec / 60));
  L(`  hotfix gap (minutes): p25 ${gapQ.p25.toFixed(0)}  p50 ${gapQ.p50.toFixed(0)}  p75 ${gapQ.p75.toFixed(0)}`);
  const fgQ = quantiles(cases.map((c) => c.forgotten.length));
  L(`  forgotten files per case: p25 ${fgQ.p25}  p50 ${fgQ.p50}  p75 ${fgQ.p75}  mean ${fgQ.mean.toFixed(2)}`);

  const primary: VariantParams = {
    label: "session bundles, support>=2, cap 15 (pre-declared primary)",
    bundling: "session",
    minSupport: MIN_SUPPORT,
    maxFiles: MAX_FILES,
    windowDays: 0,
    antecedentFloor: 0,
    hubMaxShare: 0,
  };
  const refined: VariantParams = {
    label: "REFINED re-measure — 365d recency window + antecedent floor 3 + hub cap 2%",
    bundling: "session",
    minSupport: MIN_SUPPORT,
    maxFiles: MAX_FILES,
    windowDays: REFINED_WINDOW_DAYS,
    antecedentFloor: REFINED_ANTECEDENT_FLOOR,
    hubMaxShare: REFINED_HUB_SHARE,
  };

  const outcomes: VariantOutcome[] = [evaluate(commits, cases, primary, firstSeen)];
  reportVariant(outcomes[0], true);

  let decisive = outcomes[0];
  if (REFINED) {
    // The bead allows the noise filters to be refined and the measurement to be
    // repeated EXACTLY ONCE when the primary lands in the 25%..50% band. This is
    // that one re-measure; the corpus is byte-identical, only the matrix's noise
    // filters move, so the two numbers are directly comparable.
    const o = evaluate(commits, cases, refined, firstSeen);
    outcomes.push(o);
    reportVariant(o, true);
    decisive = o;
  }

  if (SENSITIVITY) {
    const variants: VariantParams[] = [
      { ...primary, label: "per-commit bundles (no squash bundling)", bundling: "commit" },
      { ...primary, label: "support>=1 (noise floor removed)", minSupport: 1 },
      { ...primary, label: "support>=5 (harder floor)", minSupport: 5 },
      { ...primary, label: "recency window 365d ONLY", windowDays: REFINED_WINDOW_DAYS },
      { ...primary, label: "antecedent floor 3 ONLY", antecedentFloor: REFINED_ANTECEDENT_FLOOR },
      { ...primary, label: "hub cap 2% ONLY", hubMaxShare: REFINED_HUB_SHARE },
    ];
    for (const p of variants) {
      const o = evaluate(commits, cases, p, firstSeen);
      outcomes.push(o);
      reportVariant(o, false);
    }
  }

  const head = decisive;
  L("");
  L("═══════════════════════════════════════════════════════════════════");
  L("  VERDICT");
  L("═══════════════════════════════════════════════════════════════════");
  L(
    `corpus ${head.results.length} cases · top-1 ${pct(head.hit1)} · top-3 ${pct(head.hit3)} · top-${TOP_K} ${pct(head.hitK)}`,
  );
  L(verdict(head.hit3));
  L("");
  L(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_REPORT,
    JSON.stringify(
      {
        meta: {
          generatedAt: new Date().toISOString(),
          bead: "tea-rags-mcp-9szed",
          repo: REPO,
          params: {
            windowHours: WINDOW_HOURS,
            maxFiles: MAX_FILES,
            sessionGapMinutes: SESSION_GAP_MIN,
            minSupport: MIN_SUPPORT,
            sameAuthor: SAME_AUTHOR,
            since: SINCE || null,
            topK: TOP_K,
            refinedRun: REFINED,
            refinedWindowDays: REFINED_WINDOW_DAYS,
            refinedAntecedentFloor: REFINED_ANTECEDENT_FLOOR,
            refinedHubShare: REFINED_HUB_SHARE,
          },
          commits: commits.length,
          distinctPaths: pathNames.length,
          historyFrom: new Date(commits[0].ts * 1000).toISOString(),
          historyTo: new Date(commits[commits.length - 1].ts * 1000).toISOString(),
          sessionParity: parity,
          corpusRejections: rejected,
        },
        variants: outcomes.map((o) => ({
          params: o.params,
          matrixBundles: o.matrixBundles,
          matrixPairs: o.matrixPairs,
          corpus: o.results.length,
          hit1: o.hit1,
          hit3: o.hit3,
          hitK: o.hitK,
          hit3KnownFilesOnly: o.hit3Known,
          knownCases: o.knownCases,
          perFileHit3: o.perFileHit3,
          emptyCandidateCases: o.emptyCandidateCases,
          examples: o.results.slice(0, EXAMPLE_CAP),
        })),
        verdict: verdict(head.hit3),
        log: logLines,
      },
      null,
      2,
    ),
  );
  L(`report -> ${OUT_REPORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
