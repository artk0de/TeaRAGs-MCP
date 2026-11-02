import type * as ChildProcessModule from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { llamaServerCommand, runLlamaServerCommand } from "../../../src/cli/commands/llama-server.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() };
});

const childProcess = await import("node:child_process");

const SHA = "fedcba9876543210".repeat(4);

function registryFetch() {
  return vi.fn(async (url: string) => {
    if (!url.includes("/manifests/")) throw new Error(`unexpected non-manifest fetch: ${url}`);
    return new Response(
      JSON.stringify({
        layers: [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${SHA}`, size: 42 }],
      }),
      { status: 200 },
    );
  });
}

async function noLocalGguf(): Promise<number | undefined> {
  return undefined;
}

function expectNoChildProcess(): void {
  expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  expect(vi.mocked(childProcess.exec)).not.toHaveBeenCalled();
  expect(vi.mocked(childProcess.execFile)).not.toHaveBeenCalled();
  expect(vi.mocked(childProcess.execSync)).not.toHaveBeenCalled();
  expect(vi.mocked(childProcess.spawnSync)).not.toHaveBeenCalled();
}

async function parse(args: string[]): Promise<string> {
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await yargs([])
    .command(llamaServerCommand)
    .exitProcess(false)
    .fail((msg, err) => {
      throw err ?? new Error(msg);
    })
    .parseAsync(args);
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("llama-server command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.exec).mockClear();
    vi.mocked(childProcess.execFile).mockClear();
  });

  it("resolves an Ollama reference via the registry manifest and prints the windows sheet", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(registryFetch() as unknown as typeof fetch);

    const printed = await parse([
      "llama-server",
      "command",
      "--os",
      "windows",
      "--bin",
      "C:\\llama\\rocm\\llama-server.exe",
      "--device",
      "ROCm0",
      "--device",
      "ROCm1",
      "--host",
      "0.0.0.0",
      "--advertise",
      "192.168.1.71",
      "--api-key",
      "k",
      "--model",
      "nomic-embed-text",
      "--autostart",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://registry.ollama.ai/v2/library/nomic-embed-text/manifests/latest",
      expect.anything(),
    );
    const file = `nomic-embed-text@latest-${SHA.slice(0, 12)}.gguf`;
    expect(printed).toContain(
      `Invoke-WebRequest -Uri 'https://registry.ollama.ai/v2/library/nomic-embed-text/blobs/sha256:${SHA}' -OutFile 'C:\\llama-models\\${file}'`,
    );
    expect(printed).toContain("--device ROCm1 --host 0.0.0.0 --port 8082 --api-key k");
    expect(printed).toContain("schtasks --% /Create");
    expect(printed).toContain("EMBEDDING_BASE_URL=http://192.168.1.71:8081,http://192.168.1.71:8082");
    expect(printed).toContain("EMBEDDING_API_KEY=k");
    expectNoChildProcess();
  });

  it("uses a GGUF path as-is and never touches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const printed = await parse([
      "llama-server",
      "command",
      "--os",
      "linux",
      "--bin",
      "/opt/llama/llama-server",
      "--model",
      "/data/models/jina.gguf",
      "--port",
      "9000",
      "--slots",
      "2",
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed).not.toContain("curl");
    expect(printed).toContain(
      "/opt/llama/llama-server -m /data/models/jina.gguf --embedding -ngl 999 -fa on -np 2 -c 16384 -b 8192 -ub 8192 --host 127.0.0.1 --port 9000",
    );
    expect(printed).toContain("/opt/llama/llama-server --list-devices");
    expectNoChildProcess();
  });

  it("defaults the model to EMBEDDING_MODEL, else the jina default", async () => {
    const fetchImpl = registryFetch();
    const out: string[] = [];

    await runLlamaServerCommand(
      { bin: "/b/llama-server", os: "macos" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        out: (l) => out.push(l),
        env: {},
        platform: "darwin",
        home: "/home/u",
        readGgufContextLength: noLocalGguf,
      },
    );
    await runLlamaServerCommand(
      { bin: "/b/llama-server" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        out: (l) => out.push(l),
        env: { EMBEDDING_MODEL: "someone/custom:v2" },
        platform: "linux",
        home: "/home/u",
        readGgufContextLength: noLocalGguf,
      },
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://registry.ollama.ai/v2/unclemusclez/jina-embeddings-v2-base-code/manifests/latest",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://registry.ollama.ai/v2/someone/custom/manifests/v2");
    expect(out.join("\n")).toContain("shasum -a 256");
    expect(out.join("\n")).toContain("sha256sum");
    expectNoChildProcess();
  });

  it("defaults --os to the current platform", async () => {
    const out: string[] = [];
    await runLlamaServerCommand(
      { bin: "C:\\l\\llama-server.exe", model: "C:\\m\\x.gguf" },
      {
        fetch: vi.fn<typeof fetch>(),
        out: (l) => out.push(l),
        env: {},
        platform: "win32",
        home: "C:\\Users\\u",
        readGgufContextLength: noLocalGguf,
      },
    );
    expect(out.join("\n")).toContain("netsh advfirewall");
  });

  it("sizes the slots from the context length of a GGUF path present on this machine", async () => {
    const out: string[] = [];
    const reader = vi.fn(async () => 2048);
    await runLlamaServerCommand(
      {
        bin: "/opt/homebrew/bin/llama-server",
        os: "macos",
        host: "127.0.0.1",
        port: 8080,
        slots: 4,
        model: "~/m/CodeRankEmbed-Q8_0.gguf",
      },
      {
        fetch: vi.fn<typeof fetch>(),
        out: (l) => out.push(l),
        env: {},
        platform: "darwin",
        home: "/Users/u",
        readGgufContextLength: reader,
      },
    );
    expect(reader).toHaveBeenCalledWith("/Users/u/m/CodeRankEmbed-Q8_0.gguf");
    expect(out.join("\n")).toContain("-np 4 -c 8192 -b 2048 -ub 2048");
    expect(out.join("\n")).toContain("context window is 2048 tokens");
  });

  it("reads the context length of an Ollama reference already fetched into the gguf dir", async () => {
    const reader = vi.fn(async () => 2048);
    const out: string[] = [];
    await runLlamaServerCommand(
      { bin: "/b/llama-server", os: "macos", model: "nomic-embed-text" },
      {
        fetch: registryFetch() as unknown as typeof fetch,
        out: (l) => out.push(l),
        env: { TEA_RAGS_DATA_DIR: "/data/tea" },
        platform: "darwin",
        home: "/Users/u",
        readGgufContextLength: reader,
      },
    );
    expect(reader).toHaveBeenCalledWith(`/data/tea/models/gguf/nomic-embed-text@latest-${SHA.slice(0, 12)}.gguf`);
    expect(out.join("\n")).toContain("-b 2048 -ub 2048");
  });

  it("keeps 8192 per slot and prints no warning when no local GGUF is readable", async () => {
    const out: string[] = [];
    await runLlamaServerCommand(
      { bin: "/opt/llama/llama-server", os: "linux", model: "/remote/models/x.gguf", slots: 2 },
      {
        fetch: vi.fn<typeof fetch>(),
        out: (l) => out.push(l),
        env: {},
        platform: "darwin",
        home: "/Users/u",
        readGgufContextLength: noLocalGguf,
      },
    );
    expect(out.join("\n")).toContain("-np 2 -c 16384 -b 8192 -ub 8192");
    expect(out.join("\n")).not.toContain("Warning");
  });

  it("rejects an unknown --os", async () => {
    await expect(parse(["llama-server", "command", "--os", "plan9", "--bin", "/b"])).rejects.toThrow();
    expectNoChildProcess();
  });
});
