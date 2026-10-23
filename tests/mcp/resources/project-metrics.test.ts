import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { registerAllResources } from "../../../src/mcp/resources/index.js";
import { formatProjectMetrics } from "../../../src/mcp/resources/project/metrics.js";
import { fixtureApp, fixtureData } from "./project/fixture.js";

describe("formatProjectMetrics", () => {
  it("renders one language's thresholds table within the metrics budget", () => {
    const out = formatProjectMetrics(fixtureData(), { language: "ruby", section: ["thresholds"] });

    expect(out).toContain("## Signal thresholds — ruby");
    expect(out).toContain("| signal | bands | source ≥ | test ≥ |");
    expect(out).not.toContain("typescript");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(5000);
  });

  it("renders every primary language's thresholds when no language is named", () => {
    const out = formatProjectMetrics(fixtureData(), { section: ["thresholds"] });

    for (const language of ["ruby", "typescript", "python", "go"]) {
      expect(out).toContain(`## Signal thresholds — ${language}`);
    }
  });

  it("renders the lossless labelMap form per signal", () => {
    const out = formatProjectMetrics(fixtureData(), { language: "ruby", section: ["labelMap"] });

    expect(out).toContain("## Label maps — ruby");
    expect(out).toContain("git.file.commitCount: source low <2 / typical ≥2 / high ≥7 / extreme ≥21");
  });

  it("renders the registry params line", () => {
    const out = formatProjectMetrics(fixtureData(), { section: ["registry"] });

    expect(out).toContain("registry: codegraph on · TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS=12");
  });

  it("renders capability and resolve rates for the named language", () => {
    const out = formatProjectMetrics(fixtureData(), { language: "ruby", section: ["capability", "resolve"] });

    expect(out).toContain("ruby: ast full · tests high · codegraph high · resolve 0.9");
    expect(out).toContain("resolve rate: ruby 0.9");
  });

  it("says when a named language has no thresholds bucket", () => {
    const out = formatProjectMetrics(fixtureData(), { language: "markdown", section: ["thresholds"] });

    expect(out).toContain("no per-language thresholds for markdown");
  });
});

describe("tea-rags://project/{alias}/metrics template", () => {
  let session: InProcessToolSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it("reads the language and section query parameters", async () => {
    const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
    registerAllResources(server, fixtureApp());
    session = await connectInProcessClient(server);

    const { contents } = await session.readResource(
      "tea-rags://project/fixture/metrics?language=ruby&section=thresholds,registry",
    );
    const [first] = contents;
    const text = "text" in first ? first.text : "";

    expect(text).toBe(formatProjectMetrics(fixtureData(), { language: "ruby", section: ["thresholds", "registry"] }));
  });
});
