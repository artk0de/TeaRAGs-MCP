/**
 * Python type-abstractness census (bd tea-rags-mcp-r8hme.8). A class is
 * abstract when it declares itself so — an `ABC` / `Protocol` base (bare,
 * module-qualified or subscripted), an `ABCMeta` metaclass — or when it declares
 * an `@abstractmethod`. A class that declares behaviour of its own is concrete;
 * a class whose body is only an `__init__`, fields and property accessors
 * declares no behaviour — an Exception subclass, a dataclass — and counts as
 * neither (bd tea-rags-mcp-44cpv, decision c-1=a).
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

  it("counts a behaviour-declaring class as concrete, nested ones included", () => {
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

    // `Config` (an empty body) and `Row` (fields only) are behaviour-free
    // (44cpv c-1); only `Service`, which declares `run`, counts.
    expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 1 });
  });

  describe("behaviour-free classes (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an Exception subclass whose only def is __init__ as neither bucket", () => {
      const src = [
        "class PipelineError(Exception):",
        "    default_code = 'pipeline'",
        "    def __init__(self, code):",
        "        super().__init__(code)",
        "        self.code = code",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts field-only and assignment-only bodies as neither", () => {
      const src = [
        "class Point:",
        "    x: int",
        "    y: int = 0",
        "class Marker:",
        "    pass",
        "class Color(Enum):",
        "    RED = 1",
        "    GREEN = 2",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts property accessors as data and every other def as behaviour", () => {
      const src = [
        "class Accessors:",
        "    @property",
        "    def total(self):",
        "        return 1",
        "    @total.setter",
        "    def total(self, v):",
        "        pass",
        "class WithClassMethod:",
        "    @classmethod",
        "    def from_row(cls, row):",
        "        return cls()",
        "class WithStaticMethod:",
        "    @staticmethod",
        "    def helper():",
        "        pass",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 2 });
    });
  });
});
