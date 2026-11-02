import { afterEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { llamaServerCommand, runLlamaServerChooseModel } from "../../../src/cli/commands/llama-server.js";

async function chooseModelViaCli(shares: string): Promise<Record<string, unknown>> {
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await yargs([])
    .command(llamaServerCommand)
    .exitProcess(false)
    .fail((msg, err) => {
      throw err ?? new Error(msg);
    })
    .parseAsync(["llama-server", "choose-model", "--shares", shares]);
  const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
  stdoutSpy.mockRestore();
  return JSON.parse(printed) as Record<string, unknown>;
}

describe("llama-server choose-model", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['{"ruby":0.06,"typescript":0.94}', "nomic-ai/CodeRankEmbed", 2048, 768],
    ['{"swift":0.5,"python":0.5}', "nomic-ai/CodeRankEmbed", 2048, 768],
    ['{"typescript":0.9,"python":0.1}', "nomic-ai/CodeRankEmbed", 2048, 768],
    ['{"elixir":0.7,"typescript":0.3}', "jinaai/jina-embeddings-v2-base-code", 8192, 768],
  ])("--shares %s → %s", async (shares, model, window, dimensions) => {
    const printed = await chooseModelViaCli(shares);
    expect(printed).toMatchObject({ model, window, dimensions });
    expect(typeof printed.rule).toBe("string");
  });

  it("prints one JSON object with model, rule, window and dimensions", () => {
    const out: string[] = [];
    runLlamaServerChooseModel({ shares: '{"elixir":1}' }, { out: (line) => out.push(line) });
    expect(out).toHaveLength(1);
    expect(Object.keys(JSON.parse(out[0]) as object).sort()).toEqual(["dimensions", "model", "rule", "window"]);
  });

  it("rejects shares that are not a language → fraction object", () => {
    const silent = { out: (): void => undefined };
    expect(() => {
      runLlamaServerChooseModel({ shares: '["ruby"]' }, silent);
    }).toThrow(/--shares/);
    expect(() => {
      runLlamaServerChooseModel({ shares: '{"ruby":"lots"}' }, silent);
    }).toThrow(/--shares/);
  });
});
