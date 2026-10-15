import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildRustSourceInventory, type RustInventoryCfg } from "../../scripts/lib/rust-codegraph-inventory.js";
import { collectRustOracleObservations, type RustOracleRpc } from "../../scripts/lib/rust-codegraph-oracle-session.js";
import { normalizeRustOracleEvidence } from "../../scripts/lib/rust-codegraph-oracle.js";

const corpusRoot = process.cwd();
const sourcePath = "src/main.rs";
const targetPath = "src/target.rs";
type CfgStatus = RustInventoryCfg["status"];

async function collectEvidence(
  sourceCfg: CfgStatus,
  targetCfg: CfgStatus,
  includeLiveSibling = false,
  unresolvedIdentity = false,
) {
  const source =
    sourceCfg === "unconditional"
      ? "fn run() { target(); }"
      : '#[cfg(feature = "x")] mod gated { fn run() { target(); } }';
  const target = unresolvedIdentity
    ? "trait Trait { fn target(&self); } struct Engine; impl Trait for Engine { fn target(&self) {} }"
    : (targetCfg === "unconditional" ? "fn target() {}" : '#[cfg(feature = "x")] fn target() {}') +
      (includeLiveSibling ? " fn live() {}" : "");
  const cfgPolicy = (status: CfgStatus) => (status === "active" || status === "inactive" ? () => status : undefined);
  const sourceInventory = buildRustSourceInventory({
    source,
    relPath: sourcePath,
    workspaceRoot: corpusRoot,
    cfgPolicy: cfgPolicy(sourceCfg),
  });
  const targetInventory = buildRustSourceInventory({
    source: target,
    relPath: targetPath,
    workspaceRoot: corpusRoot,
    cfgPolicy: cfgPolicy(targetCfg),
  });
  expect(sourceInventory.parseErrors).toEqual([]);
  expect(targetInventory.parseErrors).toEqual([]);
  const sourceSite = sourceInventory.sites[0];
  const targetSymbol = unresolvedIdentity ? targetInventory.symbols.at(-1)! : targetInventory.symbols[0];
  if (unresolvedIdentity) expect(targetSymbol.symbolId).toBeNull();
  expect(sourceSite.cfg.status).toBe(sourceCfg);
  expect(targetSymbol.cfg.status).toBe(targetCfg);
  const rpc: RustOracleRpc = {
    request: vi.fn(async (method) => {
      if (method === "initialize") return { capabilities: { definitionProvider: true, positionEncoding: "utf-16" } };
      if (method === "textDocument/definition") {
        return { uri: targetSymbol.uri, range: targetSymbol.selectionRange };
      }
      return null;
    }),
    notify: vi.fn(),
    kill: vi.fn(),
  };
  const session = await collectRustOracleObservations({
    corpusRoot,
    executable: "/explicit/pinned/rust-analyzer",
    sites: [{ ...sourceSite, dispatch: "concrete", complete: true }],
    readSource: vi.fn(async (path) => (path === resolve(corpusRoot, sourcePath) ? source : target)),
    createClient: () => rpc,
  });
  expect(session.status).toBe("ok");
  expect(session.observations).toHaveLength(1);
  expect(session.observations[0].response.kind).toBe("success");
  const symbols = targetInventory.symbols
    .filter((symbol): symbol is typeof symbol & { symbolId: string } => symbol.symbolId !== null && !unresolvedIdentity)
    .map((symbol) => ({
      uri: symbol.uri,
      symbolId: symbol.symbolId,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      provenance: symbol.provenance,
      cfgStatus: symbol.cfg.status,
      declarationOnly: symbol.declarationOnly,
      traitDeclaration: symbol.traitDeclaration,
    }));
  return normalizeRustOracleEvidence({
    provenance: {
      workspaceRoot: corpusRoot,
      firstPartyRoots: [resolve(corpusRoot, "src")],
      workspaceRevision: "pinned-commit",
      configurationDigest: "cfg-sha256",
      toolchain: "rustc pinned",
      rustAnalyzerVersion: "rust-analyzer pinned",
      inventoryRevision: "independent-source-inventory-v1",
    },
    symbols,
    observations: session.observations,
  }).sites[0];
}

describe("Rust cfg evidence from inventory through injected session and adapter", () => {
  it.each([
    ["unknown", "unknown"],
    ["unknown", "unconditional"],
    ["unconditional", "unknown"],
  ] as const)("withholds uncertain source %s and target %s", async (sourceCfg, targetCfg) => {
    const evidence = await collectEvidence(sourceCfg, targetCfg);
    expect(evidence).toMatchObject({
      site: { cfgStatus: sourceCfg },
      kind: "unknown",
      complete: false,
      reasons: ["cfgUnknown"],
      targets: [{ symbolId: "target", cfgStatus: targetCfg }],
    });
  });

  it.each([
    ["inactive", "unconditional"],
    ["unconditional", "inactive"],
  ] as const)("withholds known inactive source %s and target %s", async (sourceCfg, targetCfg) => {
    const evidence = await collectEvidence(sourceCfg, targetCfg);
    expect(evidence).toMatchObject({
      site: { cfgStatus: sourceCfg },
      kind: "unknown",
      complete: false,
      reasons: ["inactiveCfg"],
      targets: [{ symbolId: "target", cfgStatus: targetCfg }],
    });
  });

  it("keeps an inactive target unknown when its file also contains a live sibling", async () => {
    const evidence = await collectEvidence("unconditional", "inactive", true);
    expect(evidence).toMatchObject({
      kind: "unknown",
      complete: false,
      reasons: ["inactiveCfg"],
      targets: [{ symbolId: "target", cfgStatus: "inactive" }],
    });
  });

  it("does not promote a syntax-only candidate identity into an exact oracle target", async () => {
    const evidence = await collectEvidence("unconditional", "unconditional", false, true);
    expect(evidence).toMatchObject({
      kind: "unknown",
      complete: false,
      reasons: ["unmappedTarget"],
      targets: [{ symbolId: null, cfgStatus: null }],
    });
  });

  it.each([
    ["unconditional", "unconditional"],
    ["active", "unconditional"],
    ["unconditional", "active"],
    ["active", "active"],
  ] as const)("accepts proven source %s and target %s", async (sourceCfg, targetCfg) => {
    const evidence = await collectEvidence(sourceCfg, targetCfg);
    expect(evidence).toMatchObject({
      site: { cfgStatus: sourceCfg },
      kind: "inProject",
      complete: true,
      reasons: [],
      targets: [{ symbolId: "target", cfgStatus: targetCfg }],
    });
  });
});
