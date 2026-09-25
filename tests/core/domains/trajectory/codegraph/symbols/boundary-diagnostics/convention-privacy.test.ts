/**
 * Convention-privacy leaks (bd tea-rags-mcp-r8hme.1, A4b) — privacy the
 * compiler does not enforce, reached from outside anyway:
 *
 * - `python-underscore`: a resolved call into a `_name` member (not a dunder)
 *   from a file in another package directory than the declaring file;
 * - `ruby-send-private`: `send` / `public_send` / `__send__(:name)` resolved to
 *   a method declared private / protected, called from outside its class.
 */
import { describe, expect, it } from "vitest";

import type { NonPublicMemberEdge } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  CONVENTION_PRIVACY_LANGUAGES,
  detectConventionPrivacyLeaks,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function py(
  sourceRelPath: string,
  sourceSymbolId: string,
  targetRelPath: string,
  targetSymbolId: string,
): NonPublicMemberEdge {
  const targetShortName = targetSymbolId.split(/[#.]/).pop() ?? targetSymbolId;
  return {
    sourceRelPath,
    sourceSymbolId,
    targetRelPath,
    targetSymbolId,
    targetShortName,
    targetVisibility: null,
    targetLanguage: "python",
    callExpression: `x.${targetShortName}()`,
  };
}

function rb(
  sourceSymbolId: string,
  targetSymbolId: string,
  callExpression: string,
  targetVisibility: string | null = "private",
): NonPublicMemberEdge {
  const targetShortName = targetSymbolId.split(/[#.]/).pop() ?? targetSymbolId;
  return {
    sourceRelPath: "app/jobs/job.rb",
    sourceSymbolId,
    targetRelPath: "app/models/user.rb",
    targetSymbolId,
    targetShortName,
    targetVisibility,
    targetLanguage: "ruby",
    callExpression,
  };
}

describe("detectConventionPrivacyLeaks (bd tea-rags-mcp-r8hme.1)", () => {
  it("declares the languages whose privacy is a convention", () => {
    expect([...CONVENTION_PRIVACY_LANGUAGES].sort()).toEqual(["python", "ruby"]);
  });

  it("flags a Python underscore member reached from another package directory", () => {
    const report = detectConventionPrivacyLeaks([
      py("app/views.py", "render", "pkg/repo.py", "Repo#_load"),
      py("pkg/service.py", "Service#run", "pkg/repo.py", "Repo#_load"),
      py("app/views.py", "render", "pkg/repo.py", "Repo#__init__"),
      py("app/views.py", "render", "pkg/repo.py", "Repo#__mangled"),
    ]);

    expect(report.violations).toEqual([
      {
        sourceRelPath: "app/views.py",
        targetRelPath: "pkg/repo.py",
        sourceSymbolId: "render",
        targetSymbolId: "Repo#__mangled",
        rule: "python-underscore",
      },
      {
        sourceRelPath: "app/views.py",
        targetRelPath: "pkg/repo.py",
        sourceSymbolId: "render",
        targetSymbolId: "Repo#_load",
        rule: "python-underscore",
      },
    ]);
  });

  it("flags a Ruby send to a private or protected method from outside its class", () => {
    const report = detectConventionPrivacyLeaks([
      rb("Job#perform", "User#secret", "user.send(:secret)"),
      rb("Job#perform", "User#guarded", 'user.public_send("guarded", 1)', "protected"),
      rb("Job#perform", "User#hidden", "user.__send__ :hidden"),
      // A direct call to a private method is the resolver's business, not a send leak.
      rb("Job#perform", "User#secret", "user.secret"),
      // Inside the declaring class: legitimate.
      rb("User#other", "User#secret", "send(:secret)"),
      // The literal names another method than the resolved target.
      rb("Job#perform", "User#secret", "log(user.send(:name))"),
      // A public target is no leak.
      rb("Job#perform", "User#open", "user.send(:open)", "public"),
    ]);

    expect(report.violations.map((v) => [v.sourceSymbolId, v.targetSymbolId, v.rule])).toEqual([
      ["Job#perform", "User#guarded", "ruby-send-private"],
      ["Job#perform", "User#hidden", "ruby-send-private"],
      ["Job#perform", "User#secret", "ruby-send-private"],
    ]);
  });

  it("scopes judged edges by source and counts by rule", () => {
    const edges = [
      py("app/views.py", "render", "pkg/repo.py", "Repo#_load"),
      rb("Job#perform", "User#secret", "user.send(:secret)"),
    ];
    const report = detectConventionPrivacyLeaks(edges, { sourcePathPattern: "app/*.py" });

    expect(report.violations.map((v) => v.rule)).toEqual(["python-underscore"]);
    expect(report.summary).toEqual({
      candidateEdgeCount: 2,
      violationCount: 1,
      violationsByRule: { pythonUnderscore: 1, rubySendPrivate: 0 },
      scope: { sourcePathPattern: "app/*.py", outOfScopeEdgeCount: 1 },
    });
  });
});
