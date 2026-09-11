/**
 * The second oracle's host integration (bd tea-rags-mcp-w205u, E4.0.2).
 *
 * Three pure surfaces, none of which needs a language server running: the
 * per-FILE merge rule that decides which engine answers a file, the
 * `classify_origin` port both engines share, and the LSP reply → row mapping.
 * The merge table is the whole decision, so it gets one case per row.
 */
import { describe, expect, it } from "vitest";

import {
  locateCalleeColumn,
  mergeOracleReplies,
  oracleEntryOf,
  type PyOracleFileReply,
} from "../../scripts/lib/py-oracle-core.js";
import { classifyOrigin } from "../../scripts/lib/py-oracle-origin.js";
import { buildRows, parseOracleSelection } from "../../scripts/py-codegraph-jedi-oracle.js";
import {
  answerForSite,
  composeSymbolId,
  lspLocations,
  PYRIGHT_VERSION,
  pyrightLauncher,
  settingsSection,
} from "../../scripts/py-oracle/lsp_oracle.js";

const reply = (relPath: string, overrides: Partial<PyOracleFileReply> = {}): PyOracleFileReply => ({
  relPath,
  parseFailed: false,
  parsoErrors: 0,
  answers: [],
  ...overrides,
});

describe("mergeOracleReplies", () => {
  const lsp = new Map([
    ["a.py", reply("a.py", { answers: [{ startLine: 1, member: "f", outcome: { kind: "unknown" } }] })],
  ]);

  it("keeps jedi on a file jedi read cleanly — jedi is primary, never a tiebreak", () => {
    const merged = mergeOracleReplies(new Map([["a.py", reply("a.py")]]), lsp);
    expect(merged.get("a.py")).toEqual({ reply: reply("a.py"), engine: "jedi" });
  });

  it("takes the second engine when jedi answered from a parso-damaged tree", () => {
    const merged = mergeOracleReplies(new Map([["a.py", reply("a.py", { parsoErrors: 3 })]]), lsp);
    expect(merged.get("a.py")?.engine).toBe("lsp");
  });

  it("takes the second engine when jedi had no tree at all", () => {
    const merged = mergeOracleReplies(new Map([["a.py", reply("a.py", { parseFailed: true })]]), lsp);
    expect(merged.get("a.py")?.engine).toBe("lsp");
  });

  /** No repair available: the row stays degraded rather than vanishing. */
  it("leaves a damaged file on jedi when the second engine did not answer it", () => {
    const merged = mergeOracleReplies(new Map([["b.py", reply("b.py", { parsoErrors: 3 })]]), new Map());
    expect(merged.get("b.py")).toEqual({ reply: reply("b.py", { parsoErrors: 3 }), engine: "jedi" });
  });

  it("adopts a file only the second engine saw, so the denominator cannot shrink silently", () => {
    const merged = mergeOracleReplies(new Map(), lsp);
    expect(merged.get("a.py")?.engine).toBe("lsp");
    expect(merged.size).toBe(1);
  });

  it("never mixes engines inside one file — the entry carries one reply and one engine", () => {
    const merged = mergeOracleReplies(
      new Map([
        ["a.py", reply("a.py", { parsoErrors: 2 })],
        ["c.py", reply("c.py")],
      ]),
      lsp,
    );
    expect([...merged].map(([path, entry]) => [path, entry.engine, entry.reply.relPath])).toEqual([
      ["a.py", "lsp", "a.py"],
      ["c.py", "jedi", "c.py"],
    ]);
  });
});

describe("oracleEntryOf", () => {
  it("defaults a plain reply map entry to jedi, so the scratch drivers keep working", () => {
    expect(oracleEntryOf(reply("a.py"))).toEqual({ reply: reply("a.py"), engine: "jedi" });
  });

  it("passes a merged entry through untouched", () => {
    const entry = { reply: reply("a.py"), engine: "lsp" as const };
    expect(oracleEntryOf(entry)).toBe(entry);
  });

  it("reports no reply rather than inventing an empty one", () => {
    expect(oracleEntryOf(undefined)).toEqual({ reply: undefined, engine: "jedi" });
  });
});

describe("parseOracleSelection", () => {
  it("defaults to jedi — the published denominator is what an unflagged run means", () => {
    expect(parseOracleSelection(undefined)).toBe("jedi");
  });

  it.each(["jedi", "lsp", "merged"] as const)("accepts %s", (value) => {
    expect(parseOracleSelection(value)).toBe(value);
  });

  it("throws on a typo instead of falling back — a silent default would mislabel a denominator", () => {
    expect(() => parseOracleSelection("pyright")).toThrow(/jedi\|lsp\|merged/);
  });
});

describe("classifyOrigin — the port of jedi_oracle.py:classify_origin", () => {
  const stdlib = new Set(["json", "string", "types"]);
  const at = (path: string | null, root = "/repo") => classifyOrigin(path, root, stdlib);

  it("calls a missing module path builtin", () => {
    expect(at(null)).toBe("builtin");
  });

  it.each([
    ["jedi", "/venv/lib/python3.13/site-packages/jedi/third_party/typeshed/stdlib/os.pyi"],
    ["pyright", "/cache/_npx/pyright/dist/typeshed-fallback/stdlib/os.pyi"],
    ["ty", "/Users/x/.cache/ty/vendored/typeshed/abc123/stdlib/os.pyi"],
  ])("reads %s's own bundled typeshed as a stub, not as code outside the repo", (_engine, path) => {
    expect(at(path)).toBe("typeshedStub");
  });

  it.each(["/venv/lib/python3.13/site-packages/django/db/models/base.py", "/usr/lib/python3/dist-packages/six.py"])(
    "calls an installed distribution sitePackages",
    (path) => {
      expect(at(path)).toBe("sitePackages");
    },
  );

  it("calls an interpreter directory stdlib", () => {
    expect(at("/opt/python/lib/python3.13/json/__init__.py")).toBe("stdlib");
  });

  /**
   * ugnest keeps its virtualenv INSIDE its own checkout. Root-prefix-first
   * called Django's own source "project" in 26 of 30 sampled targets.
   */
  it("keeps a venv INSIDE the corpus root out of the project", () => {
    expect(at("/repo/.venv/lib/python3.13/site-packages/django/db/models/base.py")).toBe("sitePackages");
  });

  /**
   * The stdlib NAME test runs LAST and only outside the corpus: running it
   * ahead of containment scored the chain's correct answer a phantom on 432
   * netbox rows and 46 polar rows (7dsyq).
   */
  it("keeps a project module whose name shadows the stdlib in the project", () => {
    expect(at("/repo/netbox/utilities/string.py")).toBe("project");
  });

  it("falls back to the stdlib NAME test only for a path the corpus does not contain", () => {
    expect(at("/elsewhere/types.py")).toBe("stdlib");
    expect(at("/elsewhere/polar_helpers.py")).toBe("outsideRepo");
  });

  it("separates generated in-repo code from hand-written in-repo code", () => {
    expect(at("/repo/app/migrations/0001_initial.py")).toBe("generatedInRepo");
    expect(at("/repo/app/models.py")).toBe("project");
  });
});

describe("locateCalleeColumn", () => {
  const site = (callText: string, member: string, receiver: string | null = null) => ({ callText, member, receiver });

  /** D7's one opened disagreement: the leftmost `run` is the wrong `run`. */
  it("pins the INNER call on asyncio.run(run()) rather than the leftmost same-named callee", () => {
    expect(locateCalleeColumn("    asyncio.run(run())", site("run()", "run"))).toBe(16);
  });

  it("skips the receiver to land on the member of a dotted call", () => {
    expect(
      locateCalleeColumn("x = self.repo.get_by_id(pk)", site("self.repo.get_by_id(pk)", "get_by_id", "self.repo")),
    ).toBe(14);
  });

  it("walks successive sites on one line past the occurrences already claimed", () => {
    const line = "total = add(1) + add(2)";
    const first = locateCalleeColumn(line, site("add(1)", "add"));
    expect(first).toBe(8);
    expect(locateCalleeColumn(line, site("add(2)", "add"), first + 3)).toBe(17);
  });

  it("falls back to the member regex when the call text is not on the line", () => {
    expect(locateCalleeColumn("    value = compute(", site("compute(\n  arg,\n)", "compute"))).toBe(12);
  });

  it("reports -1 when the member is nowhere on the line, so the caller can say coordinateMiss", () => {
    expect(locateCalleeColumn("    pass", site("missing()", "missing"))).toBe(-1);
  });
});

describe("composeSymbolId — mirroring compose_symbol_id", () => {
  const source = [
    "class Outer:",
    "    class Inner:",
    "        pass",
    "",
    "    @staticmethod",
    "    def build(cls):",
    "        pass",
    "",
    "    def save(self):",
    "        pass",
    "",
    "def helper():",
    "    pass",
    "",
    "TABLE = None",
  ];

  it.each([
    [9, "Outer#save", "function", false],
    [6, "Outer.build", "function", false],
    [12, "helper", "function", false],
    [2, "Outer.Inner", "class", false],
  ])("composes line %i as %s", (line, symbolId, defKind, pinUncertain) => {
    expect(composeSymbolId(source, line)).toEqual({ symbolId, defKind, pinUncertain });
  });

  it("reports nonCallable when the target line starts no def or class", () => {
    expect(composeSymbolId(source, 15)).toEqual({ symbolId: null, defKind: "nonCallable", pinUncertain: true });
  });

  it("reports unknown — a different fact — when the target file could not be read", () => {
    expect(composeSymbolId([], 4)).toEqual({ symbolId: null, defKind: "unknown", pinUncertain: true });
  });
});

describe("lspLocations", () => {
  it.each([
    ["a bare Location", { uri: "file:///repo/a.py", range: { start: { line: 4 } } }],
    ["a Location array", [{ uri: "file:///repo/a.py", range: { start: { line: 4 } } }]],
    ["a LocationLink", [{ targetUri: "file:///repo/a.py", targetSelectionRange: { start: { line: 4 } } }]],
  ])("normalises %s to a 1-based line", (_shape, raw) => {
    expect(lspLocations(raw)).toEqual([{ uri: "file:///repo/a.py", line: 5 }]);
  });

  it("treats a null reply as no definition at all", () => {
    expect(lspLocations(null)).toEqual([]);
  });
});

describe("answerForSite — the LSP reply mapped into jedi's row schema", () => {
  const files: Record<string, string[]> = {
    "/repo/pkg/service.py": ["class Service:", "    def run(self):", "        pass"],
    "/repo/pkg/__init__.py": ["def exported():", "    pass"],
  };
  const linesOf = (path: string): string[] => files[path] ?? [];
  const stdlibNames = new Set<string>();
  const site = { startLine: 7, member: "run", receiver: "service", callText: "service.run()" };
  const answer = (locations: { uri: string; line: number }[]) =>
    answerForSite({ site, locations, corpusRoot: "/repo", linesOf, stdlibNames });

  it("says unknown when the engine returned no target", () => {
    expect(answer([])).toMatchObject({ startLine: 7, member: "run", outcome: { kind: "unknown" } });
  });

  it("says external, carrying the origin, when every target is outside the project", () => {
    expect(answer([{ uri: "file:///venv/lib/python3.13/site-packages/x/y.py", line: 3 }]).outcome).toEqual({
      kind: "external",
      origin: "sitePackages",
    });
  });

  it("pins an in-project target with the composer's symbol id and its unmasked node kind", () => {
    expect(answer([{ uri: "file:///repo/pkg/service.py", line: 2 }]).outcome).toEqual({
      kind: "inProject",
      origin: "project",
      targets: [
        {
          relPath: "pkg/service.py",
          symbolId: "Service#run",
          defLine: 2,
          defKind: "function",
          defNodeKind: "function",
          pinUncertain: false,
        },
      ],
    });
  });

  it("marks a target reached through a package __init__ as a re-export", () => {
    expect(answer([{ uri: "file:///repo/pkg/__init__.py", line: 1 }]).siteFacts).toMatchObject({ viaReexport: true });
  });

  /**
   * Partial on purpose: the caller's AST is what says whether a receiver is an
   * annotated parameter, and this engine never sees it. An absent fact and a
   * false fact land in different shape categories.
   */
  it("omits every fact it cannot determine rather than guessing false", () => {
    expect(Object.keys(answer([]).siteFacts ?? {}).sort()).toEqual([
      "isSuperCall",
      "targetIsStaticOrClassMethod",
      "viaReexport",
    ]);
  });
});

describe("pyrightLauncher", () => {
  const config = {
    corpusRoot: "/repo",
    venvPython: "/bench/venvs/polar/bin/python",
    roots: ["/repo/server", "/repo/sdk/python"],
    pythonVersion: "3.14",
  };

  it("pins the engine version D7 measured, cache-local through npx", () => {
    expect(pyrightLauncher(config, {}).command).toEqual([
      "npx",
      "--yes",
      "--package",
      `pyright@${PYRIGHT_VERSION}`,
      "pyright-langserver",
      "--stdio",
    ]);
    expect(PYRIGHT_VERSION).toBe("1.1.414");
  });

  it("carries the corpus venv, its grammar version and its declared roots into the settings", () => {
    const { analysis } = pyrightLauncher(config, {}).settings.python as Record<string, Record<string, unknown>>;
    expect(analysis).toMatchObject({ pythonVersion: "3.14", extraPaths: ["/repo/server", "/repo/sdk/python"] });
  });

  it("also puts VIRTUAL_ENV in the child env — the one channel no engine misreads", () => {
    expect(pyrightLauncher(config, { PATH: "/usr/bin" }).env).toMatchObject({
      VIRTUAL_ENV: "/bench/venvs/polar",
      PATH: "/bench/venvs/polar/bin:/usr/bin",
    });
  });
});

describe("settingsSection", () => {
  const settings = { python: { analysis: { pythonVersion: "3.14" } } };

  /**
   * The configuration pull must be answered PER ITEM BY SECTION. A one-element
   * reply left the server on its defaults and drove `unknown` from 8.6 % to
   * 50.4 % in the spike.
   */
  it("resolves a dotted section against the settings tree", () => {
    expect(settingsSection(settings, "python.analysis")).toEqual({ pythonVersion: "3.14" });
  });

  it("answers null for a section the settings do not carry", () => {
    expect(settingsSection(settings, "ruff.lint")).toBeNull();
  });
});

describe("buildRows stamps the engine that answered the file", () => {
  const ctx = { callerFile: "pkg/a.py", callerScope: [] } as never;
  const site = {
    relPath: "pkg/a.py",
    call: { callText: "f()", receiver: null, member: "f", startLine: 1 },
    ctx,
    receiverKind: "bareCall",
    chain: null,
    answeredBy: "none",
    missBucket: "miss",
  } as never;

  it("defaults to jedi for a plain reply map — the scratch drivers stay byte-identical", () => {
    expect(buildRows([site], new Map([["pkg/a.py", reply("pkg/a.py")]]))[0]?.oracleEngine).toBe("jedi");
  });

  it("reads the provenance off a merged entry", () => {
    const merged = new Map([["pkg/a.py", { reply: reply("pkg/a.py"), engine: "lsp" as const }]]);
    expect(buildRows([site], merged)[0]?.oracleEngine).toBe("lsp");
  });
});
