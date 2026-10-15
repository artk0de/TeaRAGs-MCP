import { describe, expect, it } from "vitest";

import {
  decorateCallees,
  decorateCallers,
} from "../../../../../src/core/api/internal/ops/declared-visibility-lookup.js";

const NO_LEVELS = { getSymbolVisibilities: async () => [] };

describe("decorated graph responses keep the edge origin", () => {
  it("a caller keeps origin, model and p", async () => {
    const { callers } = await decorateCallers(NO_LEVELS, "Firm#users", [
      {
        sourceSymbolId: "Billing#run",
        sourceRelPath: "a.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);

    expect(callers).toEqual([
      {
        sourceSymbolId: "Billing#run",
        sourceRelPath: "a.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);
  });

  it("a callee keeps origin, model and p", async () => {
    const callees = await decorateCallees(NO_LEVELS, [
      {
        targetSymbolId: "Firm#users",
        targetRelPath: "f.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);

    expect(callees[0]).toMatchObject({ origin: "model", model: "kev", p: 0.9 });
  });
});
