import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeArtifacts } from "../../scripts/gen-language-compatibility.js";

function scratch(): { rulePath: string; readmePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lang-compat-"));
  return { rulePath: join(dir, "rule.md"), readmePath: join(dir, "README.md") };
}

describe("writeArtifacts", () => {
  it("writes the rule file and replaces only the README marker block, idempotently", () => {
    const { rulePath, readmePath } = scratch();
    writeFileSync(readmePath, "# Top\n\n<!-- BEGIN lang-compat -->\nOLD\n<!-- END lang-compat -->\n\n# Bottom\n");

    writeArtifacts({ rulePath, readmePath });
    const first = readFileSync(readmePath, "utf8");

    expect(readFileSync(rulePath, "utf8")).toContain("# Language Compatibility");
    expect(first).toContain("# Top");
    expect(first).toContain("# Bottom");
    expect(first).not.toContain("OLD");
    expect(first).toContain("## Languages Compatibilities");
    // markers survive
    expect(first).toContain("<!-- BEGIN lang-compat -->");
    expect(first).toContain("<!-- END lang-compat -->");

    writeArtifacts({ rulePath, readmePath });
    expect(readFileSync(readmePath, "utf8")).toBe(first); // idempotent
  });

  it("throws when the README markers are missing", () => {
    const { rulePath, readmePath } = scratch();
    writeFileSync(readmePath, "# No markers here\n");
    expect(() => {
      writeArtifacts({ rulePath, readmePath });
    }).toThrow(/marker/i);
  });
});
