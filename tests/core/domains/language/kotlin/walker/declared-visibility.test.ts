import KotlinLang from "@tree-sitter-grammars/tree-sitter-kotlin";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { KotlinLanguage } from "../../../../../../src/core/domains/language/kotlin/index.js";

const visibilityOf = (src: string) =>
  declaredVisibilityOf(new KotlinLanguage(), KotlinLang, src, "Widget.kt", "kotlin");

describe("Kotlin walker — declared visibility", () => {
  it("records private and the public default, and leaves internal unrecorded", () => {
    const src = [
      "class Widget {",
      "  fun paint() {}",
      "  private fun hide() {}",
      "  internal fun shared() {}",
      "}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      Widget: "public",
      "Widget#paint": "public",
      "Widget#hide": "private",
    });
  });
});
