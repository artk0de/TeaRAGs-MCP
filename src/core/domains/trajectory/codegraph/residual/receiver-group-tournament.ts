/**
 * Receiver-group questions (codegraph residual wave 1.5, design §3): the residual
 * sites on one receiver in one method are asked ONE question — "which class is
 * this receiver" — over the group's narrowed class set. A class set beyond the
 * menu limit goes to a tournament: the classes the receiver's name matches are
 * asked first (block 1, early accept); then blocks of `menuLimit`, each asked
 * with "none"; block winners at or above the floor form the next round; at most
 * {@link MAX_TOURNAMENT_ROUNDS} rounds after block 1, and only the last round's
 * single block yields the group's verdict.
 *
 * Confirm stage (`CODEGRAPH_RESIDUAL_CONFIRM_STAGE`): a block-1 or full-menu
 * pick at or above the floor but below the accept threshold is asked once more
 * as `[pick, none]`, and that answer settles the group; plain round blocks are
 * never asked, so a tournament without a name prior, or whose block 1 is
 * neither accepted nor confirmable, ends without a verdict.
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
import { nameMatchedClasses } from "./receiver-name-prior.js";
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

/** One answered class question: its menu, the model's probabilities, and whether it was block 1 (judged by the name-prior threshold). */
export interface GroupSpread {
  menu: string[];
  probabilities: Record<string, number>;
  fromPrior: boolean;
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

/**
 * One group's run through the rounds; `questions()` and `advance()` alternate
 * once per round. A tournament whose receiver name matches some of its classes
 * opens with those classes alone (block 1, at most `menuLimit`, best match
 * first): a winner at or above the accept threshold ends it after one question;
 * otherwise the remaining classes run the ordinary rounds and the block-1 winner,
 * when it clears the floor, joins the first round it fits into without adding a
 * block. The name orders the asking; it never removes a class.
 */
export class GroupTournament {
  private entrants: string[];
  private roundNo = 1;
  private result: GroupOutcome | undefined;
  /** The current round's questions, built once per round. */
  private current: ResidualQuestion[] | undefined;
  /** Block 1: the name-matched classes, asked before every other round. */
  private readonly prior: string[] | undefined;
  private priorPending: boolean;
  /** The block-1 winner waiting for a round it fits into. */
  private seed: string | undefined;
  private accepted = false;
  /** The mid pick waiting for its `[pick, none]` question. */
  private confirmPick: string | undefined;
  private confirmAnsweredFlag = false;
  private confirmAcceptedFlag = false;
  /** The confirm question re-asks a block-1 (name-prior) pick. */
  private confirmFromPrior = false;
  private namePriorPick = false;
  /** The last answer over two or more classes that picked a class: a full menu, a final block, or block 1. */
  private spreadAnswer: GroupSpread | undefined;

  constructor(
    readonly group: ReceiverGroup,
    private readonly menuLimit: number,
    private readonly questionHash: (menuHash: string) => string,
    private readonly confirmStage = false,
  ) {
    this.entrants = group.classes;
    const matched = this.isTournament ? nameMatchedClasses(group.receiverText, group.classes) : [];
    this.prior = matched.length > 0 ? matched.slice(0, menuLimit) : undefined;
    this.priorPending = this.prior !== undefined;
    if (confirmStage && this.isTournament && this.prior === undefined) this.abandon();
  }

  /** The class set exceeds one menu. */
  get isTournament(): boolean {
    return this.group.classes.length > this.menuLimit;
  }

  /** The tournament opens with the classes the receiver's name matches. */
  get hasNamePrior(): boolean {
    return this.prior !== undefined;
  }

  /** Block 1's winner cleared the accept threshold and ended the tournament. */
  get earlyAccepted(): boolean {
    return this.accepted;
  }

  /** Rounds asked so far, block 1 included. */
  get round(): number {
    if (this.prior === undefined) return this.roundNo;
    return this.priorPending || this.accepted ? 1 : 1 + this.roundNo;
  }

  get outcome(): GroupOutcome | undefined {
    return this.result;
  }

  /**
   * The menu and probabilities of the answer the group's pick came from, before
   * any confirm question; the interface fan-out reads it. Absent until such an
   * answer arrives.
   */
  get spread(): GroupSpread | undefined {
    return this.spreadAnswer;
  }

  /** The group's `[pick, none]` question was answered. */
  get confirmAnswered(): boolean {
    return this.confirmAnsweredFlag;
  }

  /** The confirm answer cleared the accept threshold and settled the group on its pick. */
  get confirmAccepted(): boolean {
    return this.confirmAcceptedFlag;
  }

  /** The verdict's class came from block 1 — directly or through its confirm — and is judged by the name-prior threshold. */
  get pickedByNamePrior(): boolean {
    return this.namePriorPick;
  }

  /** Its next questions draw on the tournament budget: tournament blocks and confirm questions. */
  get chargesBudget(): boolean {
    return this.isTournament || this.confirmPick !== undefined;
  }

  /**
   * Upper bound on the block questions this tournament may still ask, the
   * current round included: every block winner is assumed to clear the floor.
   */
  get questionsLeftAtMost(): number {
    if (this.result !== undefined) return 0;
    if (this.confirmStage) {
      if (this.confirmPick !== undefined) return 1;
      return this.priorPending ? 2 : 0;
    }
    let entrants = this.entrants.length;
    let total = 0;
    if (this.priorPending && this.prior !== undefined) {
      total = 1;
      entrants = this.group.classes.length - this.prior.length + 1;
    }
    for (let round = this.roundNo; round <= MAX_TOURNAMENT_ROUNDS; round++) {
      const blocks = Math.ceil(entrants / this.menuLimit);
      total += blocks;
      if (blocks <= 1) break;
      entrants = blocks;
    }
    return total;
  }

  /** Stop without a verdict: the budget ran out or the round could not be answered. */
  abandon(): void {
    this.result = "residual";
    this.current = [];
  }

  /**
   * The current round's questions — block 1 first when there is one, then
   * blocks of `menuLimit` entrants. A round that is the last allowed but still
   * needs more than one block can never produce a verdict, so the group is
   * abandoned instead of asked. Block 1 does not count against the round cap.
   */
  questions(): ResidualQuestion[] {
    if (this.result !== undefined) return [];
    if (this.current !== undefined) return this.current;
    if (this.confirmPick !== undefined) {
      this.current = [this.question([this.confirmPick], `${this.group.id}/c.0`)];
      return this.current;
    }
    if (this.priorPending && this.prior !== undefined) {
      this.current = [this.question(this.prior, `${this.group.id}/0.0`)];
      return this.current;
    }
    const blocks: string[][] = [];
    if (this.seed !== undefined && this.entrants.length < this.menuLimit) {
      blocks.push([this.seed, ...this.entrants]);
      this.seed = undefined;
    } else {
      for (let i = 0; i < this.entrants.length; i += this.menuLimit) {
        blocks.push(this.entrants.slice(i, i + this.menuLimit));
      }
    }
    if (blocks.length > 1 && this.roundNo >= MAX_TOURNAMENT_ROUNDS) {
      this.abandon();
      return [];
    }
    const single = !this.isTournament;
    this.current = blocks.map((block, index) =>
      this.question(block, single ? this.group.id : `${this.group.id}/${this.roundNo}.${index}`),
    );
    return this.current;
  }

  /**
   * Reads the round's verdicts. Block 1: a class at or above `accept` settles
   * the group, anything else hands it to the remaining classes. Otherwise a
   * single block with no seed waiting settles the group, and the winners at or
   * above `floor` (the seed among them) enter the next round. An unanswered
   * block leaves the group without a verdict this run. `priorAccept` replaces
   * `accept` for a block-1 pick and the confirm of one.
   */
  advance(
    verdictOf: (question: ResidualQuestion) => ResidualVerdict | undefined,
    floor: number,
    accept: number,
    priorAccept = accept,
  ): void {
    const questions = this.questions();
    if (this.result !== undefined || questions.length === 0) return;
    const verdicts = questions.map(verdictOf);
    if (verdicts.some((v) => v === undefined)) {
      this.abandon();
      return;
    }
    const answered = verdicts as ResidualVerdict[];
    this.current = undefined;
    if (this.confirmPick !== undefined) {
      this.settleConfirm(answered[0], this.confirmFromPrior ? priorAccept : accept);
      return;
    }
    if (this.priorPending) {
      this.advancePrior(answered[0], floor, priorAccept);
      return;
    }
    if (questions.length === 1 && this.seed === undefined) {
      this.keepSpread(questions[0].candidates, answered[0], false);
      if (this.confirmStage && isMidPick(answered[0], floor, accept)) this.confirmPick = answered[0].pick as string;
      else this.result = { pick: answered[0].pick, p: answered[0].p };
      return;
    }
    const winners = answered.filter((v) => v.pick !== null && v.p >= floor).map((v) => v.pick as string);
    if (this.seed !== undefined) winners.unshift(this.seed);
    this.seed = undefined;
    if (winners.length === 0) {
      this.abandon();
      return;
    }
    this.entrants = winners;
    this.roundNo++;
  }

  private advancePrior(verdict: ResidualVerdict, floor: number, accept: number): void {
    this.priorPending = false;
    if (this.prior !== undefined) this.keepSpread(this.prior, verdict, true);
    if (verdict.pick !== null && verdict.p >= accept) {
      this.result = { pick: verdict.pick, p: verdict.p };
      this.accepted = true;
      this.namePriorPick = true;
      return;
    }
    if (this.confirmStage) {
      if (isMidPick(verdict, floor, accept)) {
        this.confirmPick = verdict.pick as string;
        this.confirmFromPrior = true;
      } else this.abandon();
      return;
    }
    const asked = new Set(this.prior);
    this.entrants = this.group.classes.filter((c) => !asked.has(c));
    if (verdict.pick !== null && verdict.p >= floor) this.seed = verdict.pick;
  }

  /** A pick settles the group with its own `p`; a none leaves it without a verdict, never external. */
  private settleConfirm(verdict: ResidualVerdict, accept: number): void {
    this.confirmPick = undefined;
    this.confirmAnsweredFlag = true;
    if (verdict.pick === null) {
      this.result = "residual";
      return;
    }
    this.result = { pick: verdict.pick, p: verdict.p };
    this.confirmAcceptedFlag = verdict.p >= accept;
    this.namePriorPick = this.confirmFromPrior;
  }

  private keepSpread(menu: string[], verdict: ResidualVerdict, fromPrior: boolean): void {
    if (verdict.pick === null || menu.length < 2) return;
    this.spreadAnswer = { menu, probabilities: verdict.probabilities, fromPrior };
  }

  private question(block: string[], siteKey: string): ResidualQuestion {
    return {
      siteKey,
      menuHash: this.questionHash(residualMenuHash(block)),
      receiverText: this.group.receiverText,
      member: this.group.members[0] ?? "",
      kind: this.group.kind,
      candidates: block,
      subject: "class",
      members: this.group.members,
    };
  }
}

/** A class pick at or above `floor` but below `accept`: worth one confirm question. */
function isMidPick(verdict: ResidualVerdict, floor: number, accept: number): boolean {
  return verdict.pick !== null && verdict.p >= floor && verdict.p < accept;
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
  const out: string[] = [];
  let previous = -1;
  for (const i of windowLineIndexes(lines.length, methodStartLine, callLines, radius)) {
    if (i > previous + 1) out.push("…");
    out.push(lines[i]);
    previous = i;
  }
  return out.join("\n");
}

/** 0-based indexes into the method source that {@link windowMethodSource} keeps, ascending. */
export function windowLineIndexes(
  lineCount: number,
  methodStartLine: number,
  callLines: readonly number[],
  radius = METHOD_WINDOW_LINES,
): number[] {
  const keep = new Set<number>([0]);
  for (const line of callLines) {
    const at = line - methodStartLine;
    for (let i = Math.max(0, at - radius); i <= Math.min(lineCount - 1, at + radius); i++) keep.add(i);
  }
  return [...keep].sort((a, b) => a - b);
}
