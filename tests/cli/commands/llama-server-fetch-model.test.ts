import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import {
  llamaServerCommand,
  runLlamaServerFetchModel,
  type LlamaServerFetchModelDeps,
} from "../../../src/cli/commands/llama-server.js";
import { createCli } from "../../../src/cli/create-cli.js";

const BLOB = Buffer.from("GGUF fake jina weights");
const BLOB_SHA = createHash("sha256").update(BLOB).digest("hex");

function manifestFor(sha: string, size: number) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:cfg", size: 279 },
    layers: [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${sha}`, size }],
  };
}

/** Registry fake: manifests answer with BLOB's manifest, blobs answer with BLOB. */
function registryFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/manifests/")) {
      return new Response(JSON.stringify(manifestFor(BLOB_SHA, BLOB.length)), { status: 200 });
    }
    return new Response(BLOB, { status: 200 });
  });
}

describe("llama-server fetch-model", () => {
  let dataDir: string;
  let out: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "llama-fetch-"));
    out = [];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function deps(fetchImpl: ReturnType<typeof registryFetch>, env: NodeJS.ProcessEnv = {}): LlamaServerFetchModelDeps {
    return {
      fetch: fetchImpl as unknown as typeof fetch,
      out: (line) => out.push(line),
      env: { TEA_RAGS_DATA_DIR: dataDir, ...env },
      home: "/home/nobody",
    };
  }

  it("downloads the given model into <TEA_RAGS_DATA_DIR>/models/gguf and prints the final path", async () => {
    const fetchImpl = registryFetch();

    await runLlamaServerFetchModel({ model: "nomic-embed-text" }, deps(fetchImpl));

    const expected = join(dataDir, "models", "gguf", `nomic-embed-text@latest-${BLOB_SHA.slice(0, 12)}.gguf`);
    expect(readFileSync(expected)).toEqual(BLOB);
    expect(out.at(-1)).toBe(expected);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://registry.ollama.ai/v2/library/nomic-embed-text/manifests/latest");
  });

  it("defaults the model to the configured EMBEDDING_MODEL", async () => {
    const fetchImpl = registryFetch();

    await runLlamaServerFetchModel({}, deps(fetchImpl, { EMBEDDING_MODEL: "someone/custom-embed:v2" }));

    expect(fetchImpl.mock.calls[0][0]).toBe("https://registry.ollama.ai/v2/someone/custom-embed/manifests/v2");
  });

  it("defaults the model to jina when EMBEDDING_MODEL is unset", async () => {
    const fetchImpl = registryFetch();

    await runLlamaServerFetchModel({}, deps(fetchImpl));

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://registry.ollama.ai/v2/unclemusclez/jina-embeddings-v2-base-code/manifests/latest",
    );
  });

  it("falls back to ~/.tea-rags/models/gguf without TEA_RAGS_DATA_DIR", async () => {
    const fetchImpl = registryFetch();
    const home = mkdtempSync(join(tmpdir(), "llama-home-"));
    try {
      await runLlamaServerFetchModel(
        { model: "nomic-embed-text" },
        { fetch: fetchImpl as unknown as typeof fetch, out: (line) => out.push(line), env: {}, home },
      );
      expect(out.at(-1)).toBe(
        join(home, ".tea-rags", "models", "gguf", `nomic-embed-text@latest-${BLOB_SHA.slice(0, 12)}.gguf`),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("honours --dir", async () => {
    const fetchImpl = registryFetch();
    const target = join(dataDir, "elsewhere");

    await runLlamaServerFetchModel({ model: "nomic-embed-text", dir: target }, deps(fetchImpl));

    expect(out.at(-1)?.startsWith(target)).toBe(true);
    expect(existsSync(out.at(-1) ?? "")).toBe(true);
  });

  it("is wired as `llama-server fetch-model [model] --dir` in yargs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(registryFetch() as unknown as typeof fetch);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const target = join(dataDir, "via-yargs");

    await yargs([])
      .command(llamaServerCommand)
      .exitProcess(false)
      .fail((msg, err) => {
        throw err ?? new Error(msg);
      })
      .parseAsync(["llama-server", "fetch-model", "nomic-embed-text", "--dir", target]);

    const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain(join(target, `nomic-embed-text@latest-${BLOB_SHA.slice(0, 12)}.gguf`));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("is registered on the tea-rags CLI", async () => {
    let help = "";
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      help += msg;
    });
    const cli = createCli(["--help"]).exitProcess(false);
    try {
      await cli.parseAsync();
    } catch {
      // yargs throws on --help when exitProcess is false
    }
    logSpy.mockRestore();

    expect(help).toContain("llama-server");
  });
});
