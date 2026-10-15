/**
 * Edge-precision math for the residual live validation (bd
 * tea-rags-mcp-2m83f.24, section A): strata of a model edge, a reproducible
 * stratified draw, and the scores of a labelled sample — precision per
 * stratum, 5-bin calibration with ECE, the threshold sweep and the recall
 * proxy against an oracle.
 */

export type PBucket = "<0.7" | "0.7-0.8" | "0.8-0.9" | "0.9+";
export type MenuBucket = "1" | "2-3" | "4-10" | "11-40" | ">40";
export type ReceiverShape = "ivar" | "param" | "local" | "chained" | "constant" | "self" | "implicit";

export interface SampleCandidate {
  id: string;
  stratum: string;
}

/** One sampled edge after labelling: `label` is the true target (`"none"` when no candidate is right), null = unlabelled. */
export interface LabelledEdge {
  id: string;
  stratum: string;
  kind: string;
  pBucket: PBucket;
  menuBucket: MenuBucket;
  receiverShape: ReceiverShape;
  chosen: string;
  p: number;
  label: string | null;
  /** A second labeller's answer on the spot-checked rows. */
  spotLabel?: string | null;
}

export interface PrecisionCell {
  n: number;
  correct: number;
  precision: number;
}

export interface LabelledScore {
  labelled: number;
  precision: number;
  byStratum: Record<string, PrecisionCell>;
  byDimension: Record<"kind" | "pBucket" | "menuBucket" | "receiverShape", Record<string, PrecisionCell>>;
  spotCheck: { n: number; agree: number; agreement: number };
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  accuracy: number;
  meanP: number;
}

export interface SweepRow {
  threshold: number;
  kept: number;
  keptShare: number;
  precision: number;
}

export interface OracleSite {
  truth: string;
  menu: readonly string[];
  /** The model's pick, null when the site was never answered. */
  pick: string | null;
  p: number | null;
}

/** The epic's precision bar at the chosen threshold. */
export const PRECISION_TARGET = 0.93;
export const SWEEP_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;
const CALIBRATION_BINS = 5;
const CALIBRATION_LO = 0.5;

const ratio = (hits: number, of: number): number => (of === 0 ? 0 : hits / of);

export function pBucket(p: number): PBucket {
  if (p >= 0.9) return "0.9+";
  if (p >= 0.8) return "0.8-0.9";
  if (p >= 0.7) return "0.7-0.8";
  return "<0.7";
}

export function menuBucket(size: number): MenuBucket {
  if (size <= 1) return "1";
  if (size <= 3) return "2-3";
  if (size <= 10) return "4-10";
  if (size <= 40) return "11-40";
  return ">40";
}

/** Parameter names of the method's `def` line: `def run(a, b:, *c, &d)` or `def run a, b`. */
function paramNames(methodSource: string): Set<string> {
  const def = /\bdef\s+[\w.?!=]+(?:\s*\(([^)]*)\)|[ \t]+([^\n;]+))?/u.exec(methodSource);
  const list = def?.[1] ?? def?.[2] ?? "";
  return new Set(
    list
      .split(",")
      .map((part) => /^[\s*&]*(\w+)/u.exec(part)?.[1])
      .filter((name): name is string => name !== undefined),
  );
}

/** How the call's receiver is spelled — a sampling dimension, judged from the text and the method's `def` line. */
export function receiverShape(receiverText: string, methodSource: string): ReceiverShape {
  const text = receiverText.trim();
  if (text === "") return "implicit";
  if (text === "self") return "self";
  if (/^@\w+$/u.test(text)) return "ivar";
  if (/[.([&]|::/u.test(text)) return "chained";
  if (/^[A-Z]/u.test(text)) return "constant";
  return paramNames(methodSource).has(text) ? "param" : "local";
}

/** mulberry32 — a seeded PRNG, so a sample is reproducible from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Draw `n` candidates: every non-empty stratum at least once, the remainder by
 * largest remainder in proportion to stratum size, each stratum drawn without
 * replacement in a seeded order. The whole pool when `n` covers it.
 */
export function stratifiedSample<T extends SampleCandidate>(pool: readonly T[], n: number, seed: number): T[] {
  if (n >= pool.length) return [...pool];
  const random = seededRandom(seed);
  const strata = new Map<string, T[]>();
  for (const candidate of pool) strata.set(candidate.stratum, [...(strata.get(candidate.stratum) ?? []), candidate]);
  const keys = [...strata.keys()].sort();
  const quota = new Map(keys.map((key) => [key, n >= keys.length ? 1 : 0]));
  const spare = n - [...quota.values()].reduce((a, b) => a + b, 0);
  const shares = keys.map((key) => {
    const size = strata.get(key)?.length ?? 0;
    const exact = (spare * size) / pool.length;
    return { key, room: size - (quota.get(key) ?? 0), whole: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  for (const share of shares) quota.set(share.key, (quota.get(share.key) ?? 0) + Math.min(share.whole, share.room));
  let left = n - [...quota.values()].reduce((a, b) => a + b, 0);
  for (const share of [...shares].sort((a, b) => b.rest - a.rest || a.key.localeCompare(b.key))) {
    if (left === 0) break;
    if ((quota.get(share.key) ?? 0) >= (strata.get(share.key)?.length ?? 0)) continue;
    quota.set(share.key, (quota.get(share.key) ?? 0) + 1);
    left--;
  }
  return keys.flatMap((key) => shuffled(strata.get(key) ?? [], random).slice(0, quota.get(key) ?? 0));
}

const labelledOnly = (edges: readonly LabelledEdge[]): LabelledEdge[] =>
  edges.filter((edge) => edge.label !== null && edge.label !== undefined);

const isCorrect = (edge: LabelledEdge): boolean => edge.label === edge.chosen;

function precisionBy(
  edges: readonly LabelledEdge[],
  keyOf: (edge: LabelledEdge) => string,
): Record<string, PrecisionCell> {
  const cells: Record<string, PrecisionCell> = {};
  for (const edge of edges) {
    const cell = (cells[keyOf(edge)] ??= { n: 0, correct: 0, precision: 0 });
    cell.n++;
    if (isCorrect(edge)) cell.correct++;
  }
  for (const cell of Object.values(cells)) cell.precision = ratio(cell.correct, cell.n);
  return cells;
}

export function scoreLabelledEdges(edges: readonly LabelledEdge[]): LabelledScore {
  const done = labelledOnly(edges);
  const spot = done.filter((edge) => edge.spotLabel !== undefined && edge.spotLabel !== null);
  const agree = spot.filter((edge) => edge.spotLabel === edge.label).length;
  return {
    labelled: done.length,
    precision: ratio(done.filter(isCorrect).length, done.length),
    byStratum: precisionBy(done, (edge) => edge.stratum),
    byDimension: {
      kind: precisionBy(done, (edge) => edge.kind),
      pBucket: precisionBy(done, (edge) => edge.pBucket),
      menuBucket: precisionBy(done, (edge) => edge.menuBucket),
      receiverShape: precisionBy(done, (edge) => edge.receiverShape),
    },
    spotCheck: { n: spot.length, agree, agreement: ratio(agree, spot.length) },
  };
}

/** Five equal-width bins over [0.5, 1]; ECE = Σ (n_bin / N) · |accuracy_bin − meanP_bin|. */
export function calibration(edges: readonly LabelledEdge[]): { bins: CalibrationBin[]; ece: number } {
  const done = labelledOnly(edges);
  const width = (1 - CALIBRATION_LO) / CALIBRATION_BINS;
  const groups: LabelledEdge[][] = Array.from({ length: CALIBRATION_BINS }, () => []);
  for (const edge of done) {
    // Rounded before flooring so a p on a bin edge (0.7) is not pushed down by float error.
    const raw = Math.floor(Math.round(((edge.p - CALIBRATION_LO) / width) * 1e9) / 1e9);
    groups[Math.min(CALIBRATION_BINS - 1, Math.max(0, raw))].push(edge);
  }
  const bins = groups.map((group, i) => ({
    lo: Number((CALIBRATION_LO + i * width).toFixed(2)),
    hi: Number((CALIBRATION_LO + (i + 1) * width).toFixed(2)),
    n: group.length,
    accuracy: ratio(group.filter(isCorrect).length, group.length),
    meanP: ratio(
      group.reduce((sum, edge) => sum + edge.p, 0),
      group.length,
    ),
  }));
  const ece = bins.reduce((sum, bin) => sum + ratio(bin.n, done.length) * Math.abs(bin.accuracy - bin.meanP), 0);
  return { bins, ece };
}

/** Edges kept and their precision at each threshold; `recommended` = the lowest threshold whose precision reaches `target`. */
export function thresholdSweep(
  edges: readonly LabelledEdge[],
  target: number = PRECISION_TARGET,
): { rows: SweepRow[]; recommended: number | null } {
  const done = labelledOnly(edges);
  const rows = SWEEP_THRESHOLDS.map((threshold) => {
    const kept = done.filter((edge) => edge.p >= threshold);
    return {
      threshold,
      kept: kept.length,
      keptShare: ratio(kept.length, done.length),
      precision: ratio(kept.filter(isCorrect).length, kept.length),
    };
  });
  const recommended = rows.find((row) => row.kept > 0 && row.precision >= target)?.threshold ?? null;
  return { rows, recommended };
}

/**
 * Of the oracle sites whose true target is on the menu, the share that got an
 * edge to it at `threshold`; `wrongEdges` counts those that got an edge to
 * another candidate.
 */
export function recallProxy(
  sites: readonly OracleSite[],
  threshold: number,
): { eligible: number; recovered: number; recall: number; wrongEdges: number } {
  const eligible = sites.filter((site) => site.menu.includes(site.truth));
  const edged = eligible.filter((site) => site.pick !== null && site.p !== null && site.p >= threshold);
  const recovered = edged.filter((site) => site.pick === site.truth).length;
  return {
    eligible: eligible.length,
    recovered,
    recall: ratio(recovered, eligible.length),
    wrongEdges: edged.length - recovered,
  };
}
