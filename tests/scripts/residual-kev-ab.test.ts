import { describe, expect, it } from "vitest";

import { labelTruth, scoreAnswer, summarize } from "../../scripts/residual-kev-ab.js";

const MENU = ["GettingPaid::Bill", "Billing::Invoice", "Client"];

describe("labelTruth + scoreAnswer", () => {
  it("scores a CORRECT label against its truth, or its pick when it names none", () => {
    const truth = labelTruth({ label: "CORRECT", pick: "Client#firm", truth: "Client#firm" });
    const bare = labelTruth({ label: "CORRECT", target: "Client#firm" });

    expect(scoreAnswer(truth, "Client", MENU)).toBe("correct");
    expect(scoreAnswer(bare, "Client", MENU)).toBe("correct");
    expect(scoreAnswer(truth, "Billing::Invoice", MENU)).toBe("wrong");
    expect(scoreAnswer(truth, null, MENU)).toBe("wrong");
  });

  it("reads a WRONG label's truth from its note, and counts the old pick wrong", () => {
    const truth = labelTruth({
      label: "WRONG",
      target: "Billing::Invoice#firm",
      note: "truth: GettingPaid::Bill/ClientInvoice from bills_to_settle; Billing::Invoice is subscription billing",
    });

    expect(scoreAnswer(truth, "GettingPaid::Bill", MENU)).toBe("correct");
    expect(scoreAnswer(truth, "Billing::Invoice", MENU)).toBe("wrong");
  });

  it("expects none for EXTERNAL, an external WRONG and a truth that is off the menu", () => {
    expect(scoreAnswer(labelTruth({ label: "EXTERNAL", truth: "Module#name" }), null, MENU)).toBe("correct");
    const external = labelTruth({
      label: "WRONG",
      pick: "Client#status",
      truth: "generated client response -> EXTERNAL",
    });
    expect(scoreAnswer(external, null, MENU)).toBe("correct");
    expect(scoreAnswer(external, "Client", MENU)).toBe("wrong");
    const offMenu = labelTruth({ label: "PROJECT", pick: null, truth: "TeamManagement::Employee::AccessRights" });
    expect(scoreAnswer(offMenu, null, MENU)).toBe("correct");
  });

  it("scores a pick inside a CORRECT_PARTIAL dispatch set as partial", () => {
    const truth = labelTruth({ label: "CORRECT_PARTIAL", pick: "Employee", truth: "Owner|Employee" });

    expect(scoreAnswer(truth, "Owner", ["Owner", "Employee", "Client"])).toBe("partial");
    expect(scoreAnswer(truth, "Client", ["Owner", "Employee", "Client"])).toBe("wrong");
  });

  it("drops an UNDECIDABLE label and leaves a WRONG with no truth unscorable for a new pick", () => {
    expect(labelTruth({ label: "UNDECIDABLE" })).toBeUndefined();
    const truth = labelTruth({ label: "WRONG", target: "Billing::Invoice#firm", note: "" });
    expect(scoreAnswer(truth, "Client", MENU)).toBe("unscorable");
    expect(scoreAnswer(truth, "Billing::Invoice", MENU)).toBe("wrong");
  });
});

describe("summarize", () => {
  it("counts accuracy over scorable answers, confident shares and mean p by outcome", () => {
    const s = summarize([
      { outcome: "correct", pick: "A", p: 0.9 },
      { outcome: "partial", pick: "B", p: 0.6 },
      { outcome: "wrong", pick: "C", p: 0.5 },
      { outcome: "correct", pick: null, p: 0.85 },
      { outcome: "unscorable", pick: "D", p: 0.99 },
    ]);

    expect(s).toMatchObject({ answered: 5, scorable: 4, correct: 2, partial: 1, wrong: 1 });
    expect(s.accuracy).toBeCloseTo(0.75);
    expect(s.confidentClassShare).toBeCloseTo(2 / 4);
    expect(s.confidentNoneShare).toBeCloseTo(1);
    expect(s.meanPCorrect).toBeCloseTo((0.9 + 0.6 + 0.85) / 3);
    expect(s.meanPWrong).toBeCloseTo(0.5);
  });
});
