import { describe, expect, it } from "vitest";

import type { StaticSiteSampleRow } from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import { menuSizeBucket } from "../../../../../../src/core/domains/trajectory/codegraph/residual/calibration-answer.js";
import {
  buildCalibrationStrata,
  calibrationKey,
  DEFAULT_CALIBRATION_STRATA_SIZES,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-calibration-strata.js";

let seq = 0;

function row(over: Partial<StaticSiteSampleRow> = {}): StaticSiteSampleRow {
  seq++;
  return {
    siteKey: `site-${seq}`,
    sourceRelPath: "app/a.rb",
    language: "ruby",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText: "record",
    receiverKind: "localVar",
    member: "total",
    outcome: "resolved",
    targetSymbolId: "Invoice#total",
    reason: null,
    owners: 2,
    candidates: ["Estimate#total", "Invoice#total"],
    menuOverflow: false,
    priority: seq / 10_000,
    ...over,
  };
}

const LIMIT = { menuLimit: 40 };

describe("buildCalibrationStrata — full menu", () => {
  it("takes resolved rows with 2..menuLimit classes; truth is the target's owner, menu in name-prior order", () => {
    const site = row({ receiverText: "invoice" });
    const items = buildCalibrationStrata([site], LIMIT).filter((i) => i.stratum === "fullMenu");

    expect(items).toEqual([
      expect.objectContaining({
        key: calibrationKey("fullMenu", site.siteKey),
        classes: ["Invoice", "Estimate"],
        truth: "Invoice",
        menuSize: 2,
      }),
    ]);
  });

  it("skips one-class menus, overflowing menus and external rows", () => {
    const rows = [
      row({ candidates: ["Invoice#total"], owners: 1 }),
      row({ menuOverflow: true, owners: 60 }),
      row({ outcome: "externalSkipped", targetSymbolId: null, reason: "externalSkipped" }),
    ];

    expect(buildCalibrationStrata(rows, LIMIT).filter((i) => i.stratum === "fullMenu")).toEqual([]);
  });

  it("balances receiver kinds evenly and fills a short kind's share from the others", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({ receiverKind: "localVar" })),
      ...Array.from({ length: 10 }, () => row({ receiverKind: "ivar" })),
      ...Array.from({ length: 1 }, () => row({ receiverKind: "chain" })),
      ...Array.from({ length: 10 }, () => row({ receiverKind: "dynamic" })),
    ];

    const items = buildCalibrationStrata(rows, { ...LIMIT, sizes: { fullMenu: 13 } }).filter(
      (i) => i.stratum === "fullMenu",
    );
    const byKind = (kind: string) => items.filter((i) => i.site.receiverKind === kind).length;

    expect(items).toHaveLength(13);
    expect(byKind("chain")).toBe(1);
    expect([byKind("localVar"), byKind("ivar"), byKind("dynamic")]).toEqual([4, 4, 4]);
  });

  it("draws the lowest priorities within a kind", () => {
    const late = row({ priority: 0.9 });
    const early = row({ priority: 0.1 });

    const items = buildCalibrationStrata([late, early], { ...LIMIT, sizes: { fullMenu: 1 } }).filter(
      (i) => i.stratum === "fullMenu",
    );

    expect(items.map((i) => i.site.siteKey)).toEqual([early.siteKey]);
  });
});

describe("buildCalibrationStrata — block 1", () => {
  it("asks the name-matched classes; truth is the owner when on the block", () => {
    const site = row({
      receiverText: "invoice",
      candidates: ["Invoice#total", "ProformaInvoice#total", "Estimate#total"],
      owners: 3,
    });

    const [item] = buildCalibrationStrata([site], LIMIT).filter((i) => i.stratum === "block1");

    expect(item).toMatchObject({
      key: calibrationKey("block1", site.siteKey),
      classes: ["Invoice", "ProformaInvoice"],
      truth: "Invoice",
      menuSize: 2,
    });
  });

  it("an owner off the block makes the truth none", () => {
    const site = row({ receiverText: "invoice", targetSymbolId: "Estimate#total" });

    const [item] = buildCalibrationStrata([site], LIMIT).filter((i) => i.stratum === "block1");

    expect(item).toMatchObject({ classes: ["Invoice"], truth: null });
  });

  it("takes overflowing rows, whose candidates are already the block, ahead of fitting ones", () => {
    const fitting = row({ receiverText: "invoice", priority: 0.01 });
    const overflow = row({
      receiverText: "invoice",
      menuOverflow: true,
      owners: 50,
      candidates: ["Invoice#total"],
      targetSymbolId: "Other#total",
      priority: 0.5,
    });

    const items = buildCalibrationStrata([fitting, overflow], { ...LIMIT, sizes: { block1: 1 } }).filter(
      (i) => i.stratum === "block1",
    );

    expect(items).toEqual([expect.objectContaining({ key: calibrationKey("block1", overflow.siteKey), truth: null })]);
  });

  it("skips rows whose receiver name matches no class", () => {
    expect(
      buildCalibrationStrata([row({ receiverText: "thing" })], LIMIT).filter((i) => i.stratum === "block1"),
    ).toEqual([]);
  });
});

describe("buildCalibrationStrata — external", () => {
  it("asks the full class menu of an external-skipped row; truth none; menu-size bucket", () => {
    const site = row({
      outcome: "externalSkipped",
      targetSymbolId: null,
      reason: "externalSkipped",
      candidates: ["Invoice#total"],
      owners: 1,
    });

    const [item] = buildCalibrationStrata([site], LIMIT).filter((i) => i.stratum === "external");

    expect(item).toMatchObject({
      key: calibrationKey("external", site.siteKey),
      classes: ["Invoice"],
      truth: null,
      menuSize: 1,
      menuBucket: "1",
    });
  });

  it("caps the stratum and skips empty menus", () => {
    const rows = [
      row({ outcome: "externalSkipped", targetSymbolId: null, candidates: [] }),
      ...Array.from({ length: 3 }, () => row({ outcome: "externalSkipped", targetSymbolId: null })),
    ];

    const items = buildCalibrationStrata(rows, { ...LIMIT, sizes: { external: 2 } }).filter(
      (i) => i.stratum === "external",
    );

    expect(items).toHaveLength(2);
  });

  it("buckets menu sizes as 1 / 2-4 / 5+", () => {
    expect([1, 2, 4, 5, 40].map(menuSizeBucket)).toEqual(["1", "2-4", "2-4", "5+", "5+"]);
  });
});

describe("calibration key space", () => {
  it("never collides with a residual site key or a receiver-group question key", () => {
    const key = calibrationKey("fullMenu", "abc");

    expect(key).toBe("cal:fullMenu:abc");
    expect(calibrationKey("block1", "abc")).not.toBe(key);
    expect(/^[0-9a-f]{40}(\/\d+\.\d+)?$/.test(key)).toBe(false);
  });
});

describe("default strata caps", () => {
  it("draws 300 full-menu, 150 block-1 and 400 external questions", () => {
    expect(DEFAULT_CALIBRATION_STRATA_SIZES).toEqual({ fullMenu: 300, block1: 150, external: 400 });
  });
});
