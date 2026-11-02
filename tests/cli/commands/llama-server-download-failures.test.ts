import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { llamaServerCommand } from "../../../src/cli/commands/llama-server.js";

async function runCommand(...argv: string[]): Promise<void> {
  await yargs(argv).command(llamaServerCommand).exitProcess(false).parseAsync();
}

function printedTo(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

const BLOB_SHA = createHash("sha256").update("GGUF weights").digest("hex");

/** Registry answers the manifest; every download (blob, release archive) answers 503. */
function failingDownloads(): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes("/manifests/")) {
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          layers: [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${BLOB_SHA}`, size: 12 }],
        }),
        { status: 200 },
      );
    }
    return new Response("unavailable", { status: 503 });
  };
}

// A failed download in the CLI is a message + hint and exit 1, never a raw stack (hjbow.13 release e2e).
describe("tea-rags llama-server download failures", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("fetch-model prints the failed download as message + hint and exits 1", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(failingDownloads());
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCommand("llama-server", "fetch-model", "nomic-embed-text");

    const printed = printedTo(stderr);
    expect(printed).toMatch(/^llama-server fetch-model: Downloading \S+ failed \(status 503\)/);
    expect(printed).toContain("HTTPS_PROXY");
    expect(printed).not.toContain("    at ");
    expect(errorLog).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("install prints the failed download as message + hint and exits 1", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(failingDownloads());
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCommand("llama-server", "install", "--backend", "cpu");

    const printed = printedTo(stderr);
    expect(printed).toMatch(/^llama-server install: Downloading \S+ failed \(status 503\)/);
    expect(printed).toContain("HTTPS_PROXY");
    expect(printed).not.toContain("    at ");
    expect(errorLog).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
