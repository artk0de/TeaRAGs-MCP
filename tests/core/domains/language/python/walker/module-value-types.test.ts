/**
 * The module-level value channel (P4, bd tea-rags-mcp-m99j1.1.15).
 *
 * `apps = Apps(installed_apps=None)` at module scope in
 * `django/apps/registry.py` is what `from django.apps import apps` binds in
 * every caller; no symbol carries the name and no per-chunk channel reaches
 * another file. The walker publishes the value's type under
 * `<relPath>::<name>` on `moduleValueTypes`, and only for MODULE scope: a
 * function-local assignment is a local, and a name module scope binds twice
 * with different (or unknowable) values has no single type to publish.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { afterEach, describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { PYTHON_MODULE_VALUES_ENV } from "../../../../../../src/core/domains/language/python/walker/passes/python-module-value-facts.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function walk(lines: readonly string[], relPath = "django/apps/registry.py"): FileExtraction {
  const src = lines.join("\n");
  return new PythonLanguage().walker.walk({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

describe("moduleValueTypes — the walker's module-scope value channel", () => {
  afterEach(() => {
    delete process.env[PYTHON_MODULE_VALUES_ENV];
  });

  it("publishes a module-scope constructor assignment under <relPath>::<name>", () => {
    const out = walk([
      "class Apps:",
      "    def populate(self, x):",
      "        pass",
      "",
      "apps = Apps(installed_apps=None)",
    ]);
    expect(out.moduleValueTypes).toEqual({ "django/apps/registry.py::apps": { form: "instance", name: "Apps" } });
  });

  it("emits nothing for a function-local assignment", () => {
    const out = walk(["def build():", "    apps = Apps(installed_apps=None)", "    return apps"]);
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("emits nothing for an assignment in a class body", () => {
    const out = walk(["class Holder:", "    apps = Apps()"]);
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("reads an annotated module-level name, and the annotation outranks the right-hand side", () => {
    const out = walk([
      "from .base import Base, Registry",
      "registry: Registry = make_registry()",
      "other: Base = Child()",
    ]);
    expect(out.moduleValueTypes).toEqual({
      "django/apps/registry.py::registry": { form: "instance", name: "Registry" },
      "django/apps/registry.py::other": { form: "instance", name: "Base" },
    });
  });

  it("declines an annotation whose head module scope never binds — `TIMEOUT: int = 5`", () => {
    expect(walk(["TIMEOUT: int = 5", "LIMIT: Final = 3"]).moduleValueTypes).toBeUndefined();
  });

  it("keeps a qualified constructor spelling verbatim", () => {
    const out = walk(["import utils", "connections = utils.ConnectionHandler()"], "django/db/__init__.py");
    expect(out.moduleValueTypes).toEqual({
      "django/db/__init__.py::connections": { form: "instance", name: "utils.ConnectionHandler" },
    });
  });

  it("covers module-scope if / try blocks — they do not open a scope", () => {
    const out = walk(["try:", "    cache = Cache()", "except ImportError:", "    cache = Cache()"]);
    expect(out.moduleValueTypes).toEqual({ "django/apps/registry.py::cache": { form: "instance", name: "Cache" } });
  });

  it("declines a name module scope binds to two different types", () => {
    const out = walk(["try:", "    json = Fast()", "except ImportError:", "    json = Slow()"]);
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("declines a name module scope also binds to something untyped", () => {
    expect(walk(["client = None", "client = Client()"]).moduleValueTypes).toBeUndefined();
    expect(walk(["client = Client()", "client += 1"]).moduleValueTypes).toBeUndefined();
    expect(walk(["client = Client()", "for client in xs:", "    pass"]).moduleValueTypes).toBeUndefined();
    expect(walk(["client = Client()", "import client"]).moduleValueTypes).toBeUndefined();
  });

  it("declines a name a function rebinds through `global`", () => {
    const out = walk(["client = Client()", "def reset():", "    global client", "    client = Other()"]);
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("declines a typing special form — a factory or annotation from `typing` names no class", () => {
    const out = walk([
      "import typing",
      "from typing import NewType, TypeAlias, TypeVar",
      'UserId = NewType("UserId", int)',
      'T = TypeVar("T")',
      "Headers: TypeAlias = dict",
      "Limit: typing.Final = 3",
    ]);
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("declines a lowercase callee — a factory is not a constructor", () => {
    expect(walk(["client = make_client()"]).moduleValueTypes).toBeUndefined();
  });

  it("is switched off by CODEGRAPH_PY_MODULE_VALUES=false", () => {
    process.env[PYTHON_MODULE_VALUES_ENV] = "false";
    expect(walk(["apps = Apps()"]).moduleValueTypes).toBeUndefined();
  });
});
