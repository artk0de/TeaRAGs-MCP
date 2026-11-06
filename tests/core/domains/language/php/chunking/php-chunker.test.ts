import { describe, expect, it } from "vitest";

import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/index.js";
import { PhpLanguage } from "../../../../../../src/core/domains/language/php/index.js";

const factory: LanguageFactoryDescriptor = {
  create: (lang) => {
    if (lang !== "php") throw new Error(`unexpected language ${lang}`);
    return new PhpLanguage();
  },
  supported: () => ["php"],
  signalFloors: () => new Map(),
};

const chunker = new TreeSitterChunker(
  { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
  new DefaultSymbolIdComposer(),
  factory,
);

const SRC = `<?php
namespace App\\Demo;

class Greeter {
    public function greet(string $name): string {
        return $this->format(helper($name));
    }

    private function format(string $value): string {
        return strtoupper($value);
    }
}

function helper(string $name): string {
    $trimmed = trim($name);
    return strtoupper($trimmed);
}
`;

describe("TreeSitterChunker — php", () => {
  it("chunks a class method and a function on those nodes", async () => {
    const chunks = await chunker.chunk(SRC, "src/Greeter.php", "php");
    const symbolIds = chunks.map((chunk) => chunk.metadata.symbolId);
    expect(symbolIds).toContain("Greeter#greet");
    expect(symbolIds).toContain("Greeter#format");
    expect(symbolIds).toContain("helper");
    expect(symbolIds).not.toContain("App\\Demo\\Greeter#greet");
  });

  it("keeps a short interface method", async () => {
    const src = `<?php
interface Talk {
    public function hi(): void;
    public function longerSignatureForTheContainerFloor(string $name): void;
}
`;
    const chunks = await chunker.chunk(src, "src/Talk.php", "php");
    const symbolIds = chunks.map((chunk) => chunk.metadata.symbolId);
    expect(symbolIds).toContain("Talk#hi");
  });
});
