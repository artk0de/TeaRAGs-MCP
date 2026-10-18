import { describe, expect, it } from "vitest";

import type {
  CallRef,
  FileExtraction,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import {
  STATIC_SAMPLE_ADMIT,
  staticSamplePriority,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const DEFS: SymbolDefinition[] = ["Firm", "Team"].map((owner) => ({
  symbolId: `${owner}#users`,
  fqName: `${owner}#users`,
  shortName: "users",
  relPath: `app/models/${owner.toLowerCase()}.rb`,
  scope: [owner],
}));
const TABLE = {
  lookup: () => [],
  lookupByShortName: (name: string) => DEFS.filter((d) => d.shortName === name),
} as unknown as GlobalSymbolTable;

const CALLS: CallRef[] = Array.from({ length: 40 }, (_, i) => ({
  callText: "account.users",
  receiver: "account",
  member: "users",
  startLine: 100 + i,
  startColumn: 4,
}));
const EXTRACTION: FileExtraction = {
  relPath: "app/services/billing.rb",
  language: "ruby",
  imports: [],
  fileScope: [],
  chunks: [{ symbolId: "Billing#run", scope: ["Billing"], startLine: 99, endLine: 150, calls: CALLS }],
};

describe("CallEdgeResolutionRunner.resolve — static site sample", () => {
  it("attaches the external-skipped sites whose priority the admission rate keeps", () => {
    const resolver = { resolve: () => null, targetsExternalImport: () => true };
    const factory = {
      supported: () => ["ruby"],
      create: () => ({ resolver }),
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(factory, new CodegraphRunState());

    const edges = runner.resolve(EXTRACTION, TABLE);

    const sample = edges.staticSiteSample ?? [];
    expect(sample.length).toBeGreaterThan(0);
    expect(sample.length).toBeLessThan(CALLS.length);
    expect(sample.every((r) => r.outcome === "externalSkipped" && r.priority < STATIC_SAMPLE_ADMIT)).toBe(true);
    expect(sample.every((r) => staticSamplePriority(r.siteKey) === r.priority)).toBe(true);
    expect(sample[0]).toMatchObject({ candidates: ["Firm#users", "Team#users"], owners: 2, language: "ruby" });
  });
});
