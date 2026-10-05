/**
 * A `Self` marker NESTED in a return — `-> list[Self]`, `-> tuple[Self, int]`,
 * `-> Iterator[Self]`, `-> Self | Other` — names the RECEIVER's class exactly
 * as a top-level `-> Self` does (bd tea-rags-mcp-m99j1.1.83).
 *
 * Before, `pythonSubstituteSelfReturn` replaced only a top-level marker, so the
 * literal `Self` reached the reader's element / position / arm read and was
 * looked up as a class name. The rule is the top-level one, unchanged: the
 * receiver's name replaces the marker, and an untyped receiver substitutes
 * nothing.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type ImportRef,
  type LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { pythonDerivedBindingType } from "../../../../../../src/core/domains/language/python/resolver/python-iteration-types.js";
import { pythonSubstituteSelfReturn } from "../../../../../../src/core/domains/language/python/resolver/python-member-return-types.js";
import {
  createPythonCallBindingPorts,
  createPythonReceiverTypePorts,
} from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { pythonCallBindingType } from "../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
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
const SELF = instance("Self");

describe("pythonSubstituteSelfReturn — a NESTED marker is the receiver's class", () => {
  it("substitutes a container element", () => {
    expect(pythonSubstituteSelfReturn({ form: "container", element: SELF }, "Repo")).toEqual({
      form: "container",
      element: instance("Repo"),
    });
  });

  it("substitutes every tuple position holding the marker, and only those", () => {
    expect(pythonSubstituteSelfReturn({ form: "tuple", elements: [SELF, instance("int"), SELF] }, "Repo")).toEqual({
      form: "tuple",
      elements: [instance("Repo"), instance("int"), instance("Repo")],
    });
  });

  it("substitutes a union arm and a marker nested two levels deep", () => {
    expect(
      pythonSubstituteSelfReturn(
        { form: "union", members: [{ form: "container", element: SELF }, { form: "nil" }] },
        "Repo",
      ),
    ).toEqual({ form: "union", members: [{ form: "container", element: instance("Repo") }, { form: "nil" }] });
  });

  it("substitutes a marker in a generic argument", () => {
    expect(pythonSubstituteSelfReturn({ form: "instance", name: "QuerySet", args: [SELF] }, "Repo")).toEqual({
      form: "instance",
      name: "QuerySet",
      args: [instance("Repo")],
    });
  });

  it("returns a fact with no marker by IDENTITY", () => {
    const fact: TypeRef = { form: "tuple", elements: [instance("A"), { form: "container", element: instance("B") }] };
    expect(pythonSubstituteSelfReturn(fact, "Repo")).toBe(fact);
  });

  it("keeps the top-level rule: a bare marker becomes an instance of the receiver", () => {
    expect(pythonSubstituteSelfReturn(SELF, "Repo")).toEqual(instance("Repo"));
    expect(pythonSubstituteSelfReturn(undefined, "Repo")).toBeUndefined();
  });
});

describe("readers of a nested `-> Self` declared in ANOTHER file", () => {
  // `RepositoryBase` lives in `repo/base.py`; the caller reaches it through a
  // subclass declared in `repo/sub.py` — the cross-file placement path
  // (pythonPlacedReturnFact) runs before the substitution.
  const TABLE = tableWith({
    "repo/base.py": [
      { symbolId: "RepositoryBase" },
      { symbolId: "RepositoryBase.list_all", scope: ["RepositoryBase"] },
      { symbolId: "RepositoryBase#split", scope: ["RepositoryBase"] },
      { symbolId: "RepositoryBase#__iter__", scope: ["RepositoryBase"] },
    ],
    "repo/sub.py": [
      { symbolId: "CustomerRepository" },
      { symbolId: "CustomerRepository#save", scope: ["CustomerRepository"] },
    ],
    "svc/use.py": [{ symbolId: "run" }],
  });
  const ANCESTORS = { "repo/sub.py::CustomerRepository": ["repo.base::RepositoryBase"] };
  const RETURNS: Record<string, TypeRef> = {
    "RepositoryBase.list_all": { form: "container", element: SELF },
    "RepositoryBase#split": { form: "tuple", elements: [SELF, instance("int")] },
    "RepositoryBase#__iter__": { form: "container", element: SELF },
  };

  const ctxWith = (extra: Partial<CallContext> = {}): CallContext => ({
    callerFile: "svc/use.py",
    callerScope: [],
    imports: [importOf("repo.sub", "CustomerRepository")],
    symbolTable: TABLE,
    classAncestors: ANCESTORS,
    structuredReturnTypes: RETURNS,
    ...extra,
  });

  const mapper = (): PythonImportFileMapper => new PythonImportFileMapper();

  it("binds `x = Cls.list_all()` to a container of the RECEIVER class", () => {
    const m = mapper();
    const ports = createPythonCallBindingPorts(m, new PythonAncestorLinearizerCache(m, DEFAULT_AMBIGUOUS_RESOLVE_MODE));
    expect(pythonCallBindingType("CustomerRepository.list_all", 10, ctxWith(), ports, m)).toEqual({
      form: "container",
      element: instance("CustomerRepository"),
    });
  });

  it("types a loop target over `Cls.list_all()` as the receiver class", () => {
    const m = mapper();
    const ports = createPythonReceiverTypePorts(
      m,
      new PythonAncestorLinearizerCache(m, DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    );
    const binding = {
      line: 5,
      type: "",
      valueKind: "iterationElement",
      sourceExpression: "CustomerRepository.list_all()",
    } as LocalBinding & { valueKind: "iterationElement" };
    expect(pythonDerivedBindingType(binding, ctxWith(), ports, m)).toEqual(instance("CustomerRepository"));
  });

  it("leaves an unpacking target over a MEMBER's tuple return untyped — the receiver read drops a tuple", () => {
    const m = mapper();
    const ports = createPythonReceiverTypePorts(
      m,
      new PythonAncestorLinearizerCache(m, DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    );
    const binding = {
      line: 5,
      type: "",
      valueKind: "tupleElement",
      sourceExpression: "repo.split()",
      tupleIndex: 0,
    } as LocalBinding & { valueKind: "tupleElement" };
    const ctx = ctxWith({ localBindings: { repo: [{ line: 1, type: "CustomerRepository" }] } });
    // `typeRefReceiverForm` collapses a tuple to nothing on the member read, so
    // the position is never taken — and in particular never as a class `Self`.
    expect(pythonDerivedBindingType(binding, ctx, ports, m)).toBeUndefined();
  });

  it("types a loop over an instance whose inherited `__iter__` yields `Iterator[Self]`", () => {
    const m = mapper();
    const ports = createPythonReceiverTypePorts(
      m,
      new PythonAncestorLinearizerCache(m, DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    );
    const binding = {
      line: 5,
      type: "",
      valueKind: "iterationElement",
      sourceExpression: "repo",
    } as LocalBinding & { valueKind: "iterationElement" };
    const ctx = ctxWith({ localBindings: { repo: [{ line: 1, type: "CustomerRepository" }] } });
    expect(pythonDerivedBindingType(binding, ctx, ports, m)).toEqual(instance("CustomerRepository"));
  });

  it("leaves an UNTYPED receiver's nested return untyped, as before", () => {
    const m = mapper();
    const ports = createPythonCallBindingPorts(m, new PythonAncestorLinearizerCache(m, DEFAULT_AMBIGUOUS_RESOLVE_MODE));
    expect(pythonCallBindingType("whatever.split", 10, ctxWith(), ports, m)).toBeUndefined();
  });
});
