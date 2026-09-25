/**
 * Python type-abstractness census (bd tea-rags-mcp-r8hme.8). A class is
 * abstract when it declares itself so — an `ABC` / `Protocol` base (bare,
 * module-qualified or subscripted), an `ABCMeta` metaclass — or when it declares
 * an `@abstractmethod`. Every other class is concrete.
 */
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new PythonLanguage(), PyLang, src, "app/a.py", "python");

describe("Python walker — type-abstractness census", () => {
  it("reads ABC and Protocol bases, an ABCMeta metaclass and @abstractmethod as abstract", () => {
    const src = [
      "import abc",
      "from typing import Protocol",
      "class A(ABC):",
      "    pass",
      "class B(abc.ABC):",
      "    pass",
      "class P(Protocol[T]):",
      "    def m(self) -> int: ...",
      "class M(metaclass=ABCMeta):",
      "    pass",
      "class H(Base):",
      "    @abc.abstractmethod",
      "    def run(self): pass",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 5, concreteTypeCount: 0 });
  });

  it("counts every other class as concrete, nested ones included", () => {
    const src = [
      "class Service(Base):",
      "    def run(self):",
      "        return 1",
      "    class Config:",
      "        pass",
      "@dataclass",
      "class Row:",
      "    id: int",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 3 });
  });
});
