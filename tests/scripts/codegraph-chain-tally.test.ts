import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run, type RunResult } from "../../scripts/codegraph-chain-tally.js";

/**
 * The tally only means something if it walks the corpus production walks
 * (bd tea-rags-mcp-q6ber). Two halves, both once wrong: the WALK read no ignore
 * file, so it scored sources production never indexes; the symbol TABLE held
 * only `--lang`'s extension, so a call into another language's definition found
 * no node to pin and the chain reported an absence production does not have.
 */
describe("codegraph-chain-tally corpus walk", () => {
  let corpus: string;
  let result: RunResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-corpus-"));
    write(".contextignore", "app/vendored/\n");
    write("app/service.py", "def helper():\n    return 1\n\n\ndef service():\n    return helper()\n");
    write("app/bridge.js", "export function bridge() {\n  return 2;\n}\n");
    write("app/vendored/shipped.py", "def shipped():\n    return 3\n");
    result = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true);
  }, 30_000);

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("drops a file a project ignore file excludes, as production never indexes it", () => {
    expect(result.ingestIgnored).toEqual(1);
    expect(result.rows.some((row) => row.relPath.startsWith("app/vendored/"))).toBe(false);
  });

  it("walks another language into the symbol table without scoring its call sites", () => {
    expect(result.files).toEqual(1);
    expect(result.symbolTableOnlyFiles).toEqual(1);
    expect(result.rows.every((row) => row.relPath === "app/service.py")).toBe(true);
  });

  it("carries both languages' definitions in the one run-global symbol table", () => {
    expect(result.symbols).toBeGreaterThanOrEqual(3);
  });

  it("keeps the rebuilt baseline in lockstep with the production resolver", () => {
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.chainDrift).toEqual(0);
  });
});

/**
 * The tally builds its own `CallContext`, so a run-global channel the production
 * runner threads is a channel the tally must thread too or the measurement
 * understates production (bd tea-rags-mcp-f0xaa). `classFieldTypesByClassKey`
 * carries a base class's fields across files — polar's `SyncServiceBase.__init__`
 * assigning `self.client` from an annotated parameter, called from a subclass
 * declared elsewhere.
 */
describe("codegraph-chain-tally run-global field channel", () => {
  let corpus: string;
  let result: RunResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-fields-"));
    write("sdk/client.py", ["class SyncClientBase:", "    def send_request(self):", "        return 1", ""].join("\n"));
    write(
      "sdk/base.py",
      [
        "from sdk.client import SyncClientBase",
        "",
        "class SyncServiceBase:",
        "    def __init__(self, client: SyncClientBase) -> None:",
        "        self.client = client",
        "",
      ].join("\n"),
    );
    write(
      "sdk/metrics.py",
      [
        "from sdk.base import SyncServiceBase",
        "",
        "class MetricsSync(SyncServiceBase):",
        "    def list(self):",
        "        return self.client.send_request()",
        "",
      ].join("\n"),
    );
    result = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true);
  }, 30_000);

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("pins a subclass's call through a field its base assigned in another file", () => {
    const row = result.rows.find((r) => r.relPath === "sdk/metrics.py" && r.member === "send_request");
    expect(row?.variant).toEqual({
      targetRelPath: "sdk/client.py",
      targetSymbolId: "SyncClientBase#send_request",
    });
  });

  it("keeps the rebuilt baseline in lockstep with the production resolver", () => {
    expect(result.chainDrift).toEqual(0);
  });
});

/**
 * `localCallBindings` is a PER-CHUNK channel production threads for every
 * language (`CallEdgeResolutionRunner#buildCallContext`), and Go's
 * `returnTypeBinding` pass reads nothing else. A tally that threads it for Ruby
 * alone measures a Go chain whose second pass can never fire, so gin's
 * `engine := New(); engine.Use(...)` read as a miss production does not have
 * (bd tea-rags-mcp-e6xx).
 */
describe("codegraph-chain-tally per-chunk call bindings", () => {
  let corpus: string;
  let result: RunResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-go-"));
    write(
      "gin.go",
      [
        "package gin",
        "",
        "type Engine struct{}",
        "",
        "func New() *Engine { return &Engine{} }",
        "",
        "func (engine *Engine) Use() {}",
        "",
        "func Default() *Engine {",
        "\tengine := New()",
        "\tengine.Use()",
        "\treturn engine",
        "}",
        "",
      ].join("\n"),
    );
    result = await run(corpus, "go", null, Number.MAX_SAFE_INTEGER, true, true, { timeOnly: true });
  }, 30_000);

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("resolves a Go var bound to a function's declared return type, as production does", () => {
    const row = result.rows.find((r) => r.receiver === "engine" && r.member === "Use");
    expect(row?.runnerAnswer).toEqual({ targetRelPath: "gin.go", targetSymbolId: "Engine#Use" });
  });
});

/**
 * `projectRoot` is threaded to every call context in production
 * (`CallEdgeResolutionRunner#buildCallContext`); the tally threaded it for
 * Ruby's Zeitwerk alone. Go reads the project's go.mod module map through it,
 * so without it every module-path import measured as a miss (bd
 * tea-rags-mcp-e6xx).
 */
describe("codegraph-chain-tally project root", () => {
  let corpus: string;
  let result: RunResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-gomod-"));
    write("go.mod", "module github.com/gin-gonic/gin\n");
    write(
      "internal/bytesconv/bytesconv.go",
      "package bytesconv\n\nfunc StringToBytes(s string) []byte { return nil }\n",
    );
    write(
      "auth.go",
      [
        "package gin",
        "",
        'import "github.com/gin-gonic/gin/internal/bytesconv"',
        "",
        "func authorizationHeader(user string) []byte {",
        "\treturn bytesconv.StringToBytes(user)",
        "}",
        "",
      ].join("\n"),
    );
    result = await run(corpus, "go", null, Number.MAX_SAFE_INTEGER, true, true, { timeOnly: true });
  }, 30_000);

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("resolves a module-path import through the corpus's go.mod, as production does", () => {
    const row = result.rows.find((r) => r.receiver === "bytesconv" && r.member === "StringToBytes");
    expect(row?.runnerAnswer).toEqual({
      targetRelPath: "internal/bytesconv/bytesconv.go",
      targetSymbolId: "StringToBytes",
    });
  });
});
