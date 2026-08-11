import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createProjectFileProbe,
  mapImportToFile,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-path-mapper.js";

describe("mapImportToFile", () => {
  it("resolves relative paths against caller file", () => {
    const result = mapImportToFile("./bar", "src/foo.ts", { baseUrl: ".", paths: {} });
    expect(result).toBe("src/bar.ts");
  });

  it("resolves parent-relative paths", () => {
    const result = mapImportToFile("../utils/x", "src/a/b/foo.ts", { baseUrl: ".", paths: {} });
    expect(result).toBe("src/a/utils/x.ts");
  });

  it("applies tsconfig paths aliases", () => {
    const result = mapImportToFile("@/lib/foo", "src/foo.ts", {
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    });
    expect(result).toBe("src/lib/foo.ts");
  });

  it("returns null for bare npm imports", () => {
    expect(mapImportToFile("react", "src/foo.ts", { baseUrl: ".", paths: {} })).toBeNull();
    expect(mapImportToFile("@anthropic/sdk", "src/foo.ts", { baseUrl: ".", paths: {} })).toBeNull();
  });

  it("preserves existing .ts/.tsx extension when present", () => {
    expect(mapImportToFile("./bar.ts", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/bar.ts");
    expect(mapImportToFile("./view.tsx", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/view.tsx");
  });

  it("rewrites NodeNext .js/.jsx import suffixes to .ts/.tsx (actual source on disk)", () => {
    // TS NodeNext convention: src code writes `import "./foo.js"` but
    // the actual file is `./foo.ts`. Without this rewrite, codegraph
    // edges would target non-existent .js paths and fanIn/fanOut would
    // come back 0 against the .ts-keyed file table.
    expect(mapImportToFile("./config/index.js", "src/bootstrap/factory.ts", { baseUrl: ".", paths: {} })).toBe(
      "src/bootstrap/config/index.ts",
    );
    expect(mapImportToFile("./view.jsx", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/view.tsx");
  });

  it("applies exact-match tsconfig path alias (non-wildcard pattern)", () => {
    // tsconfig.json paths can declare exact aliases like
    //   { "constants": ["src/constants.ts"] }
    // — no `/*` suffix. The mapper's `pattern === importText` branch
    // resolves these directly against baseUrl.
    const result = mapImportToFile("constants", "src/foo.ts", {
      baseUrl: ".",
      paths: { constants: ["src/constants.ts"] },
    });
    expect(result).toBe("src/constants.ts");
  });

  it("exact-match alias with empty target list returns null", () => {
    // Drives the `if (!target) return null` defensive branch inside
    // the exact-match case — paths entry exists but the targets array
    // is empty (degenerate tsconfig).
    const result = mapImportToFile("constants", "src/foo.ts", {
      baseUrl: ".",
      paths: { constants: [] },
    });
    expect(result).toBeNull();
  });

  it("wildcard alias with empty target list returns null", () => {
    // Same defensive branch in the wildcard case — pattern matches
    // import prefix but targets array is empty.
    const result = mapImportToFile("@/foo", "src/foo.ts", {
      baseUrl: ".",
      paths: { "@/*": [] },
    });
    expect(result).toBeNull();
  });
});

const NO_ALIASES = { baseUrl: ".", paths: {} };

describe("mapImportToFile .tsx probing (bd tea-rags-mcp-f3zcy)", () => {
  it("maps a NodeNext .js specifier to the .tsx sibling when only .tsx exists", () => {
    // The React case the bug was filed for: `import { Button } from "./Button.js"`
    // where the file on disk is `Button.tsx`. Committing to `.ts` made the
    // import map to a path nothing matches, so the edge silently vanished.
    const exists = (rel: string) => rel === "src/Button.tsx";
    expect(mapImportToFile("./Button.js", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/Button.tsx");
  });

  it("prefers .ts over .tsx when both exist", () => {
    // Ambiguity is resolved by TS's own precedence, not by discovery order.
    expect(mapImportToFile("./Button.js", "src/Page.tsx", NO_ALIASES, () => true)).toBe("src/Button.ts");
  });

  it("maps an extensionless specifier to .tsx when only .tsx exists", () => {
    const exists = (rel: string) => rel === "src/Button.tsx";
    expect(mapImportToFile("./Button", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/Button.tsx");
  });

  it("falls back to the .d.ts declaration when neither source extension exists", () => {
    const exists = (rel: string) => rel === "src/types.d.ts";
    expect(mapImportToFile("./types.js", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/types.d.ts");
  });

  it("keeps the .ts default when no candidate exists — never fabricates a .tsx", () => {
    // Precision guard. A probe that finds nothing must leave the mapper
    // exactly where it was: a path that matches no file table entry is a
    // dropped edge, whereas a guessed `.tsx` would be a wrongFile phantom.
    expect(mapImportToFile("./Button.js", "src/Page.tsx", NO_ALIASES, () => false)).toBe("src/Button.ts");
  });

  it("keeps its .ts-only mapping when no probe is supplied", () => {
    // Regression guard for callers that hold no project root. Without an
    // oracle the mapper declines to guess and behaves exactly as before.
    expect(mapImportToFile("./Button.js", "src/Page.tsx", NO_ALIASES)).toBe("src/Button.ts");
    expect(mapImportToFile("./Button", "src/Page.tsx", NO_ALIASES)).toBe("src/Button.ts");
  });

  it("probes tsconfig alias targets as well as relative specifiers", () => {
    const exists = (rel: string) => rel === "src/components/Button.tsx";
    const result = mapImportToFile(
      "@/components/Button",
      "src/Page.tsx",
      {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      exists,
    );
    expect(result).toBe("src/components/Button.tsx");
  });

  it("never probes a specifier that already carries an explicit TS extension", () => {
    const exists = vi.fn(() => false);
    expect(mapImportToFile("./view.tsx", "src/foo.ts", NO_ALIASES, exists)).toBe("src/view.tsx");
    expect(mapImportToFile("./bar.ts", "src/foo.ts", NO_ALIASES, exists)).toBe("src/bar.ts");
    expect(exists).not.toHaveBeenCalled();
  });

  it("maps a .jsx specifier to .ts when the probe reports only a .ts sibling", () => {
    // `.jsx` still prefers `.tsx`, but a project that renamed the component
    // to plain `.ts` should not lose the edge either.
    const exists = (rel: string) => rel === "src/view.ts";
    expect(mapImportToFile("./view.jsx", "src/foo.ts", NO_ALIASES, exists)).toBe("src/view.ts");
  });
});

describe("mapImportToFile directory/index resolution (bd tea-rags-mcp-hzsxy)", () => {
  it("maps an extensionless specifier to the directory's index.tsx", () => {
    // The barrel-style directory module every React/TS project writes:
    // `import { Button } from "./components"` where the module IS
    // `components/index.tsx`. Probing only `components.{ts,tsx,d.ts}` found
    // nothing, so the edge landed on a path no file table entry matches.
    const exists = (rel: string) => rel === "src/components/index.tsx";
    expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/components/index.tsx");
  });

  it("maps an extensionless specifier to the directory's index.ts", () => {
    const exists = (rel: string) => rel === "src/components/index.ts";
    expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/components/index.ts");
  });

  it("prefers the sibling FILE over the directory index when both exist", () => {
    // tsc resolves a specifier as a file before it resolves it as a
    // directory, so a project holding BOTH `components.ts` and
    // `components/index.ts` must land on the file — the same precedence
    // question `.ts` over `.tsx` already answers one level up.
    const exists = (rel: string) => rel === "src/components.ts" || rel === "src/components/index.ts";
    expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/components.ts");
  });

  it("falls back to the directory's index.d.ts when no source index exists", () => {
    const exists = (rel: string) => rel === "src/components/index.d.ts";
    expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/components/index.d.ts");
  });

  it("never fabricates a directory index when nothing on disk matches", () => {
    // Precision guard, mirroring the extension probe's: a probe that finds
    // nothing must leave the mapper exactly where it was. A guessed
    // `components/index.ts` would be a wrongFile phantom, where the
    // unchanged `components.ts` is merely a dropped edge.
    expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, () => false)).toBe("src/components.ts");
  });

  it("probes the directory index behind a tsconfig alias too", () => {
    const exists = (rel: string) => rel === "src/components/index.tsx";
    const result = mapImportToFile(
      "@/components",
      "src/Page.tsx",
      { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      exists,
    );
    expect(result).toBe("src/components/index.tsx");
  });

  it("does NOT treat a NodeNext .js specifier as a directory", () => {
    // `./components.js` names a FILE under the NodeNext convention the
    // extension probe implements — the directory form is written
    // `./components/index.js`. Probing `components.js/index.ts` here would
    // invent a module the author never referenced.
    const exists = (rel: string) => rel === "src/components/index.ts";
    expect(mapImportToFile("./components.js", "src/Page.tsx", NO_ALIASES, exists)).toBe("src/components.ts");
  });

  it("resolves a directory module against a real project tree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ts-path-mapper-dir-"));
    mkdirSync(join(repoRoot, "src", "components"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "components", "index.tsx"), "export const Button = () => null;\n");
    try {
      const probe = createProjectFileProbe(repoRoot);
      expect(mapImportToFile("./components", "src/Page.tsx", NO_ALIASES, probe)).toBe("src/components/index.tsx");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The `paths` pattern language, as `tsc` actually defines it (bd tea-rags-mcp-t6ycg).
 *
 * The mapper understood two shapes — `"<prefix>/*"` and an exact literal — and
 * taxdome routes 97.2% of its imports through neither: its mapping is the bare
 * `"*": ["./app/javascript/*"]` catch-all. Every alias import returned `null`,
 * which `targetsExternalImport` reads as "this call leaves the project", so
 * 78 259 of 189 630 call sites were misfiled as external.
 *
 * Three rules make a catch-all safe, and the third is the one with teeth:
 * `"*"` matches EVERY bare specifier including every npm package, so an answer
 * it cannot verify on disk is a fabricated in-project path.
 */
describe("mapImportToFile paths pattern language (bd tea-rags-mcp-t6ycg)", () => {
  const CATCH_ALL = { baseUrl: ".", paths: { "*": ["./app/javascript/*"] } };

  it("resolves a bare `*` catch-all against the mapped directory", () => {
    const exists = (rel: string) => rel === "app/javascript/react-app/hooks/useDebounce.ts";
    expect(mapImportToFile("react-app/hooks/useDebounce", "app/javascript/react-app/Page.tsx", CATCH_ALL, exists)).toBe(
      "app/javascript/react-app/hooks/useDebounce.ts",
    );
  });

  it("resolves a catch-all specifier that names a directory module", () => {
    const exists = (rel: string) => rel === "app/javascript/Routes/index.ts";
    expect(mapImportToFile("Routes", "app/javascript/react-app/Page.tsx", CATCH_ALL, exists)).toBe(
      "app/javascript/Routes/index.ts",
    );
  });

  it("prefers the longer matching prefix over a catch-all declared first", () => {
    // Declaration order is deliberately hostile: first-match-wins would send
    // `api/mocks/getClient` to `app/javascript/api/mocks/getClient`, and tsc
    // sends it to the mocks root because `api/mocks/*` is the longer prefix.
    const paths = {
      "*": ["./app/javascript/*"],
      "api/mocks/*": ["./app/javascript/api/codegen/__generated__/mocks/*"],
    };
    const exists = () => true;
    expect(mapImportToFile("api/mocks/getClient", "app/javascript/x.ts", { baseUrl: ".", paths }, exists)).toBe(
      "app/javascript/api/codegen/__generated__/mocks/getClient.ts",
    );
  });

  it("prefers the longer prefix between two wildcards, whatever the declaration order", () => {
    // The precedence bug on its own, with no catch-all involved: both patterns
    // are the `"<prefix>/*"` shape the mapper already matched, and iteration
    // order alone decided the winner. tsc picks the longest matching prefix.
    const paths = { "api/*": ["./generic/*"], "api/mocks/*": ["./mocks/*"] };
    const exists = () => true;
    expect(mapImportToFile("api/mocks/getClient", "src/x.ts", { baseUrl: ".", paths }, exists)).toBe(
      "mocks/getClient.ts",
    );
  });

  it("lets an exact pattern beat a wildcard that also matches", () => {
    const paths = { "*": ["./app/javascript/*"], Routes: ["./app/javascript/Routes/table.ts"] };
    const exists = () => true;
    expect(mapImportToFile("Routes", "app/javascript/x.ts", { baseUrl: ".", paths }, exists)).toBe(
      "app/javascript/Routes/table.ts",
    );
  });

  it("declines an npm specifier the catch-all matched but no file backs", () => {
    // The precision guard this whole block exists for. `resolveTsSourcePath`
    // answers with its first candidate when nothing on disk matches, so an
    // ungated catch-all maps `lodash/debounce` to a fabricated
    // `app/javascript/lodash/debounce.ts` — and a fabricated in-project path
    // silently switches OFF the external classifier for every npm package.
    expect(mapImportToFile("lodash/debounce", "app/javascript/x.ts", CATCH_ALL, () => false)).toBeNull();
    expect(mapImportToFile("react", "app/javascript/x.ts", CATCH_ALL, () => false)).toBeNull();
  });

  it("declines a catch-all match when no probe can verify it, rather than guessing", () => {
    // Same rule with the oracle missing entirely: unverifiable means unmapped,
    // which leaves the call external — the safe direction.
    expect(mapImportToFile("react-app/hooks/useDebounce", "app/javascript/x.ts", CATCH_ALL)).toBeNull();
  });

  it("takes the first of several catch-all roots that verifiably exists", () => {
    // A `paths` entry may list more than one root; tsc tries them in order.
    // Only `targets[0]` was ever consulted, so a second root was dead config.
    const paths = { "*": ["./packages/a/*", "./packages/b/*"] };
    const exists = (rel: string) => rel === "packages/b/thing.ts";
    expect(mapImportToFile("thing", "packages/a/x.ts", { baseUrl: ".", paths }, exists)).toBe("packages/b/thing.ts");
  });

  it("takes the first of several EXPLICIT-pattern roots that verifiably exists", () => {
    const paths = { "@/*": ["./src/*", "./legacy/*"] };
    const exists = (rel: string) => rel === "legacy/foo.ts";
    expect(mapImportToFile("@/foo", "src/x.ts", { baseUrl: ".", paths }, exists)).toBe("legacy/foo.ts");
  });

  it("keeps the unverified fallback for an EXPLICIT pattern that matches nothing on disk", () => {
    // Only the catch-all is gated. `@/*` cannot match an npm specifier, so its
    // pre-existing "answer with the first candidate" behaviour stands — a path
    // no file table entry matches drops the edge, where the gate here would
    // change behaviour the extension-probe tests already pin.
    expect(mapImportToFile("@/foo", "src/x.ts", { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, () => false)).toBe(
      "src/foo.ts",
    );
  });

  it("resolves taxdome's real shape against a real project tree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ts-path-mapper-catchall-"));
    mkdirSync(join(repoRoot, "app", "javascript", "react-app", "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "javascript", "Routes"), { recursive: true });
    writeFileSync(join(repoRoot, "app", "javascript", "react-app", "hooks", "useDebounce.ts"), "export const x = 1;\n");
    writeFileSync(join(repoRoot, "app", "javascript", "Routes", "index.ts"), "export const routes = [];\n");
    try {
      const probe = createProjectFileProbe(repoRoot);
      const caller = "app/javascript/react-app/Page.tsx";
      expect(mapImportToFile("react-app/hooks/useDebounce", caller, CATCH_ALL, probe)).toBe(
        "app/javascript/react-app/hooks/useDebounce.ts",
      );
      expect(mapImportToFile("Routes", caller, CATCH_ALL, probe)).toBe("app/javascript/Routes/index.ts");
      expect(mapImportToFile("react", caller, CATCH_ALL, probe)).toBeNull();
      expect(mapImportToFile("lodash/debounce", caller, CATCH_ALL, probe)).toBeNull();
      expect(mapImportToFile("@tanstack/react-query", caller, CATCH_ALL, probe)).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("createProjectFileProbe (bd tea-rags-mcp-f3zcy)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "ts-path-mapper-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "Button.tsx"), "export const Button = () => null;\n");
  writeFileSync(join(repoRoot, "src", "Page.tsx"), 'import { Button } from "./Button.js";\n');
  writeFileSync(join(repoRoot, "src", "store.ts"), "export class Store {}\n");

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("resolves a .tsx-only relative import against a real project tree", () => {
    const probe = createProjectFileProbe(repoRoot);
    expect(mapImportToFile("./Button.js", "src/Page.tsx", NO_ALIASES, probe)).toBe("src/Button.tsx");
  });

  it("still resolves a .ts sibling in the same tree", () => {
    const probe = createProjectFileProbe(repoRoot);
    expect(mapImportToFile("./store.js", "src/Page.tsx", NO_ALIASES, probe)).toBe("src/store.ts");
  });

  it("reports false for a path the project does not contain", () => {
    const probe = createProjectFileProbe(repoRoot);
    expect(probe("src/Button.tsx")).toBe(true);
    expect(probe("src/Missing.tsx")).toBe(false);
  });

  it("answers from cache on repeat lookups so a resolve pass stats each path once", () => {
    // An index run resolves millions of call sites against a fixed file
    // snapshot; a syscall per import per call site is the difference between
    // a probe and a bottleneck. The cache is why this is affordable, and it
    // is correct precisely because the snapshot does not move mid-run.
    const scratch = join(repoRoot, "src", "scratch.ts");
    writeFileSync(scratch, "export const scratch = 1;\n");
    const probe = createProjectFileProbe(repoRoot);
    expect(probe("src/scratch.ts")).toBe(true);
    rmSync(scratch);
    expect(probe("src/scratch.ts")).toBe(true);
  });
});
