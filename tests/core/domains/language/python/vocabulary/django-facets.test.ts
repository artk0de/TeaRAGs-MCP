/**
 * P5 Django facets (bd tea-rags-mcp-m99j1.1.21): the members Django synthesizes
 * on every model — `objects`, `_default_manager`, `_base_manager`, `_meta` — and
 * the query verbs on its managers and querysets, answered through the kernel
 * `frameworkReturnType` port; plus the self-package rule that turns a corpus
 * declaring `name='Django'` into a Django project.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { propagateReceiverType } from "../../../../../../src/core/domains/language/kernel/index.js";
import { PYTHON_DEPENDENCY_MANIFEST } from "../../../../../../src/core/domains/language/python/manifest.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { pythonVocabularyFor } from "../../../../../../src/core/domains/language/python/vocabulary/frameworks/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { readDeclaredDependencies } from "../../../../../../src/core/infra/dependency-manifests.js";

function table(): InMemoryGlobalSymbolTable {
  const built = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries({
    "shop/models.py": ["Book", "Book#save", "Author", "Author#name_display", "BookManager"],
    "shop/views.py": ["show"],
  })) {
    built.upsertFile(
      relPath,
      symbolIds.map((symbolId) => {
        const [owner, member] = symbolId.split("#");
        return {
          symbolId,
          fqName: symbolId,
          shortName: member ?? owner,
          relPath,
          scope: member === undefined ? [] : [owner],
        };
      }),
    );
  }
  return built;
}

function ctx(declaredDependencies?: ReadonlySet<string>): CallContext {
  return {
    callerFile: "shop/views.py",
    callerScope: ["show"],
    imports: [{ importText: "shop.models", startLine: 1, importedNames: ["Book"], importedBindings: { Book: "Book" } }],
    symbolTable: table(),
    classAncestors: { "shop/models.py::Book": ["models.Model"], "shop/models.py::Author": ["models.Model"] },
    ...(declaredDependencies === undefined ? {} : { declaredDependencies }),
  };
}

const fold = (receiver: string, context: CallContext) =>
  propagateReceiverType(receiver, 10, context, createPythonReceiverTypePorts(new PythonImportFileMapper()));

describe("Django model attributes and query verbs", () => {
  it("Model.objects.filter(x).first() folds to the model instance, so .save() lands on Book#save", () => {
    expect(fold("Book.objects.filter(x).first()", ctx())).toEqual({ form: "instance", name: "Book" });
  });

  it("_default_manager / _base_manager are managers of the model", () => {
    expect(fold("Book._default_manager.get(pk=1)", ctx())).toEqual({ form: "instance", name: "Book" });
    expect(fold("Book._base_manager.using(db).all().last()", ctx())).toEqual({ form: "instance", name: "Book" });
  });

  it("Model.objects.db_manager(alias) is the same manager, so the verb after it resolves as without the hop", () => {
    expect(fold('Book.objects.db_manager("x").get(pk=1)', ctx())).toEqual(fold("Book.objects.get(pk=1)", ctx()));
    expect(fold('Book.objects.db_manager("x").get(pk=1)', ctx())).toEqual({ form: "instance", name: "Book" });
    expect(fold('Book.objects.db_manager("x").filter(a=1).first()', ctx())).toEqual({ form: "instance", name: "Book" });
  });

  it("Model.objects.using(alias) is a queryset of the same model, so the verb after it resolves as without the hop", () => {
    expect(fold('Book.objects.using("x").filter(a=1).first()', ctx())).toEqual({ form: "instance", name: "Book" });
  });

  it("db_manager on a custom manager subclass (ContentTypeManager shape) stays on that manager", () => {
    const custom: CallContext = {
      ...ctx(),
      classFieldTypes: { Book: { objects: "BookManager" } },
      classFieldTypesByClassKey: { "shop/models.py::Book": { objects: "BookManager" } },
      classAncestors: {
        "shop/models.py::Book": ["models.Model"],
        "shop/models.py::BookManager": ["models.Manager"],
      },
    };
    const direct = fold("Book.objects", custom);
    expect(direct).toEqual({ form: "instance", name: "BookManager" });
    expect(fold('Book.objects.db_manager("x")', custom)).toEqual(direct);
  });

  it("db_manager yields no type where Django is not a dependency", () => {
    expect(fold('Book.objects.db_manager("x").get(pk=1)', ctx(new Set(["flask"])))).toBeUndefined();
  });

  it("model._meta is Django's Options, so _meta.get_field(n) reaches Options#get_field", () => {
    expect(fold("Book._meta", ctx())).toEqual({ form: "instance", name: "Options" });
  });

  it("a class that does not descend from Model gets no synthesized attribute", () => {
    expect(
      fold("Author.objects.first()", { ...ctx(), classAncestors: { "shop/models.py::Author": ["Base"] } }),
    ).toBeUndefined();
  });

  it("a project that declares dependencies without Django gets no Django facet", () => {
    expect(fold("Book.objects.filter(x).first()", ctx(new Set(["flask"])))).toBeUndefined();
  });
});

describe("Django attributes typed by NAME on an untyped owner (bd tea-rags-mcp-m99j1.1.37)", () => {
  it("model._meta on an untyped model is Options, so _meta.get_field(n) reaches Options#get_field", () => {
    expect(fold("model._meta", ctx())).toEqual({ form: "instance", name: "Options" });
    expect(fold("self.model._meta", ctx())).toEqual({ form: "instance", name: "Options" });
  });

  it("obj._default_manager / _base_manager on an untyped owner are Django's Manager, naming no model", () => {
    expect(fold("obj._default_manager", ctx())).toEqual({ form: "instance", name: "Manager" });
    expect(fold("self.UserModel._base_manager", ctx())).toEqual({ form: "instance", name: "Manager" });
    expect(fold('self.UserModel._default_manager.db_manager("x")', ctx())).toEqual({
      form: "instance",
      name: "Manager",
    });
  });

  it("a typed model keeps its model-carrying manager", () => {
    expect(fold("Book._default_manager", ctx())).toEqual({
      form: "instance",
      name: "Manager",
      args: [{ form: "instance", name: "Book" }],
    });
  });

  it("x.objects with an untyped x stays untyped: `objects` is not unique to Django", () => {
    expect(fold("x.objects", ctx())).toBeUndefined();
    expect(fold("x.objects.all()", ctx())).toBeUndefined();
  });

  it("is inert where Django is not a declared dependency", () => {
    expect(fold("model._meta", ctx(new Set(["flask"])))).toBeUndefined();
    expect(fold("obj._default_manager", ctx(new Set(["flask"])))).toBeUndefined();
  });
});

describe("the self-package rule", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the distribution name from setup.py, setup.cfg and pyproject.toml, PEP 503-normalized", () => {
    const read = PYTHON_DEPENDENCY_MANIFEST.parseSelfPackageName;
    expect(read?.("setup.py", "setup(\n    name='Django',\n    version=version,\n)")).toBe("django");
    expect(read?.("setup.cfg", "[metadata]\nname = Django_Extensions\n")).toBe("django-extensions");
    expect(read?.("pyproject.toml", '[project]\nname = "My.Pkg"\ndependencies = []\n')).toBe("my-pkg");
    expect(read?.("setup.py", "setup(version='1')")).toBeUndefined();
  });

  it("a corpus whose setup.py declares name='Django' activates the django vocabulary with no manifest dependency", () => {
    dir = mkdtempSync(join(tmpdir(), "django-self-"));
    writeFileSync(join(dir, "requirements.txt"), "pytz\nsqlparse\n");
    writeFileSync(join(dir, "setup.py"), "from setuptools import setup\nsetup(name='Django')\n");
    const declared = readDeclaredDependencies(dir, [PYTHON_DEPENDENCY_MANIFEST]);
    expect(declared?.has("django")).toBe(true);
    expect(pythonVocabularyFor(declared).hasFacet("modelAttributes")).toBe(true);
  });

  it("a self-package declaration alone is not a dependency manifest: no manifest still means every vocabulary", () => {
    dir = mkdtempSync(join(tmpdir(), "django-self-"));
    writeFileSync(join(dir, "setup.py"), "setup(name='foo')\n");
    expect(readDeclaredDependencies(dir, [PYTHON_DEPENDENCY_MANIFEST])).toBeUndefined();
  });
});
