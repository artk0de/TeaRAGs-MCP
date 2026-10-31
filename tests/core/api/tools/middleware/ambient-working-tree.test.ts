/**
 * bd tea-rags-mcp-d0z7b.8 — a read tool called with no `project` / `path` /
 * `collection` resolves its target from the server process cwd (stdio: the
 * client spawns the server in its project dir) before failing. Mutating tools
 * and servers without a meaningful cwd (HTTP) keep the explicit contract.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CollectionEntry } from "../../../../../src/core/api/public/index.js";
import type { AmbientWorkingTree } from "../../../../../src/core/api/tools/middleware/ambient-working-tree.js";
import { createRegisterTool } from "../../../../../src/core/api/tools/middleware/error-handler.js";

const CWD = "/work/registered-project/sub";
const OK = { content: [{ type: "text" as const, text: "ok" }] };
const addressing = {
  path: z.string().optional(),
  project: z.string().optional(),
  collection: z.string().optional(),
  relativePath: z.string().optional(),
};

function registerAndGetHandler(
  config: Record<string, unknown>,
  ambient: AmbientWorkingTree | undefined,
): { handler: ReturnType<typeof vi.fn>; call: (args: Record<string, unknown>) => Promise<any> } {
  const registerTool = vi.fn();
  const handler = vi.fn().mockResolvedValue(OK);
  createRegisterTool(undefined, ambient)({ registerTool } as any, "a_tool", config as any, handler as any);
  const wrapped = registerTool.mock.calls[0][2] as (args: unknown, extra: unknown) => Promise<unknown>;
  return { handler, call: async (args) => wrapped(args, {}) };
}

function ambientResolving(entry: CollectionEntry | null): AmbientWorkingTree {
  return { cwd: CWD, resolveIndexEntry: vi.fn().mockReturnValue(entry) };
}

const readTool = { description: "read", inputSchema: addressing, annotations: { readOnlyHint: true } };
const ENTRY = { collectionName: "code_x", path: "/work/registered-project" } as CollectionEntry;

describe("createRegisterTool ambient working tree (d0z7b.8)", () => {
  it("addresses a read tool with no addressing params by the server cwd when a registered project claims it", async () => {
    const ambient = ambientResolving(ENTRY);
    const { handler, call } = registerAndGetHandler(readTool, ambient);

    await call({ relativePath: "src/a.ts" });

    expect(ambient.resolveIndexEntry).toHaveBeenCalledWith(CWD);
    expect(handler.mock.calls[0][0]).toEqual({ relativePath: "src/a.ts", path: CWD });
  });

  it("fails with INPUT_COLLECTION_NOT_PROVIDED naming the cwd when no registered project claims it", async () => {
    const { handler, call } = registerAndGetHandler(readTool, ambientResolving(null));

    const result = await call({ relativePath: "src/a.ts" });

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INPUT_COLLECTION_NOT_PROVIDED");
    expect(result.content[0].text).toContain(CWD);
  });

  it("treats a cwd the resolver rejects as unregistered", async () => {
    const ambient: AmbientWorkingTree = {
      cwd: CWD,
      resolveIndexEntry: () => {
        throw new Error("bad path");
      },
    };
    const { handler, call } = registerAndGetHandler(readTool, ambient);

    const result = await call({});

    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain(CWD);
  });

  it.each([{ project: "p" }, { path: "/elsewhere" }, { collection: "code_y" }])(
    "leaves explicit addressing %o untouched",
    async (explicit) => {
      const ambient = ambientResolving(ENTRY);
      const { handler, call } = registerAndGetHandler(readTool, ambient);

      await call({ relativePath: "src/a.ts", ...explicit });

      expect(ambient.resolveIndexEntry).not.toHaveBeenCalled();
      expect(handler.mock.calls[0][0]).toEqual({ relativePath: "src/a.ts", ...explicit });
    },
  );

  it("never gives a mutating tool an implicit target", async () => {
    const ambient = ambientResolving(ENTRY);
    const { handler, call } = registerAndGetHandler({ description: "mutate", inputSchema: addressing }, ambient);

    await call({});

    expect(ambient.resolveIndexEntry).not.toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toEqual({});
  });

  it("leaves a read tool without a path parameter untouched", async () => {
    const ambient = ambientResolving(ENTRY);
    const { handler, call } = registerAndGetHandler(
      { description: "list", inputSchema: { project: z.string().optional() }, annotations: { readOnlyHint: true } },
      ambient,
    );

    await call({});

    expect(handler.mock.calls[0][0]).toEqual({});
  });

  it("keeps the explicit contract on a server without an ambient cwd (HTTP)", async () => {
    const { handler, call } = registerAndGetHandler(readTool, undefined);

    await call({ relativePath: "src/a.ts" });

    expect(handler.mock.calls[0][0]).toEqual({ relativePath: "src/a.ts" });
  });
});
