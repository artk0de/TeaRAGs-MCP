#!/usr/bin/env python3
"""Generate the risk-assessment actionable-report eval suite (cases, fixtures, grading).

The synthetic repo is a scripted git history: each commit writes whole-file
versions. The final versions are fixture.files. Canned rank_chunks rows take
startLine/endLine from the final files, so `git log -L` over them hits the
scripted commits. Commit SHAs are deterministic (fixed author/committer/dates)
and are recomputed by the grader from the run's own workspace.
"""
import json, re, subprocess, tempfile, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
OUT = ROOT / ".claude-plugin/.benchmarks/risk-assessment/evals/2026-11-02-actionable-report.json"

# ---------------------------------------------------------------- sources
def invoice(v):
    """InvoiceCalculator versions 1..6."""
    rate_expr = "this.taxes.rateFor(region, line.sku)" if v >= 3 else "this.taxes.rateFor(region)"
    body = ["  computeTotal(lines: InvoiceLine[], region: string): number {", "    let total = 0;"]
    if v < 2:
        body += [f"    const rate = this.taxes.rateFor(region);", "    for (const line of lines) {",
                 "      total += line.quantity * line.unitPrice;", "    }",
                 "    return Math.round(total * (1 + rate) * 100) / 100;", "  }"]
    else:
        body += ["    for (const line of lines) {"]
        if v >= 4:
            body += ["      if (line.quantity === 0) {", "        continue;", "      }"]
        body += [f"      const rate = {rate_expr};", "      let amount = line.quantity * line.unitPrice;"]
        if v >= 5:
            body += ["      if (line.kind === 'credit') {", "        amount = -amount;",
                     "      } else if (amount < 0) {", "        throw new Error('negative charge');", "      }"]
        comment = "invoice" if v >= 6 else "invocie"
        body += [f"      // round per line, not per {comment}",
                 "      amount = Math.round(amount * (1 + rate) * 100) / 100;", "      total += amount;", "    }",
                 "    return total;", "  }"]
    kind = ["  kind: 'charge' | 'credit';"] if v >= 5 else []
    lines = ["import { TaxTable } from './TaxTable';", "", "export interface InvoiceLine {", "  sku: string;",
             "  quantity: number;", "  unitPrice: number;", *kind, "}", "", "export class InvoiceCalculator {",
             "  constructor(private readonly taxes: TaxTable) {}", "", *body, "",
             "  applyDiscount(total: number, percent: number): number {",
             "    // discount is capped at 50 percent",
             "    return total - (total * Math.min(percent, 50)) / 100;", "  }", "}", ""]
    return "\n".join(lines)


def retry(v):
    """RetryQueue versions 1..6."""
    ctor = ("  constructor(private readonly gateway: Gateway, private readonly batchSize = 10) {}" if v >= 6
            else "  constructor(private readonly gateway: Gateway) {}")
    size = "this.batchSize" if v >= 6 else "10"
    sent0 = "    let sent = 0;" if v >= 4 else "    let sent=0;"
    err = "error" if v >= 5 else "err"
    delay = ("        const delay = Math.min(2 ** job.attempts * 100, 60000);" if v >= 3
             else "        const delay = 2 ** job.attempts * 100;")
    timeout = ([f"        if ({err} instanceof TimeoutError) {{", "          this.seen.delete(job.id);", "        }"]
               if v >= 2 else [])
    lines = ["import { Gateway, TimeoutError } from './Gateway';", "",
             "export interface RetryJob {", "  id: string;", "  attempts: number;", "  payload: unknown;", "}", "",
             "export class RetryQueue {", "  private jobs: RetryJob[] = [];", "  private seen = new Set<string>();", "",
             ctor, "", "  enqueue(job: RetryJob): void {", "    if (this.seen.has(job.id)) {", "      return;", "    }",
             "    this.seen.add(job.id);", "    this.jobs.push(job);", "  }", "",
             "  async processBatch(): Promise<number> {", f"    const batch = this.jobs.splice(0, {size});", sent0,
             "    for (const job of batch) {", "      try {", "        await this.gateway.charge(job.payload);",
             "        sent++;", f"      }} catch ({err}) {{", *timeout, delay, "        job.attempts++;",
             "        setTimeout(() => this.enqueue(job), delay);", "      }", "    }", "    return sent;", "  }", "}", ""]
    return "\n".join(lines)


def ledger(v):
    """LedgerSync versions 1..3."""
    p, m = ("page", "matched") if v >= 3 else ("p", "n")
    if v == 1:
        loop = [f"    let entries = await this.client.fetchPage(accountId, {p});",
                "    while (entries.hasMore) {", "      for (const entry of entries.items) {",
                f"        if (entry.status === 'settled') {m}++;", "      }", f"      {p}++;",
                f"      entries = await this.client.fetchPage(accountId, {p});", "    }"]
    else:
        loop = ["    while (true) {", f"      const entries = await this.client.fetchPage(accountId, {p});",
                "      for (const entry of entries.items) {", f"        if (entry.status === 'settled') {m}++;",
                "      }", "      if (!entries.hasMore) break;", f"      {p}++;", "    }"]
    lines = ["import { LedgerClient } from './LedgerClient';", "", "export class LedgerSync {",
             "  constructor(private readonly client: LedgerClient) {}", "",
             "  async reconcile(accountId: string): Promise<number> {", f"    let {p} = 0;", f"    let {m} = 0;", *loop,
             f"    return {m};", "  }", "}", ""]
    return "\n".join(lines)


def fmt(v):
    yen = ["  if (currency === 'JPY') {", "    return `${Math.round(amount)} JPY`;", "  }"] if v >= 2 else []
    return "\n".join(["export function formatCurrency(amount: number, currency: string): string {", *yen,
                      "  return `${amount.toFixed(2)} ${currency}`;", "}", ""])


TAX = "\n".join(["export class TaxTable {", "  constructor(private readonly rates: Record<string, number>) {}", "",
                 "  rateFor(region: string, sku?: string): number {", "    const key = sku ? `${region}:${sku}` : region;",
                 "    return this.rates[key] ?? this.rates[region] ?? 0;", "  }", "}", ""])
GATEWAY = "\n".join(["export class TimeoutError extends Error {}", "", "export class Gateway {",
                     "  constructor(private readonly endpoint: string) {}", "",
                     "  async charge(payload: unknown): Promise<void> {",
                     "    const res = await fetch(this.endpoint, { method: 'POST', body: JSON.stringify(payload) });",
                     "    if (res.status === 504) {", "      throw new TimeoutError('gateway timeout');", "    }", "  }",
                     "}", ""])
CLIENT = "\n".join(["export interface LedgerPage {", "  items: { status: string }[];", "  hasMore: boolean;", "}", "",
                    "export class LedgerClient {", "  async fetchPage(accountId: string, page: number): Promise<LedgerPage> {",
                    "    const res = await fetch(`/ledger/${accountId}?page=${page}`);",
                    "    return (await res.json()) as LedgerPage;", "  }", "}", ""])
RETRY_TEST = "\n".join(["import { RetryQueue } from '../../src/payments/RetryQueue';", "",
                        "describe('RetryQueue', () => {", "  it('processBatch sends queued jobs', async () => {",
                        "    const gateway = { charge: async () => undefined } as any;",
                        "    const queue = new RetryQueue(gateway);",
                        "    queue.enqueue({ id: 'a', attempts: 0, payload: {} });",
                        "    expect(await queue.processBatch()).toBe(1);", "  });", "});", ""])
README = "# widgets\n\nBilling, payments and ledger sync services.\n"

ALICE, BOB, DANA = ("Alice Moreau", "alice@acme.test"), ("Bob Tanaka", "bob@acme.test"), ("Dana Okafor", "dana@acme.test")
IC, RQ, LS = "src/billing/InvoiceCalculator.ts", "src/payments/RetryQueue.ts", "src/sync/LedgerSync.ts"
HISTORY = [
    ("2026-02-03", ALICE, "chore: initial project skeleton", {"README.md": README, "src/billing/TaxTable.ts": TAX,
                                                               "src/payments/Gateway.ts": GATEWAY, "src/util/format.ts": fmt(1)}),
    ("2026-02-10", ALICE, "feat(billing): add invoice calculator", {IC: invoice(1)}),
    ("2026-02-17", BOB, "feat(payments): add retry queue", {RQ: retry(1)}),
    ("2026-03-02", DANA, "feat(sync): ledger reconciliation", {"src/sync/LedgerClient.ts": CLIENT, LS: ledger(1)}),
    ("2026-03-15", ALICE, "fix(billing): round totals per line, not per invoice", {IC: invoice(2)}),
    ("2026-04-01", BOB, "fix(payments): drop duplicate retries after gateway timeout", {RQ: retry(2)}),
    ("2026-04-20", ALICE, "refactor(billing): look up tax rate per sku", {IC: invoice(3)}),
    ("2026-05-04", DANA, "hotfix: reconcile skipped the last ledger page", {LS: ledger(2)}),
    ("2026-05-18", BOB, "handle backoff overflow, fixes #42", {RQ: retry(3)}),
    ("2026-06-02", ALICE, "fix(util): format JPY without decimals", {"src/util/format.ts": fmt(2)}),
    ("2026-06-15", ALICE, "fix(billing): skip zero-quantity lines", {IC: invoice(4)}),
    ("2026-07-01", BOB, "style: format retry queue", {RQ: retry(4)}),
    ("2026-07-20", DANA, "chore(sync): rename loop counters", {LS: ledger(3)}),
    ("2026-08-05", ALICE, "feat(billing): support credit notes", {IC: invoice(5)}),
    ("2026-08-25", BOB, "fix lint warnings in retry queue", {RQ: retry(5)}),
    ("2026-09-10", BOB, "feat(payments): configurable batch size", {RQ: retry(6), "tests/payments/RetryQueue.test.ts": RETRY_TEST}),
    ("2026-10-01", ALICE, "fix typo in rounding comment", {IC: invoice(6)}),
]


def final_files():
    files = {}
    for _, _, _, change in HISTORY:
        files.update(change)
    return files


def span(text, name):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"\s+(?:async\s+)?" + name + r"\s*\(", line):
            depth = 0
            for j in range(i, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                if depth <= 0:
                    return i + 1, j + 1
    raise KeyError(name)


def build_repo(cwd, history, remote):
    """Shared with run.py: materialize the scripted history as a real git repo."""
    cwd = Path(cwd)
    def git(*args, date=None, who=None):
        env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": "/dev/null"}
        if date:
            stamp = date + "T10:00:00+00:00"
            env.update(GIT_AUTHOR_NAME=who[0], GIT_AUTHOR_EMAIL=who[1], GIT_COMMITTER_NAME=who[0],
                       GIT_COMMITTER_EMAIL=who[1], GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
        return subprocess.run(["git", "-C", str(cwd), *args], env=env, check=True, capture_output=True, text=True).stdout
    git("init", "-q", "-b", "main")
    for date, who, subject, change in history:
        for rel, text in change.items():
            p = cwd / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        git("add", "-A")
        git("commit", "-q", "-m", subject, date=date, who=(who[0], who[1]))
    if remote:
        git("remote", "add", "origin", remote)
    return {line.split(" ", 1)[1]: line.split(" ", 1)[0] for line in git("log", "--format=%H %s").splitlines()}


# ---------------------------------------------------------------- canned scan rows
FILES = final_files()
SPANS = {"InvoiceCalculator#computeTotal": (IC,) + span(FILES[IC], "computeTotal"),
         "InvoiceCalculator#applyDiscount": (IC,) + span(FILES[IC], "applyDiscount"),
         "RetryQueue#processBatch": (RQ,) + span(FILES[RQ], "processBatch"),
         "RetryQueue#enqueue": (RQ,) + span(FILES[RQ], "enqueue"),
         "LedgerSync#reconcile": (LS,) + span(FILES[LS], "reconcile"),
         "TaxTable#rateFor": ("src/billing/TaxTable.ts",) + span(TAX, "rateFor"),
         "Gateway#charge": ("src/payments/Gateway.ts",) + span(GATEWAY, "charge")}
COLS = ["id", "payload.relativePath", "payload.symbolId", "payload.startLine", "payload.endLine", "rankingOverlay.preset",
        "rankingOverlay.file.bugFixRate.value", "rankingOverlay.file.bugFixRate.label",
        "rankingOverlay.file.churnVolatility.value", "rankingOverlay.file.churnVolatility.label",
        "rankingOverlay.file.relativeChurn.value", "rankingOverlay.file.relativeChurn.label",
        "rankingOverlay.file.ageDays.value", "rankingOverlay.file.ageDays.label",
        "rankingOverlay.file.blameDominantAuthor", "rankingOverlay.file.blameDominantAuthorPct.value",
        "rankingOverlay.file.blameDominantAuthorPct.label", "rankingOverlay.file.blameContributorCount",
        "rankingOverlay.chunk.commitCount.value", "rankingOverlay.chunk.commitCount.label",
        "rankingOverlay.chunk.bugFixRate.value", "rankingOverlay.chunk.bugFixRate.label"]
SIG = {  # file bugFix, volatility, relChurn, ageDays, owner, ownerPct, contributors, chunk commits, chunk bugFix
    "InvoiceCalculator#computeTotal": (50, "critical", 0.71, "erratic", 4.8, "high", 265, "typical", "Alice Moreau", 100, "deep-silo", 1, 6, "typical", 50, "critical"),
    "InvoiceCalculator#applyDiscount": (50, "critical", 0.71, "erratic", 4.8, "high", 265, "typical", "Alice Moreau", 100, "deep-silo", 1, 1, "low", 0, "healthy"),
    "RetryQueue#processBatch": (34, "concerning", 0.66, "erratic", 5.6, "extreme", 258, "typical", "Bob Tanaka", 100, "deep-silo", 1, 6, "typical", 33, "concerning"),
    "RetryQueue#enqueue": (34, "concerning", 0.66, "erratic", 5.6, "extreme", 258, "typical", "Bob Tanaka", 100, "deep-silo", 1, 1, "low", 0, "healthy"),
    "LedgerSync#reconcile": (33, "concerning", 0.41, "stable", 2.4, "high", 245, "typical", "Dana Okafor", 100, "deep-silo", 1, 3, "low", 33, "concerning"),
    "TaxTable#rateFor": (0, "healthy", 0.10, "stable", 0.3, "normal", 272, "typical", "Alice Moreau", 100, "deep-silo", 1, 1, "low", 0, "healthy"),
    "Gateway#charge": (0, "healthy", 0.10, "stable", 0.3, "normal", 272, "typical", "Alice Moreau", 100, "deep-silo", 1, 1, "low", 0, "healthy"),
}


def row(sym, preset):
    path, start, end = SPANS[sym]
    s = SIG[sym]
    return [str(uuid.uuid5(uuid.NAMESPACE_URL, "widgets/" + sym)), path, sym, start, end, preset, *s]


PRESET_ROWS = {
    "bugHunt": ["InvoiceCalculator#computeTotal", "RetryQueue#processBatch", "LedgerSync#reconcile"],
    "hotspots": ["RetryQueue#processBatch", "InvoiceCalculator#computeTotal", "InvoiceCalculator#applyDiscount"],
    "techDebt": ["InvoiceCalculator#computeTotal", "LedgerSync#reconcile", "RetryQueue#processBatch", "InvoiceCalculator#applyDiscount"],
    "dangerous": ["LedgerSync#reconcile", "RetryQueue#processBatch", "InvoiceCalculator#computeTotal", "TaxTable#rateFor"],
    "decomposition": ["InvoiceCalculator#computeTotal", "RetryQueue#processBatch"],
    "godModule": [],
    "architecturalHub": [],
}


def scan_responses():
    out = []
    for preset, syms in PRESET_ROWS.items():
        out.append({"tool": "rank_chunks", "arguments": {"rerank": preset},
                    "result": {"results": {"columns": COLS, "rows": [row(s, preset) for s in syms]}}})
    out.append({"tool": "find_similar", "arguments": {},
                "result": {"results": {"columns": COLS, "rows": [row("Gateway#charge", "bugHunt")]}}})
    out.append({"tool": "find_cycles", "arguments": {}, "result": {"empty": {"reason": "codegraphDisabled"}, "cycles": []}})
    return out


LABEL_MAPS = """## Label maps
bugFixRate: healthy <15 | concerning 15-40 | critical >40
churnVolatility: stable <0.5 | erratic >=0.5
relativeChurn: normal <2 | high 2-5 | extreme >5
commitCount: low <5 | typical 5-15 | high 15-30 | extreme >30
ageDays: recent <60 | typical 60-365 | legacy >365
blameDominantAuthorPct: shared <60 | concentrated 60-90 | deep-silo >90
"""

PRIOR_REPORT = """Risk Assessment: whole project
Scanned: 16 chunks across 4 presets, 5 unique files

## Overview

- src/billing — invoice totals come from one hand-rolled loop that keeps receiving rounding and edge-case fixes.
- src/payments — retry batching mixes timeout handling with backoff math and already re-sent duplicate charges.
- src/sync — ledger pagination is owned by one author and already shipped a page-skipping bug.

## Critical (4/4 presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests | Commits |
|---|--------|-----------|-----------|-------------|-------|---------|
| 1 | InvoiceCalculator#computeTotal | src/billing/InvoiceCalculator.ts:{ic} | Bug attractor, Untested hotspot | bugFix:50% critical churn:4.8 high | none | {ic_links} |

  Problem: invoice totals are wrong whenever a new line kind or rounding rule lands; customers get mis-billed.
  What's wrong: tax lookup, credit-note sign flip, zero-quantity skip and rounding all live in one loop body.
  Commits (3 of 6, bug-fix first):
{ic_card}

| 2 | RetryQueue#processBatch | src/payments/RetryQueue.ts:{rq} | Fragile | bugFix:34% concerning volatility:0.66 erratic | tests/payments/RetryQueue.test.ts | {rq_links} |

  Problem: a gateway timeout path can re-send or drop a charge; two fixes already landed here.
  What's wrong: dedup state (`seen`), backoff math and scheduling are mutated inside one catch block.
  Commits (3 of 6, bug-fix first):
{rq_card}

## High (3/4 presets)

| # | Symbol | File:Line | Risk Type | Key Signals | Tests | Commits |
|---|--------|-----------|-----------|-------------|-------|---------|
| 3 | LedgerSync#reconcile | src/sync/LedgerSync.ts:{ls} | Fragile silo | bugFix:33% concerning owner:Dana Okafor 100% deep-silo | none | {ls_links} |

  Problem: reconciliation counts can silently miss settled entries; only one person knows the pagination contract.
  What's wrong: an unbounded `while (true)` loop with the page-end check in the middle of the body.
  Commits (3 of 3, bug-fix first):
{ls_card}

## Medium (2/4) — 1 candidates

## Structural risks

structural risk not assessed — codegraph off

## Summary

- Critical zones: 2 — require immediate attention
- High zones: 1 — schedule for review
- Test gaps: 2 confirmed-untested among Critical/High
- Dominant risk type: Bug attractor
- Recommendation: root-cause the repeated billing fixes first.

## Next steps

| # | Case | Action | Call |
|---|------|--------|------|
| 1 | InvoiceCalculator#computeTotal src/billing/InvoiceCalculator.ts:{ic} | root-cause the repeated fixes | Skill(tea-rags:bug-hunt) on InvoiceCalculator#computeTotal |
| 1 | InvoiceCalculator#computeTotal src/billing/InvoiceCalculator.ts:{ic} | cover with tests before any change | Skill(dinopowers:test-driven-development) on InvoiceCalculator#computeTotal |
| 2 | RetryQueue#processBatch src/payments/RetryQueue.ts:{rq} | root-cause the repeated fixes | Skill(tea-rags:bug-hunt) on RetryQueue#processBatch |
| 3 | LedgerSync#reconcile src/sync/LedgerSync.ts:{ls} | knowledge transfer — owner reviews next | owner Dana Okafor (blameDominantAuthor) |
| 3 | LedgerSync#reconcile src/sync/LedgerSync.ts:{ls} | cover with tests before any change | Skill(dinopowers:test-driven-development) on LedgerSync#reconcile |

→ Work through the cases here and now (starting with #1), or file a task per case?
"""

BUGFIX = {"fix(billing): round totals per line, not per invoice", "fix(billing): skip zero-quantity lines",
          "fix(payments): drop duplicate retries after gateway timeout", "handle backoff overflow, fixes #42",
          "hotfix: reconcile skipped the last ledger page", "fix(util): format JPY without decimals"}
PICKS = {  # expected ≤3 per row: bug-fix (newest first), then other (newest first); cosmetic never picked
    "InvoiceCalculator#computeTotal": ["fix(billing): skip zero-quantity lines", "fix(billing): round totals per line, not per invoice", "feat(billing): support credit notes"],
    "RetryQueue#processBatch": ["handle backoff overflow, fixes #42", "fix(payments): drop duplicate retries after gateway timeout", "feat(payments): configurable batch size"],
    "LedgerSync#reconcile": ["hotfix: reconcile skipped the last ledger page", "chore(sync): rename loop counters", "feat(sync): ledger reconciliation"],
}
DATES = {s: d for d, _, s, _ in HISTORY}


def prior_report(shas, remote=True):
    def link(subject):
        sha = shas[subject]
        return f"[{sha[:7]}](https://github.com/acme/widgets/commit/{sha})"
    def card(sym):
        return "\n".join(f"  - {link(s)} {DATES[s]} {s}" + (" — bug-fix" if s in BUGFIX else "") for s in PICKS[sym])
    def links(sym):
        return " ".join(link(s) for s in PICKS[sym])
    keys = {"ic": "InvoiceCalculator#computeTotal", "rq": "RetryQueue#processBatch", "ls": "LedgerSync#reconcile"}
    fill = {}
    for k, sym in keys.items():
        fill[k] = SPANS[sym][1]
        fill[k + "_links"] = links(sym)
        fill[k + "_card"] = card(sym)
    return PRIOR_REPORT.format(**fill)


# ---------------------------------------------------------------- cases
SCAN_NOTE = ("Synthetic TypeScript repository 'widgets' in the session working directory, a real git checkout with "
             "its own commit history. All source files are indexed; codegraph is disabled for this project (no graph tools).")


def base_fixture(remote, extra_files=None, initial_context=None):
    files = dict(FILES)
    files.update(extra_files or {})
    fx = {"files": files, "git_history": [{"date": d, "author": list(w), "subject": s, "files": c} for d, w, s, c in HISTORY],
          "git_remote": remote, "raw_tool_responses": scan_responses(), "label_maps": LABEL_MAPS,
          "prime_extra": "codegraph: disabled for this project (no codegraph enrichment, no graph tools)\n"}
    if initial_context:
        fx["initial_context"] = initial_context
    return fx


def main():
    with tempfile.TemporaryDirectory() as tmp:
        shas = build_repo(tmp, [(d, w, s, c) for d, w, s, c in HISTORY], "git@github.com:acme/widgets.git")
    # The report turn loaded the skill; the runner substitutes the ARM's own SKILL.md for the placeholder,
    # so the follow-up turn sees the same skill text a real session would still hold.
    prior = [{"role": "user", "content": "Assess the code health of this whole project — where are the risks?"},
             {"role": "tool", "name": "Skill", "content": "__SKILL_TEXT:risk-assessment__"},
             {"role": "assistant", "content": prior_report(shas)}]
    beads = {".beads/config.yaml": "issue-prefix: widgets\n", ".beads/issues.jsonl": ""}
    gh = "git@github.com:acme/widgets.git"
    one_bash = {"kind": "bash_git_single_call", "required": True,
                "rule": "Exactly one Bash call invokes git; it carries git log -L<start>,<end>:<file> for each of the 3 Critical/High rows "
                        "(ranges = the rows' startLine/endLine); no repo-wide git log (git log without -L/--follow), no git blame, "
                        "and that call comes after the first Phase 1 rank_chunks call."}
    report_checks = [
        {"id": "phase1-before-git", "kind": "order", "required": True,
         "rule": "First rank_chunks call precedes the first Bash call that runs git."},
        dict(one_bash, id="one-bash-line-scoped"),
        {"id": "bodies-fetched", "kind": "find_symbol_bodies", "required": True,
         "symbols": ["InvoiceCalculator#computeTotal", "RetryQueue#processBatch", "LedgerSync#reconcile"],
         "rule": "Bodies of all three Critical/High rows fetched via find_symbol (metaOnly not true) before the report."},
        {"id": "overview", "kind": "answer", "required": True, "rule": "Answer has a '## Overview' heading followed by >=2 '- <module/dir> — ...' lines."},
        {"id": "commits-column", "kind": "answer", "required": True, "rule": "Critical and High table header rows end with a 'Commits' column."},
        {"id": "cards", "kind": "answer", "required": True,
         "rule": "Each of the 3 rows has 'Problem:', \"What's wrong:\" (describing the code body, or [not reviewed]) and 'Commits (<shown> of <total>, bug-fix first):' with total 6/6/3."},
        {"id": "bugfix-first", "kind": "answer", "required": True,
         "rule": "Per card: the expected picks (PICKS) appear; entries tagged '— bug-fix' precede untagged ones; 'fix typo in rounding comment' (cosmetic) is NOT picked; the fix(...)/fixes #42/hotfix entries are tagged."},
        {"id": "next-steps", "kind": "answer", "required": True,
         "rule": "'## Next steps' table with header '| # | Case | Action | Call |'; #1 and #2 map to Skill(tea-rags:bug-hunt), #1 (Tests none) also to Skill(dinopowers:test-driven-development); #3 names owner Dana Okafor (knowledge transfer) or test-driven-development."},
        {"id": "offer-line", "kind": "answer", "required": True,
         "rule": "A line starting with '→' offers 'here and now (starting with #1)' or 'a task per case'."},
        {"id": "no-start-no-task", "kind": "forbid", "required": True,
         "rule": "No bd/gh/tracker create, no Skill(bug-hunt / test-driven-development / refactoring-planning) invocation, no get_callers after the report scan; the answer ends at the offer (Output: line allowed)."},
        {"id": "commits-print-line", "kind": "answer", "required": False,
         "rule": "Prints 'commits: 3 rows, remote <host|none>' (informational)."},
    ]
    gh_links = {"id": "github-links", "kind": "answer", "required": True,
                "rule": "Commits column + card entries link each picked SHA as [<sha7>](https://github.com/acme/widgets/commit/<sha>)."}
    no_links = {"id": "bare-shas", "kind": "answer", "required": True,
                "rule": "Picked SHAs printed as bare sha7 (no https:// commit URL anywhere) and the cards say 'no web remote — links omitted'."}
    evals = [
        {"id": "R1", "name": "full-report-github-remote",
         "prompt": "Assess the code health of this whole project — where are the risks?",
         "actor_context": SCAN_NOTE, "fixture": base_fixture(gh),
         "expected": "Full phases 0–5 report: Overview; Critical computeTotal + processBatch, High reconcile; Commits column with github /commit/ links; cards with Problem / What's wrong / Commits (3 of 6, 3 of 6, 3 of 3) bug-fix first, 'fix typo' untagged; ONE line-scoped git Bash call after Phase 1; Next steps table + offer line; nothing started, no task created.",
         "grading": {"checks": report_checks[:4] + [gh_links] + report_checks[4:], "pass_rule": "Every required check passes."}},
        {"id": "R2", "name": "full-report-no-remote",
         "prompt": "Assess the code health of this whole project — where are the risks?",
         "actor_context": SCAN_NOTE, "fixture": base_fixture(None),
         "expected": "Same report as R1, but no remote: bare sha7, 'no web remote — links omitted', no URL built.",
         "grading": {"checks": report_checks[:4] + [no_links] + report_checks[4:], "pass_rule": "Every required check passes."}},
        {"id": "R3", "name": "follow-up-file-tasks-beads",
         "prompt": "заведи задачи по каждому кейсу",
         "actor_context": SCAN_NOTE + " The retained context holds the risk report you produced earlier in this session.",
         "fixture": base_fixture(gh, beads, prior),
         "expected": "Drafts one task per case (3: computeTotal, processBatch, reconcile) with title '<Risk Type>: <symbol>' and body = card + Action/Call + File:Line; tracker = beads (.beads/ present); prints 'tasks: 3 drafted → <beads/bd>; awaiting confirmation'; asks for explicit yes; NO bd create executed.",
         "grading": {"checks": [
             {"id": "drafts", "kind": "answer", "required": True, "rule": "Three task drafts, one per case, naming computeTotal, processBatch and reconcile."},
             {"id": "tracker-beads", "kind": "answer", "required": True, "rule": "Target tracker named as beads / bd (because .beads/ exists)."},
             {"id": "awaiting-line", "kind": "answer", "required": True, "rule": "Line 'tasks: 3 drafted → <beads|bd>; awaiting confirmation' (user-language paraphrase of the slots not accepted for the literal prefix 'tasks:')."},
             {"id": "no-create", "kind": "forbid", "required": True, "rule": "No 'bd create' / 'gh issue create' / tracker create call (bd shim log + Bash commands)."},
             {"id": "no-rescan", "kind": "forbid", "required": False, "rule": "No re-run of the Phase 1 scan (informational)."}],
             "pass_rule": "Every required check passes."}},
        {"id": "R4", "name": "follow-up-here-and-now",
         "prompt": "давай разберём здесь и сейчас",
         "actor_context": SCAN_NOTE + " The retained context holds the risk report you produced earlier in this session.",
         "fixture": base_fixture(gh, None, prior),
         "expected": "Handles only case #1 (InvoiceCalculator#computeTotal): runs its Next-steps Call (tea-rags:bug-hunt on computeTotal; the TDD row in table order or stated unavailable, no code edits); does not touch #2/#3; ends with '→ Next: #2 RetryQueue#processBatch — continue, skip, or file the rest as tasks?'; no task created.",
         "grading": {"checks": [
             {"id": "case1-call", "kind": "tool", "required": True, "rule": "Skill tea-rags:bug-hunt invoked (Skill tool) or its SKILL.md read, then tea-rags calls aimed at computeTotal / src/billing."},
             {"id": "only-case1", "kind": "forbid", "required": True, "rule": "No tool call whose arguments target processBatch/RetryQueue/reconcile/LedgerSync (case #2/#3 not started)."},
             {"id": "next-line", "kind": "answer", "required": True, "rule": "Answer ends with a line starting '→ Next: #2' (user language allowed for the rest)."},
             {"id": "no-task", "kind": "forbid", "required": True, "rule": "No bd/gh/tracker create call."}],
             "pass_rule": "Every required check passes."}},
        {"id": "C1", "name": "control-phase1-shape",
         "prompt": "Run a risk assessment of the payments domain.",
         "actor_context": SCAN_NOTE, "fixture": base_fixture(gh),
         "expected": "Phase 0 location test → pathPattern **/payments/**; Phase 1 bugHunt/hotspots/techDebt/dangerous + Phase 1b decomposition/godModule rank_chunks in ONE assistant message, each with testFile exclude, documentation exclude, metaOnly true; no git before them.",
         "grading": {"checks": [
             {"id": "parallel-block", "kind": "tool", "required": True, "rule": "One assistant message (message.id) carries rank_chunks for bugHunt, hotspots, techDebt, dangerous, decomposition, godModule."},
             {"id": "exclusions", "kind": "tool", "required": True, "rule": "Every Phase 1/1b rank_chunks call has testFile=exclude, documentation=exclude, metaOnly=true."},
             {"id": "git-after-scan", "kind": "order", "required": True, "rule": "No Bash git call before the Phase 1 block."}],
             "pass_rule": "Every required check passes."}},
    ]
    suite = {"skill_name": "risk-assessment", "optimized_skills": ["risk-assessment"],
             "suite_name": "2026-11-02-actionable-report", "schema_version": 1,
             "fixture_notes": [
                 "Runner materializes fixture.files by replaying fixture.git_history as a real git repo (fixed authors/dates → deterministic SHAs); git_remote null = no origin.",
                 "raw_tool_responses: rank_chunks canned per rerank preset; the fixture MCP filters rows by pathPattern / testFile; find_symbol serves bodies parsed from files.",
                 "label_maps is printed by the `tea-rags resource` PATH shim (skill preprocessor) and served as the metrics resource; prime_extra is appended to the `tea-rags prime` digest.",
                 "initial_context is passed as retained session context before the current request (R3/R4). bd and gh are PATH shims that log every call.",
                 "Never expose expected, grading or fixture_notes to the actor."],
             "picks": PICKS, "bugfix_subjects": sorted(BUGFIX), "spans": {k: list(v) for k, v in SPANS.items()},
             "evals": evals}
    OUT.write_text(json.dumps(suite, indent=1, ensure_ascii=False) + "\n")
    print(OUT, {k: v[:7] for k, v in shas.items()})


if __name__ == "__main__":
    main()
