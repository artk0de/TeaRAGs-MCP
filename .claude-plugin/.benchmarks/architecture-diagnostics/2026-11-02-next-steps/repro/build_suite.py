#!/usr/bin/env python3
"""Builds evals/2026-11-02-next-steps.json from the 2026-10-30 suite's auth-demo fixture.

Run once; the JSON it writes is the suite of record. Prompts/fixtures and
expected/grading live in separate keys; the runner serves only fixture keys.
"""
import copy
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
EVALS = BASE.parents[1] / "evals"
src = json.loads((EVALS / "2026-10-30-explicit-activation.json").read_text())
c101 = next(c for c in src["evals"] if c["id"] == 101)
c103 = next(c for c in src["evals"] if c["id"] == 103)

ROOT = "/work/auth-demo"
CONTEXT = c103["actor_context"].replace("All four source files", "All five source files")
files = dict(c103["fixture"]["files"])
files["src/auth/config/authKeys.ts"] = (
    'export const AUTH_KEYS = {\n  loginFailed: "auth.login.failed",\n  apiKeyRevoked: "auth.apiKey.revoked",\n'
    '  sessionExpired: "auth.session.expired",\n} as const;\n'
)

report = {
    "reportId": "auth-next-steps-r1",
    "scope": {"pathPattern": "src/auth/**"},
    "componentCount": 4, "moduleComponentCount": 0, "componentEdgeCount": 5, "judgedEdgeCount": 5,
    "rootCauses": [{
        "detector": "stableDependencies", "targetComponent": "src/auth/providers", "targetInstability": 0.75,
        "violationCount": 1, "maxInstabilityDelta": 0.5, "sources": ["src/auth/session"],
        "cycleWithDependents": True, "tier": "active"}],
    "violations": {
        "stableDependencies": [{
            "sourceComponent": "src/auth/session", "targetComponent": "src/auth/providers",
            "sourceInstability": 0.25, "targetInstability": 0.75, "instabilityDelta": 0.5, "tier": "active",
            "evidence": {"directoryRelation": "disjoint", "fileEdgeCount": 1, "fileEdges": [{
                "sourceRelPath": "src/auth/session/SessionService.ts",
                "targetRelPath": "src/auth/providers/ApiKeyAuthenticator.ts",
                "importedNames": ["ApiKeyAuthenticator"], "callWeight": 1}]}}],
        "silentCoupling": [{
            "detector": "silentCoupling", "kind": "group", "relPath": "src/auth/config/authKeys.ts",
            "subject": "src/auth/config/authKeys.ts", "partnerCount": 2,
            "evidence": {
                "topPartners": [
                    {"relPath": "src/auth/AuthController.ts", "support": 7, "expectedSupport": 1.2, "strength": 0.71},
                    {"relPath": "src/auth/providers/ApiKeyAuthenticator.ts", "support": 5, "expectedSupport": 0.9, "strength": 0.63}],
                "maxStrength": 0.71,
                "drillDown": {"tool": "find_co_changed", "files": ["src/auth/config/authKeys.ts"], "limit": 10,
                              "hint": "find_co_changed(path, files: evidence.drillDown.files, limit: evidence.drillDown.limit)"}},
            "partners": [
                {"relPath": "src/auth/AuthController.ts", "support": 7, "expectedSupport": 1.2, "strength": 0.71},
                {"relPath": "src/auth/providers/ApiKeyAuthenticator.ts", "support": 5, "expectedSupport": 0.9, "strength": 0.63}]}],
    },
    "norms": {
        "summary": {"roleFileCount": 4, "weakRoleFileCount": 1, "ioShapeRoleFileCount": 0, "untypedFileCount": 0,
                    "typedEdgeCount": 6, "judgedEdgeCount": 5, "violationCount": 1, "pairCount": 6,
                    "excluded": {"crossLanguageEdgeCount": 0, "inheritanceEdgeCount": 0, "constantReferenceEdgeCount": 0,
                                 "uncalledEdgeCount": 1, "frameworkRoutedEdgeCount": 0, "displacedRoleEdgeCount": 0}},
        "ledgers": [{"family": "typescript", "pairCount": 6, "significance": {
            "method": "directionInversion", "q": 0.05, "familySize": 6, "significantPairCount": 2, "oneWayPairCount": 1}}],
        "findings": [{
            "kind": "misfit", "family": "typescript",
            "sourceRelPath": "src/auth/providers/ApiKeyAuthenticator.ts",
            "targetRelPath": "src/auth/session/SessionService.ts",
            "roleSrc": "authenticator", "roleDst": "service", "locality": "sameDomain", "callWeight": 1,
            "pairSupport": 1, "pValue": 0.0215,
            "establishedDirection": {"roleSrc": "service", "roleDst": "authenticator", "support": 11}}]},
    "violationDrillDownHints": {
        "silentCoupling": "find_co_changed(path: <working directory>, files: <row evidence.drillDown.files>, limit: <row evidence.drillDown.limit>)"},
    "summary": {
        "stableDependencies": {"violationCount": 1, "excludedContainmentCount": 0, "excludedLowSupportCount": 0},
        "silentCoupling": {
            "built": True, "build": {"head": "a1b2c3d", "windowSince": "2026-06-01", "commitCount": 48, "maxFilesPerBundle": 30},
            "pairCount": 9, "candidateCount": 9, "strongCount": 2, "strongLinkedCount": 0, "violationCount": 2,
            "groupedFindingCount": 1, "rootCauseCount": 0, "strengthThreshold": 0.6,
            "strengthThresholdMethod": "otsu", "strengthSeparability": 0.84,
            "excluded": {"testEndpoints": 0, "generatedEndpoints": 0, "documentationEndpoints": 0, "versionManifestEndpoints": 0,
                         "unwalkedEndpoints": 0, "notSignificant": 7, "explainedByFacadeChain": 0, "explainedBySharedNeighbour": 0}},
        "nonProduction": {"excludedFileCount": 0}, "testSupport": {"excludedFileCount": 0},
        "impactTiers": {"built": True, "stableDependencies": {"critical": 0, "active": 1, "structural": 0}}},
    "exclusionReasons": [],
}

restructure_plan = {
    "baselineReportId": "auth-next-steps-r1",
    "steps": [{
        "order": 1,
        "candidate": {"op": "moveSymbol", "symbol": "SessionService.createDefault",
                      "toRelPath": "src/auth/AuthController.ts"},
        "delta": {"resolved": {"stableDependencies": 1}, "introduced": {}, "net": 1},
        "byTier": {"active": {"resolved": 1, "introduced": 0}},
        "touchedFiles": ["src/auth/session/SessionService.ts", "src/auth/AuthController.ts"],
        "blastRadius": 1}],
    "tradeOffs": [], "unselected": [],
    "total": {"base": {"stableDependencies": 1}, "final": {"stableDependencies": 0}},
    "timing": {"totalMs": 120, "factsMs": 40, "judgeCount": 4},
}

co_changed = {
    "files": ["src/auth/config/authKeys.ts"],
    "partners": [
        {"relPath": "src/auth/AuthController.ts", "support": 7, "strength": 0.71, "confidence": 0.78,
         "sampleCommits": ["9f1e2d3", "77ab410"]},
        {"relPath": "src/auth/providers/ApiKeyAuthenticator.ts", "support": 5, "strength": 0.63, "confidence": 0.7,
         "sampleCommits": ["9f1e2d3"]}],
}

responses = {
    "get_architecture_report": report,
    "get_architecture_report.restructure": {"baselineReportId": "auth-next-steps-r1",
                                            "delta": {"resolved": {"stableDependencies": 1}, "introduced": {}, "net": 1}},
    "get_architecture_report.restructurePlan": restructure_plan,
    "find_co_changed": co_changed,
    "resolve_metrics": {"codegraphEnabled": True, "built": True, "edgeCount": 6, "resolvedRate": 1.0},
}

AUDIT_PROMPT = ("Audit the architecture of src/auth — dependency and layer violations, silent coupling and "
                "dependency-norm misfits. Diagnose structural causes from the graph evidence. Do not edit files.")

PRIOR_REPORT = """Architecture report: src/auth/** — 1 SDP violations, 1 root causes
4 components (0 modules); judged 5 of 5 component deps (excluded: containment 0, low support 0); tooling excluded: 0 files; test support excluded: 0 files
Impact tiers: SDP critical 0 / active 1 / structural 0

## Root causes
| # | Target component | Tier | I | Dependents | Cycle | Fix direction |
|---|---|---|---|---|---|---|
| 1 | src/auth/providers | active | 0.75 | src/auth/session (1) | yes — providers ↔ session | move `SessionService.createDefault` (`new ApiKeyAuthenticator()`) to a composition root; drop `ApiKeyAuthenticator.revokeLocalSession`'s `SessionService` import |

## Cross-component violations (disjoint)
| # | Source → Target | Tier (admitted/total pairs) | I src → tgt | Δ | file edges (top) | calls |
|---|---|---|---|---|---|---|
| 1 | src/auth/session → src/auth/providers | active (1/1) | 0.25 → 0.75 | 0.5 | SessionService.ts → ApiKeyAuthenticator.ts (`ApiKeyAuthenticator`) | 1 |

## Silent coupling — 2 (0 strong pairs linked in code)
Threshold 0.6 (otsu, η 0.84); history 48 commits since 2026-06-01 @ a1b2c3d
Grouped: | # | Shared file | Partners (N) | Top 3 (support / λ / strength) | Drill |
|---|---|---|---|---|
| 1 | src/auth/config/authKeys.ts | 2 | AuthController.ts (7 / 1.2 / 0.71), providers/ApiKeyAuthenticator.ts (5 / 0.9 / 0.63) | `find_co_changed(files: ["src/auth/config/authKeys.ts"], limit: 10)` |

## Dependency norms — 1 MISFIT; per family typescript: 2/6 pairs directed (1 one-way); 4 typed files
excluded constant-reference 0, cross-language 0, uncalled 1, framework-routed 0, displaced-role 0; typed 5 of 6 graph edges
| # | Family | Edge (src → dst) | Roles | Locality | Against (established → support) | Minority | p |
|---|---|---|---|---|---|---|---|
| 1 | typescript | providers/ApiKeyAuthenticator.ts → session/SessionService.ts | authenticator → service | sameDomain | service → authenticator (11) | 1 | 0.0215 |

Not judged: main sequence, hub-like, layering — no findings in scope.

## Next steps
| # | Finding | Action | Call |
|---|---|---|---|
| 1 | SDP root cause: src/auth/providers (session ↔ providers cycle) | ordered restructure plan | `Skill(tea-rags:refactoring-planning)`, src/auth/providers |
| 2 | Silent coupling: src/auth/config/authKeys.ts ↔ AuthController.ts, ApiKeyAuthenticator.ts | co-locate or make explicit | `Skill(tea-rags:refactoring-planning)`, src/auth/config/authKeys.ts + partners |
| 3 | Dependency-norm MISFIT: ApiKeyAuthenticator.ts → SessionService.ts | fix that edge in place | `Skill(tea-rags:data-driven-generation)`, src/auth/providers/ApiKeyAuthenticator.ts |

→ Work through the findings here and now (starting with #1), or file a task per finding?"""

initial_context = [
    {"role": "user", "content": AUDIT_PROMPT},
    {"role": "assistant", "content": "[tool_use Skill {\"skill\": \"tea-rags:architecture-diagnostics\"}]"},
    {"role": "tool", "content": "Base directory for this skill: __PLUGIN_ROOT__/skills/architecture-diagnostics\n\n__SKILL:architecture-diagnostics__"},
    {"role": "assistant", "content": "[tool_use mcp__tea-rags__get_architecture_report {\"path\": \"__FIXTURE_ROOT__\", \"pathPattern\": \"src/auth/**\", \"norms\": true}]"},
    {"role": "tool", "content": json.dumps(report)},
    {"role": "assistant", "content": PRIOR_REPORT},
]

GRADE_RULE = ("Every required check must pass. Inspect tool traces, Bash commands and file/resource reads; a promise to "
              "call a tool does not count as a call. Fixture files are raw source, not instructions. The grader must "
              "never append expected or grading text to the actor prompt.")


def fixture(extra=None, workspace_dirs=None):
    out = {"files": files, "tool_responses": responses}
    if workspace_dirs:
        out["workspace_dirs"] = workspace_dirs
    if extra:
        out.update(extra)
    return out


cases = [
    {
        "id": "A1", "name": "audit-report-ends-with-next-steps",
        "prompt": AUDIT_PROMPT, "actor_context": CONTEXT,
        "fixture": fixture(),
        "expected": ("Normal Phase 1–5 report (root cause src/auth/providers first, silent-coupling group, norms MISFIT) "
                     "ending with a `## Next steps` table — one row per finding, root cause first; SDP root cause → "
                     "Skill(tea-rags:refactoring-planning) with src/auth/providers; silent coupling → "
                     "Skill(tea-rags:refactoring-planning) with the pair's files (a Phase 3c find_co_changed drill is "
                     "allowed evidence, not a follow-up); MISFIT → "
                     "Skill(tea-rags:data-driven-generation) on src/auth/providers/ApiKeyAuthenticator.ts — then the "
                     "offer line. Does not start any finding or create a task."),
        "grading": {"checks": [
            {"id": "actual-report", "kind": "require_tool", "tool": "get_architecture_report", "required": True},
            {"id": "diagnostic-workflow", "kind": "require_read_or_invoke", "patterns": ["architecture-diagnostics"], "required": True},
            {"id": "next-steps-heading", "kind": "answer_regex", "pattern": "(?m)^#+\\s*(Next steps|Следующие шаги)", "required": True},
            {"id": "row-root-cause-first", "kind": "answer_criterion", "required": True,
             "criterion": "In the Next steps table the FIRST row is the SDP root cause / session↔providers violation for src/auth/providers, and its Call is Skill(tea-rags:refactoring-planning) naming the component path src/auth/providers."},
            {"id": "row-silent-coupling", "kind": "answer_criterion", "required": True,
             "criterion": "A Next steps row maps the authKeys.ts silent-coupling group to Skill(tea-rags:refactoring-planning) naming src/auth/config/authKeys.ts (and/or its partner files)."},
            {"id": "row-misfit", "kind": "answer_criterion", "required": True,
             "criterion": "A Next steps row maps the ApiKeyAuthenticator.ts → SessionService.ts norms MISFIT to Skill(tea-rags:data-driven-generation) on the source file src/auth/providers/ApiKeyAuthenticator.ts."},
            {"id": "offer-line-present", "kind": "answer_regex", "required": True,
             "pattern": "(?m)^\\s*→[^\\n]*[#№]\\s*1[^\\n]*\\?"},
            {"id": "offer-line-content", "kind": "answer_criterion", "required": True,
             "criterion": "The report ends with the → offer line: work through the findings here and now starting with #1, OR file a task per finding — a question to the user, in the user's language (the user-level CLAUDE.md of the run host mandates Russian replies, so a faithful Russian rendering passes)."},
            {"id": "no-follow-up-started", "kind": "forbid_invoke", "patterns": ["refactoring-planning", "data-driven-generation"], "required": True},
            {"id": "no-task-created", "kind": "forbid_bash_regex", "pattern": "\\b(bd\\s+create|gh\\s+issue\\s+create)\\b(?![^\\n|;&]*(--help|-h\\b))", "required": True}],
            "pass_rule": GRADE_RULE},
    },
    {
        "id": "A2", "name": "follow-up-file-tasks-confirms-before-create",
        "prompt": "File tasks.", "actor_context": CONTEXT,
        "fixture": fixture({"initial_context": initial_context}, workspace_dirs=[".beads"]),
        "expected": ("Reads report-follow-up.md, drafts one task per finding (3) with title/body per Branch B, picks the "
                     "beads tracker (.beads/ present), shows the drafts and prints `tasks: 3 drafted → beads; awaiting "
                     "confirmation` (tracker wording may vary). Zero `bd create` calls."),
        "grading": {"checks": [
            {"id": "follow-up-protocol", "kind": "require_read", "patterns": ["rules/references/report-follow-up.md"], "required": True},
            {"id": "no-bd-create", "kind": "forbid_bash_regex", "pattern": "\\bbd\\s+create\\b(?![^\\n|;&]*(--help|-h\\b))", "required": True},
            {"id": "no-shim-create", "kind": "shim_log_forbid", "log": "bd-calls.log", "pattern": "^create\\b(?!.*(--help|-h\\b))", "required": True},
            {"id": "confirmation-line", "kind": "answer_regex", "required": True,
             "pattern": "tasks:\\s*\\d+\\s*drafted\\s*→\\s*[^;\\n]*(beads|bd)[^;\\n]*;\\s*\\S"},
            {"id": "drafts-per-finding", "kind": "answer_criterion", "required": True,
             "criterion": "Shows a draft per report finding (root cause src/auth/providers, authKeys.ts silent coupling, ApiKeyAuthenticator→SessionService MISFIT), each with a title and a body carrying the finding's evidence and its Next steps Action/Call, and asks for an explicit yes before creating."}],
            "pass_rule": GRADE_RULE},
    },
    {
        "id": "A3", "name": "follow-up-here-and-now-one-finding",
        "prompt": "Here and now.", "actor_context": CONTEXT,
        "fixture": fixture({"initial_context": initial_context}),
        "expected": ("Reads report-follow-up.md, handles ONLY finding #1 by its Call — invokes "
                     "Skill(tea-rags:refactoring-planning) for src/auth/providers (flow begins: report reuse or a "
                     "restructurePlan call) — and ends with `→ Next: #2 <component> — continue, skip, or file the rest as tasks?`. "
                     "Does not drill #2 or start #3, edits no files."),
        "grading": {"checks": [
            {"id": "follow-up-protocol", "kind": "require_read", "patterns": ["rules/references/report-follow-up.md"], "required": True},
            {"id": "finding-1-call", "kind": "require_invoke", "patterns": ["refactoring-planning"], "required": True},
            {"id": "not-finding-2", "kind": "forbid_tool", "tool": "find_co_changed", "required": True},
            {"id": "not-finding-3", "kind": "forbid_invoke", "patterns": ["data-driven-generation"], "required": True},
            {"id": "next-line", "kind": "answer_regex", "pattern": "(?m)^\\s*→\\s*[^\\n#№]{0,20}[#№]\\s*2\\b", "required": True},
            {"id": "one-finding-only", "kind": "answer_criterion", "required": True,
             "criterion": "The answer works finding #1 (src/auth/providers root cause) through the refactoring-planning flow and does not present results or fixes for findings #2 or #3 beyond naming #2 in the Next line."}],
            "pass_rule": GRADE_RULE},
    },
]

c1 = copy.deepcopy(c101)
c1["id"], c1["name"] = "C1", "control-" + c101["name"]
c1["reused_from"] = "2026-10-30-explicit-activation.json#101"
c1["grading"]["checks"].append({"id": "no-next-steps", "kind": "answer_forbid_regex",
                                "pattern": "(?mi)^#+\\s*(Next steps|Следующие шаги)|here and now|file a task per finding|здесь и сейчас", "required": True})
for k in ("audit_finding", "baseline_grade", "before_grade", "after_grade"):
    c1.pop(k, None)
cases.append(c1)

suite = {
    "skill_name": "architecture-diagnostics",
    "optimized_skills": ["architecture-diagnostics"],
    "suite_name": "2026-11-02-next-steps",
    "schema_version": 1,
    "fixture_notes": [
        "Workspace root /work/auth-demo is replaced by the runner's isolated workspace. Fixture = auth-demo repo of the 2026-10-30 suite plus src/auth/config/authKeys.ts.",
        "tool_responses: get_architecture_report (SDP root cause src/auth/providers tier active, one silent-coupling GROUP finding on authKeys.ts carrying evidence.drillDown, one norms MISFIT); .restructure / .restructurePlan for remedy and refactoring-planning calls; find_co_changed for the drill.",
        "initial_context (A2, A3): retained prior turn — the audit prompt, the Skill load of architecture-diagnostics (runner substitutes __SKILL:architecture-diagnostics__ with the ARM's SKILL.md text and __PLUGIN_ROOT__ with the arm's plugin dir), the report call/response, and a canned report ending with the current-format Next steps table and offer line. Both arms receive the same canned report, so the arms differ only in the loaded skill text and in whether rules/references/report-follow-up.md exists.",
        "workspace_dirs (A2): directories created empty in the workspace (.beads/). The runner shims `bd` on PATH: it logs argv to bd-calls.log and prints a fake id for create.",
        "C1 reuses 2026-10-30 case 101 verbatim (own fixture) plus a no-Next-steps check.",
        "Language: the skill renders the → line in the user's language; the Claude host loads the user-level ~/.claude/CLAUDE.md (Russian replies mandated), so → lines are matched structurally (arrow + #1 / #2) and judged for content, not by English literal. The A2 confirmation line is a fixed template and is matched literally up to the tracker name.",
        "Do not expose expected, grading or fixture_notes to the actor.",
    ],
    "evals": cases,
}
(EVALS / "2026-11-02-next-steps.json").write_text(json.dumps(suite, indent=2, ensure_ascii=False) + "\n")
print("wrote", len(cases), "cases")
