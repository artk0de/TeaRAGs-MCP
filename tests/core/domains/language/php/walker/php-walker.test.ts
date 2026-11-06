import Parser from "tree-sitter";
import PhpGrammars from "tree-sitter-php";
import { describe, expect, it } from "vitest";

import type { MaterializedTree } from "../../../../../../src/core/contracts/types/ast.js";
import { collectSymbols, DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/index.js";
import { PhpLanguage } from "../../../../../../src/core/domains/language/php/index.js";
import { PHP_SCOPE_SEPARATOR } from "../../../../../../src/core/domains/language/php/kernel.js";
import { phpNameOf } from "../../../../../../src/core/domains/language/php/walker/name-of.js";

const SRC = `<?php
namespace App\\Demo;

use Foo\\Bar;
use Foo\\{Baz, Qux as Alias};
use function Foo\\bar;

class Greeter {
    private string $title;

    public function greet(string $name): string {
        $made = new Greeter();
        return $this->format(helper($name));
    }

    function format(string $value): string {
        return $this?->title($value);
    }
}

function helper(string $name): string {
    $trimmed = trim($name);
    Foo\\bar($name);
    return strtoupper($trimmed);
}
`;

function parse(src: string): MaterializedTree {
  const parser = new Parser();
  parser.setLanguage(PhpGrammars.php_only);
  return { rootNode: parser.parse(src).rootNode };
}

function walked(src: string = SRC) {
  const tree = parse(src);
  const chunks = collectSymbols(tree, phpNameOf, PHP_SCOPE_SEPARATOR, false, new DefaultSymbolIdComposer());
  const extraction = new PhpLanguage().walker.walk({
    tree,
    code: src,
    relPath: "src/Greeter.php",
    language: "php",
    chunks,
  });
  return { chunks, extraction };
}

describe("PHP walker", () => {
  it("records nullable and untyped fields, constants and calls assigned to locals", () => {
    const { extraction } = walked(`<?php
class Repo {
    public const TYPE = 'repo';
    public ?Other $nullable;
    public $untyped;
    public function run(?Other $input): ?Other {
        $copy = $this->make();
        $safe = $input?->fetch();
        $qualified = new \\Demo\\Other();
        return $copy;
    }
}
$outside = new Other();
`);
    expect(extraction.identifierDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TYPE", kind: "constant", ownerSymbolId: "Repo" }),
        expect.objectContaining({ name: "$nullable", kind: "field", typeName: "Other" }),
        expect.objectContaining({ name: "$untyped", kind: "field" }),
        expect.objectContaining({ name: "$input", kind: "param", typeName: "Other" }),
        expect.objectContaining({ name: "$copy", kind: "local", boundCallee: { receiver: "$this", member: "make" } }),
        expect.objectContaining({ name: "$safe", kind: "local", boundCallee: { receiver: "$input", member: "fetch" } }),
        expect.objectContaining({ name: "$qualified", kind: "local", typeName: "\\Demo\\Other" }),
        expect.objectContaining({ name: "run", kind: "return", typeName: "Other" }),
      ]),
    );
    expect(extraction.identifierDeclarations?.some((entry) => entry.name === "$outside")).toBe(false);
    expect(extraction.identifierDeclarations?.find((entry) => entry.name === "$untyped")?.typeName).toBeUndefined();
  });

  it("names a class method and a function, and does not prefix the namespace", () => {
    const { chunks } = walked();
    expect(chunks.map((chunk) => chunk.symbolId)).toEqual(["Greeter", "Greeter#greet", "Greeter#format", "helper"]);
  });

  it("extracts a class method call and a same-file function call onto the method chunk", () => {
    const { extraction } = walked();
    const greet = extraction.chunks.find((chunk) => chunk.symbolId === "Greeter#greet");
    expect(greet?.calls.map((call) => ({ receiver: call.receiver, member: call.member }))).toEqual([
      { receiver: "$this", member: "format" },
      { receiver: null, member: "helper" },
    ]);
    const greeter = extraction.chunks.find((chunk) => chunk.symbolId === "Greeter");
    expect(greeter?.calls).toEqual([]);
  });

  it("reads a nullsafe member call and records a qualified function call", () => {
    const { extraction } = walked();
    const format = extraction.chunks.find((chunk) => chunk.symbolId === "Greeter#format");
    expect(format?.calls.map((call) => ({ receiver: call.receiver, member: call.member }))).toEqual([
      { receiver: "$this", member: "title" },
    ]);
    const helper = extraction.chunks.find((chunk) => chunk.symbolId === "helper");
    expect(helper?.calls.map((call) => call.member)).toEqual(["trim", "Foo\\bar", "strtoupper"]);
  });

  it("records use targets, including a grouped use and a function use", () => {
    const { extraction } = walked();
    expect(extraction.imports.map((imp) => imp.importText)).toEqual(["Foo\\Bar", "Foo\\Baz", "Foo\\Qux", "Foo\\bar"]);
  });

  it("stamps kinds and declared visibility", () => {
    const { extraction } = walked();
    const byId = new Map(extraction.chunks.map((chunk) => [chunk.symbolId, chunk]));
    expect(byId.get("Greeter")?.symbolKind).toBe("class");
    expect(byId.get("Greeter")?.visibility).toBeUndefined();
    expect(byId.get("Greeter#greet")?.symbolKind).toBe("method");
    expect(byId.get("Greeter#greet")?.visibility).toBe("public");
    expect(byId.get("Greeter#format")?.visibility).toBe("public");
    expect(byId.get("helper")?.symbolKind).toBe("function");
  });

  it("records a field, a parameter, a constructed local and a return type", () => {
    const { extraction } = walked();
    const rows = extraction.identifierDeclarations ?? [];
    expect(rows).toContainEqual(
      expect.objectContaining({ name: "$title", kind: "field", ownerSymbolId: "Greeter", typeName: "string" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ name: "$name", kind: "param", ownerSymbolId: "Greeter#greet", typeName: "string" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        name: "$made",
        kind: "local",
        ownerSymbolId: "Greeter#greet",
        typeName: "Greeter",
        typeSource: "constructor",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ name: "greet", kind: "return", ownerSymbolId: "Greeter#greet", typeName: "string" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        name: "$trimmed",
        kind: "local",
        ownerSymbolId: "helper",
        boundCallee: { member: "trim" },
      }),
    );
    const greet = extraction.chunks.find((chunk) => chunk.symbolId === "Greeter#greet");
    expect(greet?.localBindings?.["$made"]).toEqual([{ line: 12, type: "Greeter" }]);
    expect(greet?.localBindings?.["$name"]).toBeUndefined();
  });

  it("extracts a scoped call onto the method that contains it", () => {
    const src = `<?php
class User {
    public function greet(string $who): string {
        $this->save($who);
        return Bar::make($who);
    }
}
`;
    const { extraction } = walked(src);
    const greet = extraction.chunks.find((chunk) => chunk.symbolId === "User#greet");
    expect(greet?.calls.map((call) => [call.receiver, call.member])).toEqual([
      ["$this", "save"],
      ["Bar", "make"],
    ]);
  });

  it("stamps a trait as class, the nearest kind the symbol vocabulary has", () => {
    const src = `<?php
trait Talk {
    public function hi(): void {}
}
`;
    const { extraction } = walked(src);
    expect(extraction.chunks.find((chunk) => chunk.symbolId === "Talk")?.symbolKind).toBe("class");
  });

  it("binds a typed parameter on the method chunk", () => {
    const src = `<?php
class Box {
    public function put(Greeter $repo): void {
        $repo->save();
    }
}
`;
    const { extraction } = walked(src);
    const put = extraction.chunks.find((chunk) => chunk.symbolId === "Box#put");
    expect(put?.localBindings?.["$repo"]).toEqual([{ line: 3, type: "Greeter" }]);
  });
});
