/**
 * Codegraph residual resolution (wave 1) — the call sites the static resolver
 * leaves without an edge, the model edges a residual pass applies over them,
 * the verdicts it caches, and the provider port that answers them.
 *
 * Every port type lives here rather than in the residual domain: the verdict
 * store and the model-provider adapters implement or persist them, and adapters
 * import only `core/{contracts,infra}`. The domain's `residual/types.ts`
 * re-exports them and adds `ResidualPassReport` only.
 *
 * Spec: `docs/superpowers/specs/2026-10-09-codegraph-residual-resolution-design.md`
 */

export type ResidualKind = "ambiguous" | "dynamic";

/** One row of `cg_residual_call_sites` (053). */
export interface ResidualCallSiteRow {
  /** sha1(relPath, methodSymbolId, line, column, receiverText, member). */
  siteKey: string;
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  line: number;
  column: number;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  /** Target method symbolIds, e.g. `"Firm#users"`. */
  candidates: string[];
  /** sha1 of the sorted candidates joined by `"\n"`. */
  menuHash: string;
  /** The candidates were cut at the menu limit. */
  menuOverflow: boolean;
}

/** A model-picked edge for one residual site, written with `origin = 'model'` (054). */
export interface ModelEdgeRow {
  siteKey: string;
  sourceRelPath: string;
  /** The residual row's `methodSymbolId`. */
  sourceSymbolId: string;
  /** The picked candidate. */
  targetSymbolId: string;
  model: string;
  p: number;
}

export type EdgeOrigin = "static" | "model";

export interface ResidualVerdict {
  siteKey: string;
  menuHash: string;
  model: string;
  modelVersion: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  lastSeenAt: number;
}

export interface ResidualQuestion {
  siteKey: string;
  menuHash: string;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[];
}

export interface ResidualQuestionGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodSource: string;
  questions: ResidualQuestion[];
}

export interface ResidualAnswer {
  siteKey: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
}

export interface ResidualModelProvider {
  readonly id: string;
  readonly threshold: number;
  version: () => Promise<string>;
  health: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  resolveGroup: (group: ResidualQuestionGroup) => Promise<ResidualAnswer[]>;
}
