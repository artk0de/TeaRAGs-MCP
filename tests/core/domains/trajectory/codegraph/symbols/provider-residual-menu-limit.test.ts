import { describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import type * as ResolutionRunnerTypes from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type ResolutionRunnerModule = typeof ResolutionRunnerTypes;

const runnerArgs = vi.hoisted(() => [] as unknown[][]);

vi.mock(
  "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js",
  async (importOriginal) => {
    const actual = await importOriginal<ResolutionRunnerModule>();
    class RecordingRunner extends actual.CallEdgeResolutionRunner {
      constructor(...args: ConstructorParameters<typeof actual.CallEdgeResolutionRunner>) {
        super(...args);
        runnerArgs.push(args);
      }
    }
    return { ...actual, CallEdgeResolutionRunner: RecordingRunner };
  },
);

const build = (residualMenuLimit?: number): CodegraphEnrichmentProvider =>
  new CodegraphEnrichmentProvider({
    graphDb: {} as never,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
    ...(residualMenuLimit !== undefined ? { residualMenuLimit } : {}),
  });

describe("CodegraphEnrichmentProvider — residual menu limit seam", () => {
  it("hands CODEGRAPH_RESIDUAL_MENU_LIMIT to the call-edge resolution runner", () => {
    runnerArgs.length = 0;
    build(12);

    expect(runnerArgs).toHaveLength(1);
    expect(runnerArgs[0][2]).toBe(12);
  });

  it("leaves the runner on its own default when no limit is configured", () => {
    runnerArgs.length = 0;
    build();

    expect(runnerArgs[0][2]).toBeUndefined();
  });
});
