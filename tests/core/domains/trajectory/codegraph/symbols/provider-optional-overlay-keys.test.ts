/**
 * The codegraph provider always writes its WHOLE overlay (bd tea-rags-mcp-k8gac).
 *
 * `codegraph.symbols.{file,chunk}.*` has two writers. `EnrichmentApplier` runs
 * `OmittedOverlayKeyCollector`, so an overlay that omits a key the provider
 * declares optional deletes the stale stored value. `CodegraphPayloadHealer`
 * does not: it rewrites points through raw `batchSetPayload`, which MERGES into
 * the stored object, so an omitted key would keep whatever an earlier run wrote
 * there — the bd tea-rags-mcp-9mwny class of stale payload, on exactly the
 * points no run reaches.
 *
 * That is correct only while this provider declares no `optionalOverlayKeys`.
 * This test makes the declaration fail loudly instead of silently opening the
 * gap: whoever adds one must first make the healer delete the optional keys its
 * rewrite omits, the way the applier does.
 */
import { describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import type { GraphDbClient } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("CodegraphEnrichmentProvider — optional overlay keys", () => {
  it("declares none, because CodegraphPayloadHealer writes its overlays without the omitted-key delete", () => {
    // Read through the contract: the declaration is optional there, absent here.
    const provider: EnrichmentProvider = new CodegraphEnrichmentProvider({
      // Never touched: the declaration is read off the constructed instance.
      graphDb: {} as GraphDbClient,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });

    expect(
      provider.optionalOverlayKeys,
      "codegraph.symbols now declares optionalOverlayKeys, but CodegraphPayloadHealer " +
        "(domains/ingest/pipeline/enrichment/codegraph-payload-heal.ts) rewrites these overlays through raw " +
        "batchSetPayload and never deletes an omitted key — teach it OmittedOverlayKeyCollector first",
    ).toBeUndefined();
  });
});
