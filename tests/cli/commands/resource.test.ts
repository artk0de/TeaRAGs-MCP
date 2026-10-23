/**
 * `tea-rags resource <uri>` — reads an MCP resource through the in-process
 * session. A fake session stands in for the server; alias resolution is
 * injected.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { runResource, type RunResourceArgs } from "../../../src/cli/commands/resource.js";

function fakeSession(): InProcessToolSession & { close: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
    readResource: vi.fn(async (uri: string): Promise<ReadResourceResult> => {
      if (uri.includes("missing")) throw new Error(`MCP error -32002: Resource ${uri} not found`);
      return {
        contents: [
          { uri, mimeType: "text/markdown", text: `body of ${uri}` },
          { uri, mimeType: "text/plain", text: "second part" },
        ],
      };
    }),
    listResources: vi.fn().mockResolvedValue([
      { uri: "tea-rags://schema/filters", name: "filters" },
      { uri: "tea-rags://schema/presets", name: "presets" },
    ]),
    listResourceTemplates: vi
      .fn()
      .mockResolvedValue([{ uriTemplate: "tea-rags://project/{alias}/digest", name: "digest" }]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function run(
  input: Omit<RunResourceArgs, "out" | "errOut">,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runResource({
    ...input,
    out: (text) => stdout.push(text),
    errOut: (text) => stderr.push(text),
  });
  return { code, stdout, stderr };
}

describe("runResource", () => {
  it("replaces {alias} with the resolved alias and prints every content text", async () => {
    const session = fakeSession();
    const resolveAlias = vi.fn().mockResolvedValue("tea-rags");

    const h = await run({ uri: "tea-rags://project/{alias}/digest", project: "tea-rags", session, resolveAlias });

    expect(h.code).toBe(0);
    expect(resolveAlias).toHaveBeenCalledWith({ path: undefined, project: "tea-rags" });
    expect(session.readResource).toHaveBeenCalledWith("tea-rags://project/tea-rags/digest");
    expect(h.stdout).toEqual(["body of tea-rags://project/tea-rags/digest", "second part"]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("resolves the alias from --path when --project is absent", async () => {
    const resolveAlias = vi.fn().mockResolvedValue("my-app");

    await run({ uri: "tea-rags://project/{alias}/digest", path: "/repo/sub", session: fakeSession(), resolveAlias });

    expect(resolveAlias).toHaveBeenCalledWith({ path: "/repo/sub", project: undefined });
  });

  it("does not resolve an alias for a uri without {alias}", async () => {
    const resolveAlias = vi.fn();

    const h = await run({ uri: "tea-rags://schema/filters", session: fakeSession(), resolveAlias });

    expect(h.code).toBe(0);
    expect(resolveAlias).not.toHaveBeenCalled();
  });

  it("prints the raw result with --json", async () => {
    const h = await run({ uri: "tea-rags://schema/filters", json: true, session: fakeSession() });

    expect(h.code).toBe(0);
    expect((JSON.parse(h.stdout.join("\n")) as ReadResourceResult).contents).toHaveLength(2);
  });

  it("exits 1 with a register hint when the alias cannot be resolved", async () => {
    const session = fakeSession();

    const h = await run({
      uri: "tea-rags://project/{alias}/digest",
      session,
      resolveAlias: vi.fn().mockResolvedValue(null),
    });

    expect(h.code).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join("\n")).toContain("register the project: tea-rags index-codebase --name <alias>");
    expect(session.readResource).not.toHaveBeenCalled();
  });

  it("exits 1 with a --list hint for an unknown resource and still closes the session", async () => {
    const session = fakeSession();

    const h = await run({ uri: "tea-rags://guide/missing", session });

    expect(h.code).toBe(1);
    expect(h.stderr.join("\n")).toMatch(/not found[\s\S]*tea-rags resource --list/);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("lists every resource uri then every template uri with --list", async () => {
    const h = await run({ list: true, session: fakeSession() });

    expect(h.code).toBe(0);
    expect(h.stdout).toEqual([
      "tea-rags://schema/filters",
      "tea-rags://schema/presets",
      "tea-rags://project/{alias}/digest",
    ]);
  });

  it("exits 1 when neither a uri nor --list is given", async () => {
    const h = await run({ session: fakeSession() });

    expect(h.code).toBe(1);
    expect(h.stderr.join("\n")).toContain("tea-rags resource --list");
  });
});
