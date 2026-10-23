import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import type { PresetDescriptors } from "../../../src/core/api/public/dto/explore.js";
import type { App } from "../../../src/core/api/public/index.js";
import { renderLanguageCapabilityGuide } from "../../../src/core/domains/language/capability/rule.js";
import { nativeLanguageCapabilities } from "../../../src/core/domains/language/index.js";
import { AGENT_CONTEXT_CORE, AGENT_CONTEXT_GUIDES } from "../../../src/mcp/resources/generated/agent-context.js";
import { registerAllResources } from "../../../src/mcp/resources/index.js";

const descriptors: PresetDescriptors = {
  presetNames: { semantic_search: ["relevance"] },
  presetDetails: {
    semantic_search: [
      { name: "relevance", description: "Pure similarity", weights: ["similarity"], tools: ["semantic_search"] },
    ],
  },
  signalDescriptors: [{ name: "similarity", description: "Semantic similarity score" }],
  payloadSignals: [
    {
      key: "git.file.commitCount",
      type: "number",
      description: "Total commits touching this file",
      treeDependence: "history-only",
      stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
    },
  ],
};

const collections = Array.from({ length: 46 }, (_, i) => `code_${i}`);

function stubApp(): App {
  return {
    getSchemaDescriptors: () => descriptors,
    listCollections: async () => Promise.resolve(collections),
    getCollectionInfo: async (name: string) => Promise.resolve({ name, vectorSize: 768 }),
    renderLanguageCapabilityGuide: () => renderLanguageCapabilityGuide(nativeLanguageCapabilities()),
  } as unknown as App;
}

async function textOf(session: InProcessToolSession, uri: string): Promise<string> {
  const { contents } = await session.readResource(uri);
  const [first] = contents;
  return "text" in first ? first.text : "";
}

describe("tea-rags://guide/* resources", () => {
  let session: InProcessToolSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  async function connect(): Promise<InProcessToolSession> {
    const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
    registerAllResources(server, stubApp());
    session = await connectInProcessClient(server);
    return session;
  }

  it("lists at most 20 resources and no per-collection entry", async () => {
    const resources = await (await connect()).listResources();
    expect(resources.length).toBeLessThanOrEqual(20);
    expect(resources.filter((r) => r.uri.startsWith("qdrant://collection/"))).toEqual([]);
  });

  it("registers every builder-backed guide", async () => {
    const uris = (await (await connect()).listResources()).map((r) => r.uri);
    for (const topic of [
      "overview",
      "presets",
      "signals",
      "filters",
      "search-examples",
      "indexing",
      "signal-labels",
      "language-capability",
    ]) {
      expect(uris).toContain(`tea-rags://guide/${topic}`);
    }
  });

  it("keeps each schema/* URI as a deprecated alias serving the guide's text", async () => {
    const s = await connect();
    const aliases: Record<string, string> = {
      overview: "overview",
      presets: "presets",
      signals: "signals",
      filters: "filters",
      "search-guide": "search-examples",
      "indexing-guide": "indexing",
      "signal-labels": "signal-labels",
    };
    const listed = await s.listResources();
    for (const [schema, guide] of Object.entries(aliases)) {
      expect(await textOf(s, `tea-rags://schema/${schema}`)).toBe(await textOf(s, `tea-rags://guide/${guide}`));
      const entry = listed.find((r) => r.uri === `tea-rags://schema/${schema}`);
      expect(entry?.description).toMatch(new RegExp(`^Deprecated alias of tea-rags://guide/${guide}\\.`));
    }
  });

  it("serves the language-capability matrix without the human-only section", async () => {
    const text = await textOf(await connect(), "tea-rags://guide/language-capability");
    expect(text).toContain("## Matrix");
    expect(text).not.toContain("For humans");
  });

  it("registers guide/core only when the generated core is non-empty, and one guide per generated key", async () => {
    const uris = (await (await connect()).listResources()).map((r) => r.uri);
    expect(uris.includes("tea-rags://guide/core")).toBe(AGENT_CONTEXT_CORE.length > 0);
    for (const key of Object.keys(AGENT_CONTEXT_GUIDES)) {
      expect(uris).toContain(`tea-rags://guide/${key}`);
    }
  });

  it("still reads a collection through the qdrant://collection/{name} template", async () => {
    const text = await textOf(await connect(), "qdrant://collection/code_3");
    expect(JSON.parse(text)).toEqual({ name: "code_3", vectorSize: 768 });
  });
});
