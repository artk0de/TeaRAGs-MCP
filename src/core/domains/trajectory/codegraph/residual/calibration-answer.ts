/**
 * What a calibration run hands the threshold fit: one scored answer per
 * question asked over a statically settled site.
 */

export interface CalibrationAnswer {
  /**
   * `fullMenu` — every class defining the member; `block1` — the classes the
   * receiver's name matches; `external` — a site the static resolver put
   * outside the project, asked over its full menu.
   */
  stratum: "fullMenu" | "block1" | "external";
  /** The model's probability of its top answer. */
  p: number;
  top: "class" | "none";
  /** The top answer is the static truth: the target's class, or none when the truth is off the menu. */
  correct: boolean;
  /** Classes on the question's menu. */
  menuSize: number;
}

export type CalibrationStratum = CalibrationAnswer["stratum"];

export type MenuSizeBucket = "1" | "2-4" | "5+";

export function menuSizeBucket(menuSize: number): MenuSizeBucket {
  if (menuSize <= 1) return "1";
  return menuSize <= 4 ? "2-4" : "5+";
}
