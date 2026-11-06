import { describe, expect, it } from "vitest";

import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/index.js";
import { KotlinLanguage } from "../../../../../../src/core/domains/language/kotlin/index.js";
import { signalFloors } from "../../../../../../src/core/domains/language/kotlin/signal-floors.js";

const factory: LanguageFactoryDescriptor = {
  create: (lang) => {
    if (lang !== "kotlin") throw new Error(`unexpected language ${lang}`);
    return new KotlinLanguage();
  },
  supported: () => ["kotlin"],
  signalFloors: () => new Map([["kotlin", signalFloors]]),
};

const chunker = new TreeSitterChunker(
  { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
  new DefaultSymbolIdComposer(),
  factory,
);

const SRC = `class Widget {
    fun draw() {
        this.paint()
    }

    fun paint() {
        val color = "blue"
        println(color)
    }
}

fun topLevel(name: String): String {
    return name.trim()
}
`;

describe("TreeSitterChunker — kotlin", () => {
  it("chunks a class method and a top-level function", async () => {
    const chunks = await chunker.chunk(SRC, "Widget.kt", "kotlin");
    const symbolIds = chunks.map((chunk) => chunk.metadata.symbolId);
    expect(symbolIds).toContain("Widget#draw");
    expect(symbolIds).toContain("Widget#paint");
    expect(symbolIds).toContain("topLevel");
  });

  it("joins a companion member with a dot", async () => {
    const src = `class Widget {
    companion object Factory {
        fun build(): Widget {
            return Widget()
        }
    }
}
`;
    const chunks = await chunker.chunk(src, "Widget.kt", "kotlin");
    const symbolIds = chunks.map((chunk) => chunk.metadata.symbolId);
    expect(symbolIds).toContain("Widget.Factory.build");
  });
});
