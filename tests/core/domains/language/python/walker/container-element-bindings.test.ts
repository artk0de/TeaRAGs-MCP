/**
 * Container element facts, walker half (bd tea-rags-mcp-m99j1.1.41).
 *
 * An UNANNOTATED container — a `self.<field>` or a def-local initialised to an
 * empty display — learns its element from what is written into it
 * (`f[k] = v`, `f.append(v)`, `f.add(v)`, `f.setdefault(k, v)`) or from the
 * comprehension that builds it. The walker cannot type the written value (a
 * call's return lives in other files), so it records the element as a DERIVED
 * binding on the pseudo-name `<iterable>[]` for the resolver to fold — and only
 * when every observed write spells the same value.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function bindingsOf(lines: readonly string[]): Record<string, LocalBinding[]> {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const src = lines.join("\n");
  const extraction = extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/registry.py",
    language: "python",
    chunks: [{ symbolId: "whole", scope: [], startLine: 1, endLine: lines.length }],
  });
  return extraction.chunks[0].localBindings ?? {};
}

const valueOf = (line: number, sourceExpression: string): LocalBinding => ({
  line,
  type: "",
  valueKind: "tupleElement",
  sourceExpression,
});

const elementOf = (line: number, sourceExpression: string): LocalBinding => ({
  line,
  type: "",
  valueKind: "iterationElement",
  sourceExpression,
});

describe("Python walker — container element facts from writes", () => {
  it("django Apps.populate: a mapping field written from a call-result local types `.values()` at the reading def", () => {
    const bindings = bindingsOf([
      "class Apps:",
      "    def __init__(self):",
      "        self.app_configs = {}",
      "    def populate(self, installed_apps):",
      "        for entry in installed_apps:",
      "            app_config = AppConfig.create(entry)",
      "            self.app_configs[app_config.label] = app_config",
      "        for app_config in self.app_configs.values():",
      "            app_config.import_models()",
    ]);
    expect(bindings["self.app_configs.values()[]"]).toEqual([valueOf(4, "AppConfig.create()")]);
    // A mapping iterates its KEYS: the bare spelling carries nothing.
    expect(bindings["self.app_configs[]"]).toBeUndefined();
  });

  it("django set/unset_available_apps: a filtering self-copy and a stash restore add no element", () => {
    const bindings = bindingsOf([
      "class Apps:",
      "    def __init__(self):",
      "        self.app_configs = {}",
      "        self.stored_app_configs = []",
      "    def populate(self):",
      "        self.app_configs['x'] = AppConfig(1)",
      "        for app_config in self.app_configs.values():",
      "            app_config.import_models()",
      "    def set_available_apps(self, available):",
      "        self.stored_app_configs.append(self.app_configs)",
      "        self.app_configs = {",
      "            label: app_config",
      "            for label, app_config in self.app_configs.items()",
      "            if app_config.name in available",
      "        }",
      "    def unset_available_apps(self):",
      "        self.app_configs = self.stored_app_configs.pop()",
    ]);
    // `set_available_apps` iterates `.items()` in its comprehension, so it reads the fact too.
    expect(bindings["self.app_configs.values()[]"]).toEqual([valueOf(5, "AppConfig()"), valueOf(9, "AppConfig()")]);
  });

  it("a restore from a stash that also holds foreign values refuses the container", () => {
    const bindings = bindingsOf([
      "class Apps:",
      "    def __init__(self):",
      "        self.app_configs = {}",
      "        self.stored = []",
      "    def populate(self, other):",
      "        self.app_configs['x'] = AppConfig(1)",
      "        self.stored.append(Other())",
      "        self.app_configs = self.stored.pop()",
      "        for c in self.app_configs.values():",
      "            c.ready()",
    ]);
    expect(bindings["self.app_configs.values()[]"]).toBeUndefined();
  });

  it("a local list appended a constructed value types the bare iteration", () => {
    const bindings = bindingsOf([
      "def run(rows):",
      "    items = []",
      "    for row in rows:",
      "        items.append(Item(row))",
      "    for item in items:",
      "        item.save()",
    ]);
    expect(bindings["items[]"]).toEqual([valueOf(2, "Item()")]);
  });

  it("a set field filled through `.add` and a mapping field through `.setdefault`", () => {
    const bindings = bindingsOf([
      "class Hub:",
      "    def __init__(self):",
      "        self.seen = set()",
      "        self.by_key = dict()",
      "    def feed(self, k):",
      "        self.seen.add(Node(k))",
      "        self.by_key.setdefault(k, Node(k))",
      "    def walk(self):",
      "        for n in self.seen:",
      "            n.visit()",
      "        for n in self.by_key.values():",
      "            n.visit()",
    ]);
    expect(bindings["self.seen[]"]).toEqual([valueOf(8, "Node()")]);
    expect(bindings["self.by_key.values()[]"]).toEqual([valueOf(8, "Node()")]);
  });

  it("a typed parameter written into a list names its class", () => {
    const bindings = bindingsOf([
      "def collect(op: Operation):",
      "    ops = []",
      "    ops.append(op)",
      "    for o in ops:",
      "        o.reduce()",
    ]);
    expect(bindings["ops[]"]).toEqual([valueOf(2, "Operation()")]);
  });

  it("records nothing when two writes spell different values", () => {
    const bindings = bindingsOf([
      "def run():",
      "    items = []",
      "    items.append(Item())",
      "    items.append(Other())",
      "    for item in items:",
      "        item.save()",
    ]);
    expect(bindings["items[]"]).toBeUndefined();
  });

  it("records nothing when a write is unseen (`extend`), unfoldable, or the container is rebound", () => {
    const extended = bindingsOf(["def run(xs):", "    items = []", "    items.append(Item())", "    items.extend(xs)"]);
    expect(extended["items[]"]).toBeUndefined();
    const unfoldable = bindingsOf(["def run(xs):", "    items = []", "    items.append(xs[0])"]);
    expect(unfoldable["items[]"]).toBeUndefined();
    const rebound = bindingsOf(["def run(xs):", "    items = []", "    items.append(Item())", "    items = load()"]);
    expect(rebound["items[]"]).toBeUndefined();
    const fromParam = bindingsOf([
      "def run(items):",
      "    items.append(Item())",
      "    for i in items:",
      "        i.save()",
    ]);
    expect(fromParam["items[]"]).toBeUndefined();
  });

  it("an annotated field is the annotation's to type, not the writes'", () => {
    const bindings = bindingsOf([
      "class Apps:",
      "    def __init__(self):",
      "        self.app_configs: dict[str, AppConfig] = {}",
      "    def populate(self):",
      "        self.app_configs['x'] = Other()",
      "        for c in self.app_configs.values():",
      "            c.ready()",
    ]);
    expect(bindings["self.app_configs.values()[]"]).toBeUndefined();
  });

  it("a written local whose head is another def-local is declined — the reader cannot see it", () => {
    const bindings = bindingsOf([
      "def run(factory):",
      "    items = []",
      "    items.append(factory.build())",
      "    for i in items:",
      "        i.save()",
    ]);
    expect(bindings["items[]"]).toBeUndefined();
  });
});

describe("Python walker — comprehension value facts", () => {
  it("polar metrics: an identity comprehension with a filter iterates like its source", () => {
    const bindings = bindingsOf([
      'def query(metrics: list["type[SQLMetric]"]):',
      "    active = [",
      "        metric for metric in metrics if metric.query == 1",
      "    ]",
      "    return [metric.get_sql_expression() for metric in active]",
    ]);
    // The source's annotation names the element, so the walker types it outright.
    expect(bindings["active[]"]).toEqual([{ line: 2, type: "SQLMetric", valueKind: "class" }]);
  });

  it("an identity comprehension over an UNANNOTATED source defers to the source's iteration", () => {
    const bindings = bindingsOf(["def query(metrics):", "    active = [m for m in metrics if m.ok]"]);
    expect(bindings["active[]"]).toEqual([elementOf(2, "metrics")]);
  });

  it("a constructing comprehension types its element; a projecting one stays silent", () => {
    const bindings = bindingsOf([
      "def run(rows):",
      "    built = [Item(r) for r in rows]",
      "    names = [r.name for r in rows]",
      "    nested = [x for r in rows for x in r]",
    ]);
    expect(bindings["built[]"]).toEqual([valueOf(2, "Item()")]);
    expect(bindings["names[]"]).toBeUndefined();
    expect(bindings["nested[]"]).toBeUndefined();
  });

  it("a dict comprehension keyed off its element types the `.values()` view", () => {
    const bindings = bindingsOf(["def run(rows):", "    by_id = {r.id: r for r in rows}"]);
    expect(bindings["by_id.values()[]"]).toEqual([elementOf(2, "rows")]);
    expect(bindings["by_id[]"]).toBeUndefined();
  });
});
