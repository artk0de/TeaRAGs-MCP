import type { LanguageCapability } from "../../../contracts/types/language.js";
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
