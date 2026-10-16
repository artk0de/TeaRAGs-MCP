/**
 * Receiver-group questions (codegraph residual wave 1.5, design §3): the residual
 * sites on one receiver in one method are asked ONE question — "which class is
 * this receiver" — over the group's narrowed class set. A class set beyond the
 * menu limit goes to a tournament: blocks of `menuLimit`, each asked with
 * "none"; block winners at or above the floor form the next round; at most
 * {@link MAX_TOURNAMENT_ROUNDS} rounds, and only the last round's single block
 * yields the group's verdict.
 *
 * Spec: `docs/superpowers/specs/2026-10-16-codegraph-residual-wave-1-5-design.md`
 */
import { createHash } from "node:crypto";

import type {
  ResidualCallSiteRow,
  ResidualKind,
  ResidualQuestion,
  ResidualVerdict,
} from "../../../../contracts/types/codegraph-residual.js";
import { residualMenuHash } from "./residual-site-builder.js";

/** Smallest `p` of a block winner that carries it into the next round; `CODEGRAPH_RESIDUAL_TOURNAMENT_FLOOR`. */
export const DEFAULT_TOURNAMENT_FLOOR = 0.5;
/** Tournament block questions one run may send; `CODEGRAPH_RESIDUAL_TOURNAMENT_BUDGET`. */
export const DEFAULT_TOURNAMENT_BUDGET = 5000;
/** Three rounds of 40-class blocks cover 64,000 classes; the largest TaxDome set is ~1,200. */
export const MAX_TOURNAMENT_ROUNDS = 3;

export interface ReceiverGroup {
  /** Root of every question key the group is asked under. */
  id: string;
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  receiverText: string;
  kind: ResidualKind;
  /** Members called on the receiver among its residual sites, sorted. */
  members: string[];
  /** Call lines of its residual sites, sorted. */
  lines: number[];
  /** The narrowed class set in menu order. */
  classes: string[];
  rows: ResidualCallSiteRow[];
}

/** The group's outcome: a verdict of the last round, or `residual` — no verdict this run. */
export type GroupOutcome = { pick: string | null; p: number } | "residual";

/**
 * Rows carrying a receiver group, one {@link ReceiverGroup} per (file, group);
 * the class menu is the first row's order over the classes every row offers. A
 * group whose rows share no class falls back to per-site questions.
 */
export function collectReceiverGroups(rows: readonly ResidualCallSiteRow[]): {
  groups: ReceiverGroup[];
  ungrouped: ResidualCallSiteRow[];
} {
  const byKey = new Map<string, ResidualCallSiteRow[]>();
  const ungrouped: ResidualCallSiteRow[] = [];
  const seenSites = new Set<string>();
  for (const row of rows) {
    if (row.receiverGroup === undefined || row.classTargets === undefined || row.classTargets.length === 0) {
      ungrouped.push(row);
      continue;
    }
    const siteId = `${row.sourceRelPath}\u0000${row.siteKey}`;
    if (seenSites.has(siteId)) continue;
    seenSites.add(siteId);
    const key = `${row.sourceRelPath}\u0000${row.receiverGroup}`;
    const members = byKey.get(key);
    if (members === undefined) byKey.set(key, [row]);
    else members.push(row);
  }
  const groups: ReceiverGroup[] = [];
  for (const [key, members] of byKey) {
    const [first] = members;
    const offered = members.map((r) => new Set((r.classTargets ?? []).map(([c]) => c)));
    const classes = (first.classTargets ?? []).map(([c]) => c).filter((c) => offered.every((set) => set.has(c)));
    if (classes.length === 0) {
      ungrouped.push(...members);
      continue;
    }
    groups.push({
      id: createHash("sha1").update(`rg\u0000${key}`).digest("hex"),
      sourceRelPath: first.sourceRelPath,
      methodSymbolId: first.methodSymbolId,
      methodStartLine: first.methodStartLine,
      methodEndLine: first.methodEndLine,
      receiverText: first.receiverText,
      kind: first.kind,
      members: [...new Set(members.map((r) => r.member))].sort(),
      lines: [...new Set(members.map((r) => r.line))].sort((a, b) => a - b),
      classes,
      rows: members,
    });
  }
  return { groups, ungrouped };
}

/** One group's run through the rounds; `questions()` and `advance()` alternate once per round. */
export class GroupTournament {
  private entrants: string[];
  private roundNo = 1;
  private result: GroupOutcome | undefined;
  /** The current round's questions, built once per round. */
  private current: ResidualQuestion[] | undefined;

  constructor(
    readonly group: ReceiverGroup,
    private readonly menuLimit: number,
    private readonly questionHash: (menuHash: string) => string,
  ) {
    this.entrants = group.classes;
  }

  /** The class set exceeds one menu. */
  get isTournament(): boolean {
    return this.group.classes.length > this.menuLimit;
  }

  get round(): number {
    return this.roundNo;
  }

  get outcome(): GroupOutcome | undefined {
    return this.result;
  }

  /** Stop without a verdict: the budget ran out or the round could not be answered. */
  abandon(): void {
    this.result = "residual";
    this.current = [];
  }

  /**
   * The current round's questions — blocks of `menuLimit` entrants. A round
   * that is the last allowed but still needs more than one block can never
   * produce a verdict, so the group is abandoned instead of asked.
   */
  questions(): ResidualQuestion[] {
    if (this.result !== undefined) return [];
    if (this.current !== undefined) return this.current;
    const blocks: string[][] = [];
    for (let i = 0; i < this.entrants.length; i += this.menuLimit) {
      blocks.push(this.entrants.slice(i, i + this.menuLimit));
    }
    if (blocks.length > 1 && this.roundNo >= MAX_TOURNAMENT_ROUNDS) {
      this.abandon();
      return [];
    }
    const single = !this.isTournament;
    this.current = blocks.map((block, index) => ({
      siteKey: single ? this.group.id : `${this.group.id}/${this.roundNo}.${index}`,
      menuHash: this.questionHash(residualMenuHash(block)),
      receiverText: this.group.receiverText,
      member: this.group.members[0] ?? "",
      kind: this.group.kind,
      candidates: block,
      subject: "class",
      members: this.group.members,
    }));
    return this.current;
  }

  /**
   * Reads the round's verdicts: a single block settles the group; otherwise the
   * winners at or above `floor` enter the next round. An unanswered block
   * leaves the group without a verdict this run.
   */
  advance(verdictOf: (question: ResidualQuestion) => ResidualVerdict | undefined, floor: number): void {
    const questions = this.questions();
    if (this.result !== undefined || questions.length === 0) return;
    const verdicts = questions.map(verdictOf);
    if (verdicts.some((v) => v === undefined)) {
      this.abandon();
      return;
    }
    const answered = verdicts as ResidualVerdict[];
    if (questions.length === 1) {
      this.result = { pick: answered[0].pick, p: answered[0].p };
      return;
    }
    const winners = answered.filter((v) => v.pick !== null && v.p >= floor).map((v) => v.pick as string);
    if (winners.length === 0) {
      this.abandon();
      return;
    }
    this.entrants = winners;
    this.roundNo++;
    this.current = undefined;
  }
}

/** Lines of context kept on each side of a call line when a method is too long to ask whole. */
export const METHOD_WINDOW_LINES = 20;

/**
 * `methodSource` cut to its first line (the signature, which names the
 * parameters) and `±radius` lines around each call line, gaps marked `…`.
 * Ranges that touch merge.
 */
export function windowMethodSource(
  source: string,
  methodStartLine: number,
  callLines: readonly number[],
  radius = METHOD_WINDOW_LINES,
): string {
  const lines = source.split("\n");
  const keep = new Set<number>([0]);
  for (const line of callLines) {
    const at = line - methodStartLine;
    for (let i = Math.max(0, at - radius); i <= Math.min(lines.length - 1, at + radius); i++) keep.add(i);
  }
  const out: string[] = [];
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > previous + 1) out.push("…");
    out.push(lines[i]);
    previous = i;
  }
  return out.join("\n");
}
