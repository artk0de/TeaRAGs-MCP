/**
 * Draws calibration questions from the static site sample: per stratum, the
 * lowest-priority rows that fit it, each with the class menu the pass would ask
 * and the static truth. Keys live in their own space (`cal:<stratum>:<siteKey>`)
 * so their verdicts never meet a residual site's.
 */

import type { StaticSiteSampleRow } from "../../../../contracts/types/codegraph-residual.js";
import { menuSizeBucket, type CalibrationStratum, type MenuSizeBucket } from "./calibration-answer.js";
import { orderClassesByNamingPrior } from "./receiver-closure.js";
import { nameMatchedClasses } from "./receiver-name-prior.js";

export type CalibrationStrataSizes = Record<CalibrationStratum, number>;

/** Full-menu questions a run draws (S1). */
export const FULL_MENU_CALIBRATION_CAP = 300;
/** Block-1 questions a run draws (S2). */
export const BLOCK1_CALIBRATION_CAP = 150;
/** External questions a run draws (S3); the full-menu fit's lower bound is driven by this stratum's noise. */
export const EXTERNAL_CALIBRATION_CAP = 400;

export const DEFAULT_CALIBRATION_STRATA_SIZES: Readonly<CalibrationStrataSizes> = {
  fullMenu: FULL_MENU_CALIBRATION_CAP,
  block1: BLOCK1_CALIBRATION_CAP,
  external: EXTERNAL_CALIBRATION_CAP,
};

/** Receiver kinds the full-menu stratum is balanced over, in draw order. */
export const CALIBRATION_RECEIVER_KINDS = ["localVar", "ivar", "chain", "dynamic"] as const;

/** One calibration question: the menu it asks and the answer the static resolver knows. */
export interface CalibrationItem {
  key: string;
  stratum: CalibrationStratum;
  site: StaticSiteSampleRow;
  /** Class menu, in the order the pass asks it. */
  classes: string[];
  /** The target's class; `null` — the right answer is none. */
  truth: string | null;
  menuSize: number;
  /** External rows only: the menu-size bucket a fit reweights by. */
  menuBucket?: MenuSizeBucket;
}

export function calibrationKey(stratum: CalibrationStratum, siteKey: string): string {
  return `cal:${stratum}:${siteKey}`;
}

/** `Billing::Invoice#total` → `Billing::Invoice`. */
function ownerClassOf(symbolId: string): string {
  return symbolId.slice(0, Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf(".")));
}

function classMenuOf(site: StaticSiteSampleRow): string[] {
  return orderClassesByNamingPrior(site.receiverText, [...new Set(site.candidates.map(ownerClassOf))]);
}

/**
 * `rows` lowest priority first (as `readStaticSiteSample` returns them). A row
 * may serve several strata; each has its own key.
 */
export function buildCalibrationStrata(
  rows: readonly StaticSiteSampleRow[],
  options: { menuLimit: number; sizes?: Partial<CalibrationStrataSizes> },
): CalibrationItem[] {
  const sizes = { ...DEFAULT_CALIBRATION_STRATA_SIZES, ...options.sizes };
  const ordered = [...rows].sort((a, b) => a.priority - b.priority);
  return [
    ...fullMenuItems(ordered, options.menuLimit, sizes.fullMenu),
    ...blockOneItems(ordered, options.menuLimit, sizes.block1),
    ...externalItems(ordered, sizes.external),
  ];
}

/** Resolved rows with 2..menuLimit classes, round-robin over the receiver kinds. */
function fullMenuItems(rows: readonly StaticSiteSampleRow[], menuLimit: number, size: number): CalibrationItem[] {
  const byKind = new Map<string, CalibrationItem[]>(CALIBRATION_RECEIVER_KINDS.map((k) => [k, []]));
  for (const site of rows) {
    if (site.outcome !== "resolved" || site.menuOverflow || site.targetSymbolId === null) continue;
    const bucket = byKind.get(site.receiverKind);
    if (bucket === undefined) continue;
    const classes = classMenuOf(site);
    if (classes.length < 2 || classes.length > menuLimit) continue;
    bucket.push({
      key: calibrationKey("fullMenu", site.siteKey),
      stratum: "fullMenu",
      site,
      classes,
      truth: ownerClassOf(site.targetSymbolId),
      menuSize: classes.length,
    });
  }
  const buckets = [...byKind.values()];
  const picked: CalibrationItem[] = [];
  for (let i = 0; picked.length < size && buckets.some((b) => b.length > i); i++) {
    for (const bucket of buckets) {
      if (picked.length >= size) break;
      if (i < bucket.length) picked.push(bucket[i]);
    }
  }
  return picked;
}

/** Resolved rows whose receiver name matches a class, overflowing menus first; the menu is the match. */
function blockOneItems(rows: readonly StaticSiteSampleRow[], menuLimit: number, size: number): CalibrationItem[] {
  const items: CalibrationItem[] = [];
  for (const site of [...rows.filter((r) => r.menuOverflow), ...rows.filter((r) => !r.menuOverflow)]) {
    if (items.length >= size) break;
    if (site.outcome !== "resolved" || site.targetSymbolId === null) continue;
    const classes = nameMatchedClasses(site.receiverText, classMenuOf(site)).slice(0, menuLimit);
    if (classes.length === 0) continue;
    const owner = ownerClassOf(site.targetSymbolId);
    items.push({
      key: calibrationKey("block1", site.siteKey),
      stratum: "block1",
      site,
      classes,
      truth: classes.includes(owner) ? owner : null,
      menuSize: classes.length,
    });
  }
  return items;
}

/** External-skipped rows with a fitting, non-empty menu; the truth is none. */
function externalItems(rows: readonly StaticSiteSampleRow[], size: number): CalibrationItem[] {
  const items: CalibrationItem[] = [];
  for (const site of rows) {
    if (items.length >= size) break;
    if (site.outcome !== "externalSkipped" || site.menuOverflow) continue;
    const classes = classMenuOf(site);
    if (classes.length === 0) continue;
    items.push({
      key: calibrationKey("external", site.siteKey),
      stratum: "external",
      site,
      classes,
      truth: null,
      menuSize: classes.length,
      menuBucket: menuSizeBucket(classes.length),
    });
  }
  return items;
}
