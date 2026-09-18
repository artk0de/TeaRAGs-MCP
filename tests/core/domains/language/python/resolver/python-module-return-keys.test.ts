/**
 * Module-level return facts are keyed PER FILE, and `-> Self` is substituted on
 * the call-result binding path (bd tea-rags-mcp-1v12o.1.7 E5.1c, bd
 * tea-rags-mcp-1v12o.1.6 E5.1b).
 *
 * E5.1a left the channel keying a top-level `def` by its BARE name and folding
 * it run-global first-write-wins, so polar's six `get_client` defs shared one
 * entry and the call-result arm needed a provenance guard to tell them apart.
 * `<relPath>::<name>` makes the collision impossible instead of detectable: the
 * caller's own import binding names the FILE, and the file names the fact.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type ImportRef,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonCallBindingPorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { pythonCallBindingType } from "../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
import { pythonModuleReturnKey } from "../../../../../../src/core/domains/language/python/walker/passes/python-type-channels.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const instance = (name: string): TypeRef => ({ form: "instance", name });

/** Two files, one name, two different returns — the shape a bare key conflates. */
const TWO_MAKERS = tableWith({
  "app/alpha.py": [{ symbolId: "make" }, { symbolId: "Alpha" }],
  "app/beta.py": [{ symbolId: "make" }, { symbolId: "Beta" }],
  "app/caller.py": [{ symbolId: "run" }],
});

const TWO_MAKER_RETURNS: Record<string, TypeRef> = {
  [pythonModuleReturnKey("app/alpha.py", "make")]: instance("Alpha"),
  [pythonModuleReturnKey("app/beta.py", "make")]: instance("Beta"),
};

function ctxWith(parts: Partial<CallContext> & Pick<CallContext, "callerFile">): CallContext {
  return {
    callerScope: [],
    imports: [],
    symbolTable: TWO_MAKERS,
    ...parts,
  };
}

const bindingType = (callee: string, ctx: CallContext): TypeRef | undefined => {
  const mapper = new PythonImportFileMapper();
  const linearizers = new PythonAncestorLinearizerCache(mapper, DEFAULT_AMBIGUOUS_RESOLVE_MODE);
  return pythonCallBindingType(callee, 10, ctx, createPythonCallBindingPorts(mapper, linearizers), mapper);
};

describe("pythonCallBindingType — a module-level return fact is addressed per FILE", () => {
  it("gives each caller the return of the `make` ITS import names", () => {
    const alpha = ctxWith({
      callerFile: "app/caller.py",
      imports: [importOf("app.alpha", "make")],
      structuredReturnTypes: TWO_MAKER_RETURNS,
    });
    const beta = ctxWith({
      callerFile: "app/caller.py",
      imports: [importOf("app.beta", "make")],
      structuredReturnTypes: TWO_MAKER_RETURNS,
    });
    expect(bindingType("make", alpha)).toEqual(instance("Alpha"));
    expect(bindingType("make", beta)).toEqual(instance("Beta"));
  });

  it("reads the caller's OWN file for a same-file callee with no import", () => {
    const ctx = ctxWith({ callerFile: "app/alpha.py", structuredReturnTypes: TWO_MAKER_RETURNS });
    expect(bindingType("make", ctx)).toEqual(instance("Alpha"));
  });

  it("refuses when no binding names a file — never first-write-wins", () => {
    const ctx = ctxWith({ callerFile: "app/caller.py", structuredReturnTypes: TWO_MAKER_RETURNS });
    expect(bindingType("make", ctx)).toBeUndefined();
  });

  it("tolerates a BARE-keyed row persisted by an older run — no fact, no throw", () => {
    // bd tea-rags-mcp-8qyax persists the channel; a slice written before this
    // key change carries `make` rather than `app/alpha.py::make`. Readers ask
    // for the qualified key only, so the stale row is silence.
    const ctx = ctxWith({
      callerFile: "app/caller.py",
      imports: [importOf("app.alpha", "make")],
      structuredReturnTypes: { make: instance("Beta") },
    });
    expect(bindingType("make", ctx)).toBeUndefined();
  });
});

describe("pythonCallBindingType — `-> Self` binds the RECEIVER's class", () => {
  const SELF_TABLE = tableWith({
    "repo/base.py": [
      { symbolId: "RepositoryBase" },
      { symbolId: "RepositoryBase.from_session", scope: ["RepositoryBase"] },
      { symbolId: "RepositoryBase#with_org", scope: ["RepositoryBase"] },
    ],
    "repo/sub.py": [{ symbolId: "CustomerRepository" }],
    "svc/use.py": [{ symbolId: "run" }],
  });
  // The KEY is a class address (`<relPath>::<fq>`); the VALUE is the base as the
  // subclass SPELLS it — module text, resolved through the import mapper.
  const ANCESTORS = { "repo/sub.py::CustomerRepository": ["repo.base::RepositoryBase"] };

  const selfCtx = (extra: Partial<CallContext>): CallContext => ({
    callerFile: "svc/use.py",
    callerScope: [],
    imports: [importOf("repo.sub", "CustomerRepository")],
    symbolTable: SELF_TABLE,
    classAncestors: ANCESTORS,
    ...extra,
  });

  it("substitutes the CLASS a class-form receiver names, not the declaring one", () => {
    const ctx = selfCtx({ structuredReturnTypes: { "RepositoryBase.from_session": instance("Self") } });
    expect(bindingType("CustomerRepository.from_session", ctx)).toEqual(instance("CustomerRepository"));
  });

  it("substitutes the receiver's own type on an INSTANCE receiver", () => {
    const ctx = selfCtx({
      structuredReturnTypes: { "RepositoryBase#with_org": instance("Self") },
      localBindings: { repo: [{ line: 1, type: "CustomerRepository" }] },
    });
    expect(bindingType("repo.with_org", ctx)).toEqual(instance("CustomerRepository"));
  });

  it("yields NO fact when the receiver itself is untyped", () => {
    const ctx = selfCtx({ structuredReturnTypes: { "RepositoryBase#with_org": instance("Self") } });
    expect(bindingType("whatever.with_org", ctx)).toBeUndefined();
  });
});
