import { describe, expect, it } from "vitest";

import {
  normalizeRustOracleEvidence,
  type RustOracleInput,
  type RustOracleObservation,
  type RustOracleRange,
  type RustOracleSourceSite,
  type RustOracleSymbol,
} from "../../scripts/lib/rust-codegraph-oracle.js";

const range = (line: number, start: number, end: number): RustOracleRange => ({
  start: { line, character: start },
  end: { line, character: end },
});
const site = (start = 2): RustOracleSourceSite => ({
  relPath: "src/main.rs",
  expressionRange: range(3, start, start + 8),
  tokenRange: range(3, start, start + 3),
  provenance: "source",
  cfgStatus: "unconditional",
  dispatch: "concrete",
});
const symbol = (symbolId = "helper", start = 0): RustOracleSymbol => ({
  uri: "file:///repo/src/helper.rs",
  symbolId,
  range: range(10, start, start + 20),
  selectionRange: range(10, start + 3, start + 9),
  provenance: "source",
  cfgStatus: "unconditional",
  declarationOnly: false,
  traitDeclaration: false,
});
const observation = (overrides: Partial<RustOracleObservation> = {}): RustOracleObservation => ({
  site: site(),
  response: { kind: "success", value: { uri: symbol().uri, range: symbol().selectionRange } },
  complete: true,
  ...overrides,
});
const input = (observations = [observation()], symbols = [symbol()]): RustOracleInput => ({
  provenance: {
    workspaceRoot: "/repo",
    firstPartyRoots: ["/repo/src"],
    workspaceRevision: "pinned-commit",
    configurationDigest: "cfg-sha256",
    toolchain: "rustc 1.90.0 (pinned)",
    rustAnalyzerVersion: "rust-analyzer pinned-build",
    inventoryRevision: "independent-source-inventory-v1",
  },
  symbols,
  observations,
});
const first = (value = input()) => normalizeRustOracleEvidence(value).sites[0];

// Coordinates are supplied UTF-16 offsets, never inferred from source text.
describe("normalizeRustOracleEvidence", () => {
  it("has a pinned fixture with distinct expression and token ranges", () => {
    expect(input().provenance.workspaceRevision).toBe("pinned-commit");
    expect(site().expressionRange).not.toEqual(site().tokenRange);
  });

  it("maps a definition through the independent inventory and carries pinned provenance", () => {
    const result = normalizeRustOracleEvidence(input());
    expect(result.provenance).toEqual(input().provenance);
    expect(result.sites[0]).toMatchObject({
      site: { cfgStatus: "unconditional" },
      kind: "inProject",
      complete: true,
      reasons: [],
      targets: [{ symbolId: "helper", relPath: "src/helper.rs", cfgStatus: "unconditional" }],
    });
  });

  it.each(["unknown", "inactive"] as const)("withholds %s source cfg even with a complete definition", (cfgStatus) => {
    expect(first(input([observation({ site: { ...site(), cfgStatus } })]))).toMatchObject({
      site: { cfgStatus },
      kind: "unknown",
      complete: false,
      reasons: [cfgStatus === "unknown" ? "cfgUnknown" : "inactiveCfg"],
      targets: [{ symbolId: "helper", cfgStatus: "unconditional" }],
    });
  });

  it.each(["unknown", "inactive"] as const)("withholds %s cfg on a matched target", (cfgStatus) => {
    const target = { ...symbol(), cfgStatus };
    expect(first(input([observation()], [target]))).toMatchObject({
      site: { cfgStatus: "unconditional" },
      kind: "unknown",
      complete: false,
      reasons: [cfgStatus === "unknown" ? "cfgUnknown" : "inactiveCfg"],
      targets: [{ symbolId: "helper", cfgStatus }],
    });
  });

  it.each(["unconditional", "active"] as const)("accepts proven %s cfg on both ends", (cfgStatus) => {
    expect(first(input([observation({ site: { ...site(), cfgStatus } })], [{ ...symbol(), cfgStatus }]))).toMatchObject(
      {
        site: { cfgStatus },
        kind: "inProject",
        complete: true,
        reasons: [],
        targets: [{ symbolId: "helper", cfgStatus }],
      },
    );
  });

  it("does not let an unknown cfg symbol taint an unconditional sibling in the same file", () => {
    const conditional = { ...symbol("conditional", 30), cfgStatus: "unknown" as const };
    expect(first(input([observation()], [symbol(), conditional]))).toMatchObject({
      kind: "inProject",
      complete: true,
      reasons: [],
      targets: [{ symbolId: "helper", cfgStatus: "unconditional" }],
    });
  });

  it("keeps a proven inactive sibling local, even when inventory marks its provenance inactiveCfg", () => {
    const inactive = { ...symbol("inactive", 30), cfgStatus: "inactive" as const, provenance: "inactiveCfg" as const };
    expect(first(input([observation()], [inactive, symbol()]))).toMatchObject({
      kind: "inProject",
      complete: true,
      reasons: [],
      targets: [{ symbolId: "helper", cfgStatus: "unconditional" }],
    });
    expect(
      first(
        input(
          [
            observation({
              response: { kind: "success", value: { uri: inactive.uri, range: inactive.selectionRange } },
            }),
          ],
          [symbol(), inactive],
        ),
      ),
    ).toMatchObject({ kind: "unknown", complete: false, reasons: ["inactiveCfg"] });
  });

  it("preserves cfg status after deduplicating matching inventory symbols", () => {
    const conditional = { ...symbol(), cfgStatus: "unknown" as const };
    expect(first(input([observation()], [conditional, conditional]))).toMatchObject({
      kind: "unknown",
      reasons: ["cfgUnknown"],
      targets: [{ symbolId: "helper", cfgStatus: "unknown" }],
    });
  });

  it("rejects contradictory cfg status for a duplicate inventory symbol", () => {
    expect(() => first(input([observation()], [symbol(), { ...symbol(), cfgStatus: "unknown" }]))).toThrow(
      /contradictory symbol/,
    );
  });

  it.each(["source", "target"] as const)("fails closed on missing %s cfg status", (where) => {
    const value = input();
    if (where === "source") delete (value.observations[0].site as Partial<RustOracleSourceSite>).cfgStatus;
    else delete (value.symbols[0] as Partial<RustOracleSymbol>).cfgStatus;
    expect(() => normalizeRustOracleEvidence(value)).toThrow(/cfg status|classification|inventory/);
  });

  it.each(["source", "target"] as const)("fails closed on invalid %s cfg status", (where) => {
    const value = input();
    if (where === "source") (value.observations[0].site as { cfgStatus: string }).cfgStatus = "enabled";
    else (value.symbols[0] as { cfgStatus: string }).cfgStatus = "enabled";
    expect(() => normalizeRustOracleEvidence(value)).toThrow(/cfg status|classification|inventory/);
  });

  it("keeps same-line sites separate in coordinate order", () => {
    const result = normalizeRustOracleEvidence(input([observation({ site: site(20) }), observation()]));
    expect(result.sites.map((row) => row.site.tokenRange)).toEqual([site().tokenRange, site(20).tokenRange]);
  });

  it("preserves supplied Unicode UTF-16 offsets without recomputing columns", () => {
    const unicodeSite = { ...site(), expressionRange: range(3, 7, 17), tokenRange: range(3, 9, 15) };
    expect(first(input([observation({ site: unicodeSite })])).site).toEqual(unicodeSite);
  });

  it("maps a LocationLink using targetSelectionRange, not the declaration envelope", () => {
    const target = symbol();
    expect(
      first(
        input([
          observation({
            response: {
              kind: "success",
              value: [
                {
                  targetUri: target.uri,
                  targetRange: target.range,
                  targetSelectionRange: target.selectionRange,
                  originSelectionRange: site().tokenRange,
                },
              ],
            },
          }),
        ]),
      ),
    ).toMatchObject({ kind: "inProject", targets: [{ symbolId: "helper", selectionRange: target.selectionRange }] });
  });

  it.each([
    null,
    [],
    {},
    { uri: "untitled:buffer", range: range(0, 0, 1) },
    { uri: "file:///repo/src/helper.rs", range: range(0, -1, 1) },
  ])("withholds empty or malformed LSP responses (%j)", (value) => {
    expect(first(input([observation({ response: { kind: "success", value } })]))).toMatchObject({
      kind: "unknown",
      complete: false,
    });
  });

  it.each(["timeout", "error"] as const)("keeps a %s unknown, never external", (kind) => {
    expect(first(input([observation({ response: { kind } })]))).toMatchObject({ kind: "unknown", reasons: [kind] });
  });

  it("requires explicit completeness for known project definitions", () => {
    expect(first(input([observation({ complete: false })]))).toMatchObject({
      kind: "unknown",
      complete: false,
      reasons: ["incompleteDefinitions"],
      targets: [{ symbolId: "helper" }],
    });
  });

  it("returns all known project definitions as a sorted, deduplicated complete set", () => {
    const other = symbol("other", 30);
    const value = [other, symbol(), other].map((target) => ({ uri: target.uri, range: target.selectionRange }));
    expect(first(input([observation({ response: { kind: "success", value } })], [other, symbol()]))).toMatchObject({
      kind: "inProject",
      complete: true,
      targets: [{ symbolId: "helper" }, { symbolId: "other" }],
    });
  });

  it("withholds a partially mapped multi-target answer", () => {
    const value = [
      { uri: symbol().uri, range: symbol().selectionRange },
      { uri: symbol().uri, range: range(50, 0, 4) },
    ];
    expect(first(input([observation({ response: { kind: "success", value } })]))).toMatchObject({
      kind: "unknown",
      complete: false,
      reasons: ["unmappedTarget"],
    });
  });

  it("withholds ambiguous inventory ranges instead of picking the first", () => {
    expect(first(input([observation()], [symbol(), symbol("another")]))).toMatchObject({
      kind: "unknown",
      reasons: ["ambiguousTarget"],
    });
  });

  it.each(["file:///repo-other/lib.rs", "file:///cargo/registry/lib.rs", "file:///repo/vendor/lib.rs"])(
    "requires an explicit outside-root location to call %s external",
    (uri) => {
      expect(
        first(input([observation({ response: { kind: "success", value: { uri, range: range(1, 0, 3) } } })])),
      ).toMatchObject({ kind: "external", complete: true, targets: [{ symbolId: null }] });
    },
  );

  it("withholds mixed project and external definitions", () => {
    const value = [
      { uri: symbol().uri, range: symbol().selectionRange },
      { uri: "file:///cargo/lib.rs", range: range(1, 0, 3) },
    ];
    expect(first(input([observation({ response: { kind: "success", value } })]))).toMatchObject({
      kind: "unknown",
      reasons: ["mixedOrigins"],
    });
  });

  it("decodes file URLs before inventory matching", () => {
    const target = { ...symbol(), uri: "file:///repo/src/a%20b.rs" };
    expect(
      first(
        input(
          [observation({ response: { kind: "success", value: { uri: target.uri, range: target.selectionRange } } })],
          [target],
        ),
      ),
    ).toMatchObject({ kind: "inProject", targets: [{ relPath: "src/a b.rs" }] });
  });

  it.each(["file:///repo/src/../escape.rs", "file:///repo/src/%2e%2e/escape.rs", "file:///repo/src/a%2Fb.rs"])(
    "withholds URI traversal or encoded separators (%s)",
    (uri) => {
      expect(
        first(input([observation({ response: { kind: "success", value: { uri, range: range(1, 0, 3) } } })])),
      ).toMatchObject({ kind: "unknown", reasons: ["invalidResponse"] });
    },
  );

  it.each(["../src/main.rs", "/repo/src/main.rs", "src/../main.rs"])(
    "rejects a non-canonical source path (%s)",
    (relPath) => {
      expect(() => first(input([observation({ site: { ...site(), relPath } })]))).toThrow(/source path/);
    },
  );

  it("rejects sites outside first-party roots", () => {
    expect(() => first(input([observation({ site: { ...site(), relPath: "vendor/main.rs" } })]))).toThrow(
      /first-party/,
    );
  });

  it("rejects missing pinned provenance", () => {
    const value = input();
    value.provenance.configurationDigest = "";
    expect(() => normalizeRustOracleEvidence(value)).toThrow(/provenance/);
  });

  it("rejects token ranges outside the expression", () => {
    expect(() => first(input([observation({ site: { ...site(), tokenRange: range(3, 50, 55) } })]))).toThrow(
      /token range/,
    );
  });

  it("withholds declaration-only trait answers, never inferring runtime implementations", () => {
    const target = { ...symbol(), declarationOnly: true, traitDeclaration: true };
    expect(first(input([observation({ site: { ...site(), dispatch: "trait" } })], [target]))).toMatchObject({
      kind: "unknown",
      complete: false,
      reasons: ["declarationOnly", "traitUncertainty"],
      targets: [{ symbolId: "helper", declarationOnly: true, traitDeclaration: true }],
    });
  });

  it("withholds trait dispatch even when goto-definition names a concrete body", () => {
    expect(first(input([observation({ site: { ...site(), dispatch: "trait" } })]))).toMatchObject({
      kind: "unknown",
      reasons: ["traitUncertainty"],
    });
  });

  it.each(["generated", "inactiveCfg"] as const)("withholds %s source sites", (provenance) => {
    expect(first(input([observation({ site: { ...site(), provenance } })]))).toMatchObject({
      kind: "unknown",
      reasons: [provenance],
    });
  });

  it.each(["generated", "inactiveCfg"] as const)(
    "withholds %s targets even outside first-party roots",
    (provenance) => {
      const target = { ...symbol(), uri: "file:///repo/target/generated.rs", provenance };
      expect(
        first(
          input(
            [observation({ response: { kind: "success", value: { uri: target.uri, range: target.selectionRange } } })],
            [target],
          ),
        ),
      ).toMatchObject({ kind: "unknown", reasons: [provenance] });
    },
  );

  it("deduplicates equivalent sites, inventory symbols and Location/LocationLink answers", () => {
    const target = symbol();
    const link = observation({
      response: {
        kind: "success",
        value: [{ targetUri: target.uri, targetRange: target.range, targetSelectionRange: target.selectionRange }],
      },
    });
    const result = normalizeRustOracleEvidence(input([link, observation(), link], [target, target]));
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].targets).toHaveLength(1);
    expect(result.sites[0].kind).toBe("inProject");
  });

  it("rejects contradictory site classifications", () => {
    expect(() =>
      normalizeRustOracleEvidence(
        input([observation(), observation({ site: { ...site(), provenance: "generated" } })]),
      ),
    ).toThrow(/contradictory site/);
  });

  it("rejects contradictory duplicate-site answers", () => {
    expect(() =>
      normalizeRustOracleEvidence(input([observation(), observation({ response: { kind: "success", value: null } })])),
    ).toThrow(/contradictory site/);
  });

  it("normalizes duplicate coordinates independently of object property order", () => {
    const reordered = { end: { character: 10, line: 3 }, start: { character: 2, line: 3 } };
    const result = normalizeRustOracleEvidence(
      input([observation(), observation({ site: { ...site(), expressionRange: reordered } })]),
    );
    expect(result.sites).toHaveLength(1);
  });

  it("does not accept a relative file URI as explicit external evidence", () => {
    expect(
      first(
        input([
          observation({ response: { kind: "success", value: { uri: "file:relative.rs", range: range(1, 0, 3) } } }),
        ]),
      ),
    ).toMatchObject({ kind: "unknown", reasons: ["invalidResponse"] });
  });

  it("maps an LSP zero-width definition position within an independent symbol selection", () => {
    const point = { start: { line: 10, character: 4 }, end: { line: 10, character: 4 } };
    expect(
      first(input([observation({ response: { kind: "success", value: { uri: symbol().uri, range: point } } })])),
    ).toMatchObject({ kind: "inProject", targets: [{ symbolId: "helper" }] });
  });

  it("withholds a LocationLink whose origin does not correspond to the queried source token", () => {
    const target = symbol();
    const value = [
      {
        targetUri: target.uri,
        targetRange: target.range,
        targetSelectionRange: target.selectionRange,
        originSelectionRange: range(99, 2, 5),
      },
    ];
    expect(first(input([observation({ response: { kind: "success", value } })]))).toMatchObject({
      kind: "unknown",
      reasons: ["invalidResponse"],
    });
  });

  it("does not match a zero-width target at a symbol's exclusive end", () => {
    const point = { start: { line: 10, character: 9 }, end: { line: 10, character: 9 } };
    expect(
      first(input([observation({ response: { kind: "success", value: { uri: symbol().uri, range: point } } })])),
    ).toMatchObject({ kind: "unknown", reasons: ["unmappedTarget"] });
  });

  it.each(["generated", "inactiveCfg"] as const)(
    "withholds unmapped targets in a known %s URI outside first-party roots",
    (provenance) => {
      const target = { ...symbol(), uri: "file:///repo/target/generated.rs", provenance };
      expect(
        first(
          input(
            [observation({ response: { kind: "success", value: { uri: target.uri, range: range(11, 0, 4) } } })],
            [target],
          ),
        ),
      ).toMatchObject({ kind: "unknown", reasons: [provenance] });
    },
  );

  it("rejects contradictory per-URI provenance even across different symbol ranges", () => {
    const generated = { ...symbol("generated", 30), provenance: "generated" as const };
    expect(() => first(input([observation()], [symbol(), generated]))).toThrow(/contradictory.*provenance/);
  });

  it.each(["expressionRange", "tokenRange"] as const)(
    "rejects an empty source %s rather than treating it as a target position",
    (field) => {
      const point = { start: { line: 3, character: 10 }, end: { line: 3, character: 10 } };
      expect(() => first(input([observation({ site: { ...site(), [field]: point } })]))).toThrow(/source token range/);
    },
  );

  it("rejects contradictory inventory provenance", () => {
    expect(() => first(input([observation()], [symbol(), { ...symbol(), provenance: "generated" }]))).toThrow(
      /contradictory symbol/,
    );
  });
});
