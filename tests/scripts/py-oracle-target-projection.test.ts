/**
 * The seam between the oracle's dump row and family attribution
 * (bd tea-rags-mcp-1v12o.1.2, E5.0b step 1).
 *
 * `PyResidualRow` declares `oracleTargetRelPath` / `oracleTargetSymbolId` and
 * the bare-call split is decided by comparing the first against the caller's
 * own file. The host emitted neither, so every bare call compared against
 * `undefined` and landed in `crossFileBareCall`: polar read 0 / 110 where the
 * hand re-tag read 140 / 31.
 *
 * The assertions run END TO END on purpose — build a row, serialise it the way
 * the NDJSON dump does, classify it — because a unit test on either side alone
 * is what let the two shapes drift apart in the first place.
 */
import { describe, expect, it } from "vitest";

import {
  classifyResidualFamily,
  type PyResidualRow,
  type PyResidualSourceView,
} from "../../scripts/lib/py-residual-families.js";
import { buildRows } from "../../scripts/py-codegraph-jedi-oracle.js";
import type { CallContext } from "../../src/core/contracts/types/codegraph.js";

const CALLER = "pkg/a.py";

const site = () =>
  ({
    relPath: CALLER,
    call: { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
    ctx: {} as CallContext,
    receiverKind: "bareCall",
    chain: null,
    answeredBy: "none",
    missBucket: "miss",
  }) as never;

/** One jedi reply for the site, pointing at `target` — or answering nothing. */
const reply = (target: { relPath: string; symbolId: string } | null) =>
  new Map([
    [
      CALLER,
      {
        relPath: CALLER,
        parseFailed: false,
        parsoErrors: 0,
        answers: [
          {
            startLine: 1,
            member: "helper",
            outcome:
              target === null
                ? { kind: "unknown" }
                : { kind: "inProject", origin: "project", targets: [{ ...target, pinUncertain: false }] },
          },
        ],
      },
    ],
  ] as never);

/** Nothing tier 2 can read — a bare call is decided at tier 1 or not at all. */
const blindView: PyResidualSourceView = {
  importBindings: () => new Set(),
  bindingLine: () => null,
  typeVarNames: () => new Set(),
  enclosingReturnAnnotation: () => null,
  enclosingDefParams: () => new Set(),
  isProtocolClass: () => false,
  isProjectFixture: () => false,
};

/** A row through the NDJSON round trip the family report actually reads. */
function dumped(target: { relPath: string; symbolId: string } | null): PyResidualRow {
  const row = buildRows([site()], reply(target))[0];
  return JSON.parse(JSON.stringify(row)) as PyResidualRow;
}

describe("oracle target projection", () => {
  it("carries the oracle's own target on the dump row, flat, under the names attribution reads", () => {
    const row = dumped({ relPath: "pkg/b.py", symbolId: "helper" });
    expect(row.oracleTargetRelPath).toBe("pkg/b.py");
    expect(row.oracleTargetSymbolId).toBe("helper");
  });

  it("spells an unanswered site as null rather than dropping the keys", () => {
    const row = dumped(null);
    expect(row.oracleTargetRelPath).toBeNull();
    expect(row.oracleTargetSymbolId).toBeNull();
  });

  it("tags a bare call the oracle answered inside the caller's file sameFileBareCall", () => {
    const row = dumped({ relPath: CALLER, symbolId: "helper" });
    expect(classifyResidualFamily(row, blindView).family).toBe("sameFileBareCall");
  });

  it("tags a bare call answered in another file crossFileBareCall", () => {
    const row = dumped({ relPath: "pkg/b.py", symbolId: "helper" });
    expect(classifyResidualFamily(row, blindView).family).toBe("crossFileBareCall");
  });

  it("keeps a bare call with no oracle target in crossFileBareCall, the classifier's no-target family", () => {
    const row = dumped(null);
    expect(classifyResidualFamily(row, blindView).family).toBe("crossFileBareCall");
  });
});
