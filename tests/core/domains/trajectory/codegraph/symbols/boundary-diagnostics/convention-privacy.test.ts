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

import type {
  HierarchySnapshot,
  InheritanceEdgeRow,
  NonPublicMemberEdge,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  CONVENTION_PRIVACY_LANGUAGES,
  detectConventionPrivacyLeaks,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { buildHierarchySnapshot } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";

/** A persisted-shape class hierarchy: `[subclass, base]` pairs, every base resolved to its own symbol id. */
function hierarchyOf(pairs: readonly (readonly [string, string])[]): HierarchySnapshot {
  const rows: InheritanceEdgeRow[] = pairs.map(([source, ancestor], ordinal) => ({
    sourceFqName: source,
    sourceSymbolId: source,
    ancestorFqName: ancestor,
    ancestorSymbolId: ancestor,
    kind: "super",
    ordinal,
  }));
  return buildHierarchySnapshot(rows);
}

/** A Python underscore-member edge with the call text as written. */
function pyCall(
  sourceRelPath: string,
  sourceSymbolId: string,
  targetRelPath: string,
  targetSymbolId: string,
  callExpression: string,
): NonPublicMemberEdge {
  return { ...py(sourceRelPath, sourceSymbolId, targetRelPath, targetSymbolId), callExpression };
}

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

  // bd tea-rags-mcp-r8hme.41: live flask — Flask subclasses sansio.App and
  // calls its inherited `_find_error_handler` through `self`; protected-by-
  // convention access from a subclass is legal, not a module-private leak.
  describe("python-underscore from a subclass through self / cls / super()", () => {
    const APP = "src/flask/sansio/app.py";
    const FLASK = "src/flask/app.py";
    const hierarchy = hierarchyOf([
      ["Flask", "App"],
      ["Quart", "Flask"],
    ]);

    it("exempts a call whose receiver is self, cls or super() into an ancestor class's member", () => {
      const report = detectConventionPrivacyLeaks(
        [
          pyCall(FLASK, "Flask#handle_exception", APP, "App#_find_error_handler", "self._find_error_handler(e, bps)"),
          pyCall(FLASK, "Flask.create", APP, "App#_find_error_handler", "cls._find_error_handler(e)"),
          pyCall(FLASK, "Flask#run", APP, "App#_find_error_handler", "super()._find_error_handler(e)"),
          pyCall(FLASK, "Flask#run", APP, "App#_find_error_handler", "super(Flask, self)._find_error_handler(e)"),
          // Transitive: Quart -> Flask -> App.
          pyCall("src/quart/app.py", "Quart#serve", APP, "App#_find_error_handler", "self._find_error_handler(e)"),
        ],
        { classHierarchy: hierarchy },
      );

      expect(report.violations).toEqual([]);
    });

    it("keeps the true positives — module-level _function, unrelated class, foreign receiver, attribute chain", () => {
      const report = detectConventionPrivacyLeaks(
        [
          // The flask true positive: a module-level private helper used across packages.
          pyCall(
            APP,
            "App#inject_url_defaults",
            "src/flask/helpers.py",
            "_split_blueprint_path",
            "_split_blueprint_path(x)",
          ),
          // self, but the target's class is not an ancestor of the caller's.
          pyCall("src/other/repo.py", "Repo#load", APP, "App#_find_error_handler", "self._find_error_handler(e)"),
          // An ancestor's member reached through another object.
          pyCall(FLASK, "Flask#handle", APP, "App#_find_error_handler", "other._find_error_handler(e)"),
          // self, but the private member is reached through an attribute of self.
          pyCall(FLASK, "Flask#wrap", APP, "App#_find_error_handler", "self.app._find_error_handler(e)"),
        ],
        { classHierarchy: hierarchy },
      );

      expect(report.violations.map((v) => [v.sourceSymbolId, v.targetSymbolId])).toEqual([
        ["Flask#handle", "App#_find_error_handler"],
        ["Flask#wrap", "App#_find_error_handler"],
        ["App#inject_url_defaults", "_split_blueprint_path"],
        ["Repo#load", "App#_find_error_handler"],
      ]);
    });

    it("judges as before when no class hierarchy is given — no ancestry evidence, no exemption", () => {
      const report = detectConventionPrivacyLeaks([
        pyCall(FLASK, "Flask#handle_exception", APP, "App#_find_error_handler", "self._find_error_handler(e)"),
      ]);

      expect(report.violations.map((v) => v.sourceSymbolId)).toEqual(["Flask#handle_exception"]);
    });
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
