/**
 * Host-side units for the Python oracle (bd tea-rags-mcp-xumwz). The corpus
 * walk and the subprocess are exercised by the smoke run on httpx, not here:
 * a mocked jedi would assert the mock.
 */
import { describe, expect, it } from "vitest";

import {
  AnsweredByProbe,
  askOracle,
  buildPythonChain,
  buildRows,
  parseArgs,
  resolveCorpusRoots,
} from "../../scripts/py-codegraph-jedi-oracle.js";
import type { CallContext, CallRef } from "../../src/core/contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../src/core/contracts/types/language.js";

const call = (member: string): CallRef => ({
  callText: `${member}()`,
  receiver: null,
  member,
  startLine: 1,
});
const ctx = {} as CallContext;

class FixedStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly outcome: SymbolResolutionOutcome,
  ) {}
  attempt(): SymbolResolutionOutcome {
    return this.outcome;
  }
}

describe("buildPythonChain", () => {
  /**
   * This list used to be the harness's OWN copy of the order and it silently
   * lost `importedName` when that pass landed — `chainDrift` 117 on flask, 552
   * on ugnest. The order now comes from the production factory, and
   * `tests/core/domains/language/python/resolver/python-chain-factory.test.ts`
   * is what pins it against `PythonCallResolver`. The assertion here is the
   * harness's end of that wiring, not a second source of truth.
   */
  it("takes PythonCallResolver's chain from the shared factory", () => {
    expect(buildPythonChain().map((pass) => pass.name)).toEqual([
      "super",
      "selfField",
      "selfMember",
      "localBinding",
      "importedName",
      "importMatch",
      "globalShortName",
    ]);
  });
});

describe("AnsweredByProbe", () => {
  it("records the pass that resolved and returns the outcome untouched", () => {
    const record = { answeredBy: "none" };
    const resolved: SymbolResolutionOutcome = {
      kind: "resolved",
      target: { targetRelPath: "pkg/a.py", targetSymbolId: "A#f" },
    };
    const probe = new AnsweredByProbe(new FixedStrategy("localBinding", resolved), record);
    expect(probe.attempt(call("f"), ctx)).toBe(resolved);
    expect(record.answeredBy).toBe("localBinding");
  });

  it("leaves the record alone when the pass continues", () => {
    const record = { answeredBy: "none" };
    const probe = new AnsweredByProbe(new FixedStrategy("importMatch", { kind: "continue" }), record);
    probe.attempt(call("f"), ctx);
    expect(record.answeredBy).toBe("none");
  });

  it("keeps the wrapped pass's own name so the tally labels match production", () => {
    expect(
      new AnsweredByProbe(new FixedStrategy("super", { kind: "continue" }), {
        answeredBy: "none",
      }).name,
    ).toBe("super");
  });
});

describe("parseArgs", () => {
  it("resolves a manifest NAME to its root and its provisioned interpreter", () => {
    const options = parseArgs(["--corpus", "netbox"]);
    expect(options.corpusName).toBe("netbox");
    expect(options.corpusRoot.endsWith("/corpora/netbox")).toBe(true);
    expect(options.venvPython?.endsWith("/venvs/netbox/bin/python")).toBe(true);
  });

  it("treats an unknown --corpus as a path and takes no interpreter from it", () => {
    const options = parseArgs(["--corpus", "/tmp/whatever"]);
    expect(options.corpusRoot).toBe("/tmp/whatever");
    expect(options.venvPython).toBeNull();
  });

  it("lets an explicit --environment win over the manifest", () => {
    expect(parseArgs(["--corpus", "polar", "--environment", "/tmp/py"]).venvPython).toBe("/tmp/py");
  });

  it("resolves the manifest's source roots against the corpus root", () => {
    expect(parseArgs(["--corpus", "polar"]).roots).toEqual([`${parseArgs(["--corpus", "polar"]).corpusRoot}/server`]);
    expect(parseArgs(["--corpus", "flask"]).roots).toEqual([`${parseArgs(["--corpus", "flask"]).corpusRoot}/src`]);
  });

  it("collapses a '.' root to the corpus root itself", () => {
    const options = parseArgs(["--corpus", "ugnest"]);
    expect(options.roots).toEqual([options.corpusRoot]);
  });

  it("falls back to the root for a corpus the manifest does not describe", () => {
    expect(parseArgs(["--corpus", "/tmp/whatever"]).roots).toEqual(["/tmp/whatever"]);
  });

  it("lets an explicit --roots win over the manifest", () => {
    const options = parseArgs(["--corpus", "polar", "--roots", "server, sdk"]);
    expect(options.roots).toEqual([`${options.corpusRoot}/server`, `${options.corpusRoot}/sdk`]);
  });

  it("defaults the seed so two runs sample identically", () => {
    expect(parseArgs([]).seed).toBe(parseArgs([]).seed);
  });

  const interpreterOf = (argv: readonly string[]): string | undefined => {
    const options = parseArgs(argv);
    const index = options.pythonArgv.indexOf("--python");
    return options.pythonArgv[index + 1];
  };

  it("launches jedi on the manifest's declared oraclePython, not on requiresPython", () => {
    // httpx declares >=3.9 and flask >=3.10; the oracle environment itself is
    // pinned >=3.13 (scripts/py-oracle/pyproject.toml), so a corpus floor is a
    // LOWER bound on the grammar, never the version that runs jedi. Deriving the
    // launcher from httpx's 3.9 is what killed the host mid-handshake (3yxmy).
    expect(interpreterOf(["--corpus", "httpx"])).toBe("3.13");
    expect(interpreterOf(["--corpus", "flask"])).toBe("3.13");
    expect(interpreterOf(["--corpus", "netbox"])).toBe("3.13");
  });

  it("keeps a corpus floor ABOVE the oracle floor — polar needs the 3.14 grammar", () => {
    expect(interpreterOf(["--corpus", "polar"])).toBe("3.14");
  });

  it("falls back to the derived floor for a corpus the manifest does not declare", () => {
    expect(interpreterOf(["--corpus", "/tmp/whatever"])).toBe("3.13");
  });

  it("lets an explicit --python win over both floors", () => {
    expect(interpreterOf(["--corpus", "polar", "--python", "3.12"])).toBe("3.12");
  });
});

describe("resolveCorpusRoots", () => {
  it("keeps the declared order — jedi searches the list front to back", () => {
    expect(resolveCorpusRoots(undefined, ["server", "sdk"], "/corpus")).toEqual(["/corpus/server", "/corpus/sdk"]);
  });

  it("passes an already-absolute root through untouched", () => {
    expect(resolveCorpusRoots(undefined, ["/elsewhere/src"], "/corpus")).toEqual(["/elsewhere/src"]);
  });

  it("returns the root itself when nothing is declared", () => {
    expect(resolveCorpusRoots(undefined, undefined, "/corpus")).toEqual(["/corpus"]);
    expect(resolveCorpusRoots(undefined, [], "/corpus")).toEqual(["/corpus"]);
  });

  it("treats an override of only separators as no override at all", () => {
    expect(resolveCorpusRoots(" , ", ["server"], "/corpus")).toEqual(["/corpus"]);
  });
});

describe("askOracle", () => {
  /**
   * The child is a node echo rather than jedi: what is under test is the CONFIG
   * line, and the roots reaching the Python side is the whole of the 7dsyq host
   * change. It replies with one file record whose relPath carries the config
   * back, which is enough for the reader loop to accept it.
   */
  const ECHO = [
    "node",
    "-e",
    [
      "let buf='';process.stdin.on('data',d=>buf+=d);",
      "process.stdin.on('end',()=>{",
      "const config=buf.split('\\n')[0];",
      "process.stdout.write(JSON.stringify({relPath:config,parseFailed:false,parsoErrors:0,answers:[]})+'\\n');",
      "});",
    ].join(""),
  ];

  it("hands the corpus root, the venv and the source roots to the child", async () => {
    const replies = await askOracle([], {
      corpusRoot: "/corpus",
      python: ECHO,
      venvPython: "/venv/bin/python",
      roots: ["/corpus/server"],
      workers: 4,
    });
    const [config] = [...replies.keys()];
    expect(JSON.parse(config ?? "{}")).toEqual({
      kind: "config",
      corpusRoot: "/corpus",
      venvPython: "/venv/bin/python",
      roots: ["/corpus/server"],
      workers: 4,
    });
  });
});

describe("buildRows", () => {
  const site = (overrides: Record<string, unknown> = {}) =>
    ({
      relPath: "pkg/a.py",
      call: call("f"),
      ctx,
      receiverKind: "bareCall",
      chain: null,
      answeredBy: "none",
      missBucket: "miss",
      ...overrides,
    }) as never;

  const reply = (answers: Record<string, unknown>[], overrides: Record<string, unknown> = {}) =>
    new Map([
      [
        "pkg/a.py",
        {
          relPath: "pkg/a.py",
          parseFailed: false,
          parsoErrors: 0,
          answers,
          ...overrides,
        },
      ],
    ] as never);

  it("marks every row of a parso-damaged file degraded", () => {
    const rows = buildRows([site()], reply([], { parsoErrors: 3 }));
    expect(rows[0]?.oracleDegraded).toBe(true);
  });

  it("scores a classifier-external site with in-project truth as skippedInProject", () => {
    const rows = buildRows(
      [site({ missBucket: "external" })],
      reply([
        {
          startLine: 1,
          member: "f",
          outcome: {
            kind: "inProject",
            origin: "project",
            targets: [{ relPath: "pkg/b.py", symbolId: "B#f", pinUncertain: false }],
          },
        },
      ]),
    );
    expect(rows[0]?.verdict).toBe("skippedInProject");
  });

  it("gives a site with no reply an unknown verdict rather than inventing one", () => {
    expect(buildRows([site()], new Map())[0]?.verdict).toBe("bothUnresolved");
  });

  it("withdraws jedi's typeshed answer on a super() site instead of scoring the chain against it", () => {
    const rows = buildRows(
      [
        site({
          // The kind the classifier really assigns to `super().__init__(name)`.
          receiverKind: "dynamic",
          call: { ...call("__init__"), receiver: "super()" },
          chain: { targetRelPath: "pkg/named.py", targetSymbolId: "Named#__init__" },
        }),
      ],
      reply([
        {
          startLine: 1,
          member: "__init__",
          outcome: { kind: "external", origin: "typeshedStub" },
          siteFacts: {
            receiverIsAnnotatedParam: false,
            enclosingHasReturnAnnotation: false,
            viaReexport: false,
            viaStarImport: false,
            isSuperCall: true,
            targetIsProperty: false,
            targetIsStaticOrClassMethod: false,
            receiverIsUnion: false,
            isDecoratorSite: false,
          },
        },
      ]),
    );
    // jedi answered `object.__init__` from its bundled typeshed because it walks
    // only the FIRST base. Booking that as `phantom` would blame the chain for
    // being right.
    expect(rows[0]?.verdict).toBe("chainOnly");
    expect(rows[0]?.categories).toEqual(["superMro"]);
  });

  it("still scores a NON-super typeshed answer as external truth", () => {
    const rows = buildRows(
      [
        site({
          receiverKind: "localVar",
          chain: { targetRelPath: "pkg/b.py", targetSymbolId: "B#f" },
        }),
      ],
      reply([
        {
          startLine: 1,
          member: "f",
          outcome: { kind: "external", origin: "typeshedStub" },
        },
      ]),
    );
    expect(rows[0]?.verdict).toBe("phantom");
  });
});
