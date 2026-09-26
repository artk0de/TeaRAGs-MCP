import { describe, expect, it } from "vitest";

import { extractImportsExports } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/utils/import-extractor.js";

/**
 * bd tea-rags-mcp-mjq5n — `payload.imports` must name only specifiers that a
 * real import statement / require call in CODE declares. Import-shaped text in
 * a comment, a docstring, or a string / template literal is prose or data, not
 * a dependency. Every fixture below mixes one real import with phantom
 * import-shaped text, so the invariant is "exactly the real set", not "contains".
 */
describe("extractImportsExports — import-shaped text outside code (bd tea-rags-mcp-mjq5n)", () => {
  describe.each(["typescript", "javascript"])("%s", (language) => {
    it("ignores imports inside a JSDoc block comment", () => {
      const code = [
        `import { real } from "./real";`,
        `/**`,
        ` * Double-import edge case:`,
        ` *     import Button from './Button'`,
        ` *     import type { ButtonProps } from './Button'`,
        ` */`,
        `export function f() { return real; }`,
      ].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["./real"]);
    });

    it("ignores imports and requires inside line comments", () => {
      const code = [
        `const fs = require("fs");`,
        `// import { x } from "./x";`,
        `// const y = require("./y");`,
        `// so \`import { … } from ".../qdrant/client.js"\` keeps working`,
      ].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["fs"]);
    });

    it("ignores imports inside string literals", () => {
      const code = [
        `import a from "./a";`,
        `const probe = "import { useState } from 'react'; const z = require('zlib');";`,
        `const other = 'import x from "./x"';`,
      ].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["./a"]);
    });

    it("ignores imports inside template literals but keeps requires in ${} code", () => {
      const code = [
        "import a from './a';",
        "const fixture = `",
        "import Foo from './y';",
        "const m = require('./m');",
        "`;",
        `const lazy = \`\${require('./lazy')}\`;`,
      ].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["./a", "./lazy"]);
    });

    it("is not derailed by quote characters inside a regex literal", () => {
      const code = [
        `const re = /import\\s+.*?\\s+from\\s+['"]([^'"]+)['"]/g;`,
        `const path = require("path");`,
        `// import z from "./z";`,
      ].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["path"]);
    });

    it("keeps real imports that follow a division operator", () => {
      const code = [`const half = total / 2; const q = 'x' / 1;`, `import b from "./b";`].join("\n");

      expect(extractImportsExports(code, language).imports).toEqual(["./b"]);
    });

    it("ignores exports named inside comments", () => {
      const code = [`// export function ghost() {}`, `export function real() {}`].join("\n");

      expect(extractImportsExports(code, language).exports).toEqual(["real"]);
    });
  });

  describe("python", () => {
    it("ignores imports inside docstrings", () => {
      const code = [
        `import os`,
        `def f():`,
        `    """Usage:`,
        ``,
        `    from phantom.pkg import thing`,
        `    import ghost`,
        `    """`,
        `    return os.getcwd()`,
      ].join("\n");

      expect(extractImportsExports(code, "python").imports).toEqual(["os"]);
    });

    it("ignores imports inside comments and string literals", () => {
      const code = [
        `from typing import List  # import this too`,
        `# from phantom import x`,
        `SNIPPET = "import requests"`,
        `OTHER = 'from ghost import y'`,
        `RAW = r'''import raw_ghost'''`,
      ].join("\n");

      expect(extractImportsExports(code, "python").imports).toEqual(["typing"]);
    });

    it("does not capture a trailing comment into a plain import's specifier", () => {
      const code = `import sys  # needed for argv`;

      expect(extractImportsExports(code, "python").imports).toEqual(["sys"]);
    });

    it("ignores defs named inside a docstring", () => {
      const code = [`def real():`, `    '''`, `def ghost():`, `    '''`, `    pass`].join("\n");

      expect(extractImportsExports(code, "python").exports).toEqual(["real"]);
    });
  });
});
