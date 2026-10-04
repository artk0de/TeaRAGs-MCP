import type { TestFileConventions } from "../../../contracts/types/file-classification.js";
import type { LanguageCapability } from "../../../contracts/types/language.js";
import { installTestFileConventions } from "../../../infra/file-classification/index.js";
import { capability as bashCapability } from "../bash/capability.js";
import { capability as goCapability } from "../go/capability.js";
import { capability as javaCapability } from "../java/capability.js";
import { capability as javascriptCapability } from "../javascript/capability.js";
import { capability as markdownCapability } from "../markdown/capability.js";
import { capability as pythonCapability } from "../python/capability.js";
import { capability as rubyCapability } from "../ruby/capability.js";
import { capability as rustCapability } from "../rust/capability.js";
import { capability as swiftCapability } from "../swift/capability.js";
import { capability as typescriptCapability } from "../typescript/capability.js";
import { aggregateTestFileConventions } from "./test-files.js";

/**
 * Native per-language capability descriptors, keyed by language — the map
 * behind `LanguageFactory.capabilities()`. Lives apart from the factory so a
 * reader that needs only the static ceiling (prime's per-index tier lines, via
 * the public barrel) does not load every provider: `factory.ts` imports each
 * `<lang>/index.ts` and its tree-sitter grammar at module load (~3.5 s
 * measured), while a `<lang>/capability.ts` imports nothing but a type.
 */
export function nativeLanguageCapabilities(): Map<string, LanguageCapability> {
  return new Map<string, LanguageCapability>([
    ["ruby", rubyCapability],
    ["typescript", typescriptCapability],
    ["javascript", javascriptCapability],
    ["python", pythonCapability],
    ["go", goCapability],
    ["java", javaCapability],
    ["rust", rustCapability],
    ["bash", bashCapability],
    ["swift", swiftCapability],
    ["markdown", markdownCapability],
  ]);
}

/**
 * Every language's test-file masks, aggregated once (bd tea-rags-mcp-vjz6s):
 * every call returns the same object, which is what the installed readers in
 * `infra/file-classification` key their caches on.
 */
export function languageTestFileConventions(): TestFileConventions {
  aggregatedTestFileConventions ??= aggregateTestFileConventions(nativeLanguageCapabilities());
  return aggregatedTestFileConventions;
}

let aggregatedTestFileConventions: TestFileConventions | undefined;

// `infra/file-classification` owns no language's test shapes, and its
// module-level readers (`classify`, scope detection, the codegraph exclusion)
// throw until something installs them. Installing on load of THIS module — the
// one every path into the language domain crosses: the factory, the public
// barrel, a worker's `import(languageModulePath)`, a harness script — makes the
// language domain being loaded the only precondition, so no entry point has to
// remember an explicit call and none can reach a reader in the wrong order.
installTestFileConventions(languageTestFileConventions());
