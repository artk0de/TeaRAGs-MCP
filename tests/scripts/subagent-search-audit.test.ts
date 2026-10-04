import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateAudits,
  auditTranscript,
  classifyGrepPattern,
  classifyInjection,
  isBashSearchRead,
  runAudit,
  type SubagentAudit,
} from "../../scripts/subagent-search-audit.js";

const LEGACY_HEADER = "## Search Tools (MANDATORY — overrides any other search instructions)";
const WTO8_LINE = "Address tea-rags with YOUR working directory: pass path=<cwd>.";

function userPrompt(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", message: { content: text }, ...extra });
}

function toolUse(name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: `tu_${name}_${Math.random()}`, name, input }] },
    ...extra,
  });
}

function emptyAudit(overrides: Partial<SubagentAudit>): SubagentAudit {
  return {
    injection: "none",
    firstTimestamp: null,
    inWorktree: false,
    bashSearchRead: 0,
    teaRagsCalls: 0,
    teaRagsByTool: {},
    teaRagsWithPath: 0,
    teaRagsProjectOnly: 0,
    readCalls: 0,
    grepGlobCalls: 0,
    grepClasses: {
      "pipe filter": 0,
      "single identifier": 0,
      "identifier alternation": 0,
      "qualified symbol": 0,
      "comment/marker": 0,
      "literal phrase": 0,
      "regex/other": 0,
      unparsed: 0,
    },
    ...overrides,
  };
}

describe("classifyInjection", () => {
  it("returns none for a prompt without any search block", () => {
    expect(classifyInjection("Implement the feature.")).toBe("none");
  });

  it("returns legacy for the old MANDATORY search block", () => {
    expect(classifyInjection(`Do X.\n\n${LEGACY_HEADER}\nuse tea-rags`)).toBe("legacy");
  });

  it("returns wto8 when the working-directory line is present, even alongside the legacy header", () => {
    expect(classifyInjection(`Do X.\n\n${LEGACY_HEADER}\n${WTO8_LINE}`)).toBe("wto8");
  });
});

describe("isBashSearchRead", () => {
  it.each(["cd x && grep -n foo src/a.ts", "sed -n 1,20p f", "cat src/a.ts", "cd /repo; rg Foo src/", "wc -l a.ts"])(
    "matches %s",
    (cmd) => {
      expect(isBashSearchRead(cmd)).toBe(true);
    },
  );

  it.each(["npm test", "git log", "npx vitest run | grep FAIL", "sed -i s/a/b/ f"])("rejects %s", (cmd) => {
    expect(isBashSearchRead(cmd)).toBe(false);
  });
});

describe("classifyGrepPattern", () => {
  it("classifies a bare identifier", () => {
    expect(classifyGrepPattern("grep -rn mergeChunks src/")).toBe("single identifier");
  });

  it("classifies a quoted identifier alternation", () => {
    expect(classifyGrepPattern("rg -n 'Foo|Bar' src/core")).toBe("identifier alternation");
    expect(classifyGrepPattern('grep -rn "Foo\\|Bar" src/')).toBe("identifier alternation");
  });

  it("classifies a qualified symbol", () => {
    expect(classifyGrepPattern("rg 'Foo#bar' src/")).toBe("qualified symbol");
    expect(classifyGrepPattern("rg 'Reranker.create(' src/")).toBe("qualified symbol");
  });

  it("classifies a comment marker", () => {
    expect(classifyGrepPattern("rg 'TODO: remove' src/")).toBe("comment/marker");
  });

  it("classifies a literal phrase", () => {
    expect(classifyGrepPattern("grep -rn 'collection not found' src/")).toBe("literal phrase");
  });

  it("classifies a regex", () => {
    expect(classifyGrepPattern("rg 'foo.*bar' src/")).toBe("regex/other");
  });

  it("classifies grep used as a pipe stage after another command", () => {
    expect(classifyGrepPattern("npm test | grep FAIL src/")).toBe("pipe filter");
  });

  it("does not treat a leading grep piped into another grep as a pipe filter", () => {
    expect(classifyGrepPattern("cd /r && grep -rn Foo src/ | grep -v test")).toBe("single identifier");
  });

  it("returns null for a grep that does not target code", () => {
    expect(classifyGrepPattern("grep -n error build.log")).toBeNull();
  });

  it("returns null for a command without grep or rg", () => {
    expect(classifyGrepPattern("cat src/a.ts")).toBeNull();
  });
});

describe("auditTranscript", () => {
  it("collects injection, worktree, tea-rags, bash, read and grep counters", () => {
    const lines = [
      "{not json",
      userPrompt(`Task.\n${LEGACY_HEADER}\n${WTO8_LINE}`, {
        timestamp: "2026-10-02T10:00:00.000Z",
        cwd: "/repo/.claude/worktrees/wt",
      }),
      toolUse("mcp__tea-rags__find_symbol", { path: "/repo/.claude/worktrees/wt", symbol: "Foo" }),
      toolUse("mcp__tea-rags__hybrid_search", { project: "tea-rags", query: "foo" }),
      toolUse("mcp__tea-rags__hybrid_search", { path: "", collection: "code_x", query: "foo" }),
      toolUse("Bash", { command: "cd /repo && grep -rn mergeChunks src/" }),
      toolUse("Bash", { command: "npm test" }),
      toolUse("Read", { file_path: "/repo/src/a.ts" }),
      toolUse("Grep", { pattern: "x" }),
      toolUse("Glob", { pattern: "**/*.ts" }),
      userPrompt("a later user message must not override the prompt"),
    ];

    const audit = auditTranscript(lines);

    expect(audit.injection).toBe("wto8");
    expect(audit.firstTimestamp).toBe("2026-10-02T10:00:00.000Z");
    expect(audit.inWorktree).toBe(true);
    expect(audit.teaRagsCalls).toBe(3);
    expect(audit.teaRagsByTool).toEqual({ find_symbol: 1, hybrid_search: 2 });
    expect(audit.teaRagsWithPath).toBe(1);
    expect(audit.teaRagsProjectOnly).toBe(2);
    expect(audit.bashSearchRead).toBe(1);
    expect(audit.readCalls).toBe(1);
    expect(audit.grepGlobCalls).toBe(2);
    expect(audit.grepClasses["single identifier"]).toBe(1);
  });

  it("reads the prompt from array content and reports no worktree for a plain cwd", () => {
    const first = JSON.stringify({
      type: "user",
      cwd: "/repo",
      message: { content: [{ type: "text", text: LEGACY_HEADER }] },
    });
    const audit = auditTranscript([first]);
    expect(audit.injection).toBe("legacy");
    expect(audit.inWorktree).toBe(false);
    expect(audit.firstTimestamp).toBeNull();
  });
});

describe("aggregateAudits", () => {
  it("groups by injection variant with per-agent ratios and path share", () => {
    const report = aggregateAudits([
      emptyAudit({
        injection: "wto8",
        inWorktree: true,
        bashSearchRead: 1,
        teaRagsCalls: 3,
        teaRagsWithPath: 2,
        teaRagsProjectOnly: 1,
        teaRagsByTool: { find_symbol: 3 },
      }),
      emptyAudit({
        injection: "wto8",
        bashSearchRead: 2,
        teaRagsCalls: 1,
        teaRagsWithPath: 0,
        teaRagsByTool: { hybrid_search: 1 },
      }),
      emptyAudit({ injection: "none", bashSearchRead: 5, readCalls: 4 }),
    ]);

    const { wto8, none } = report.byInjection;
    expect(wto8.agents).toBe(2);
    expect(wto8.inWorktree).toBe(1);
    expect(wto8.bashSearchRead).toBe(3);
    expect(wto8.teaRagsCalls).toBe(4);
    expect(wto8.bashPerAgent).toBe(1.5);
    expect(wto8.teaRagsPerAgent).toBe(2);
    expect(wto8.pathShare).toBe(0.5);
    expect(wto8.teaRagsByTool).toEqual({ find_symbol: 3, hybrid_search: 1 });

    expect(none.agents).toBe(1);
    expect(none.readCalls).toBe(4);
    expect(none.pathShare).toBeNull();
    expect(none.teaRagsPerAgent).toBe(0);

    expect(report.byInjection.legacy.agents).toBe(0);
    expect(report.byInjection.legacy.bashPerAgent).toBeNull();
  });

  it("rounds per-agent ratios to two decimals", () => {
    const report = aggregateAudits([
      emptyAudit({ teaRagsCalls: 1 }),
      emptyAudit({ teaRagsCalls: 0 }),
      emptyAudit({ teaRagsCalls: 0 }),
    ]);
    expect(report.byInjection.none.teaRagsPerAgent).toBe(0.33);
  });

  it("totals grep classes and reports the symbol-shaped share", () => {
    const base = emptyAudit({});
    const report = aggregateAudits([
      emptyAudit({ grepClasses: { ...base.grepClasses, "single identifier": 2, "qualified symbol": 1 } }),
      emptyAudit({ grepClasses: { ...base.grepClasses, "identifier alternation": 1, "pipe filter": 4 } }),
    ]);
    expect(report.grepClasses["single identifier"]).toBe(2);
    expect(report.grepClasses["pipe filter"]).toBe(4);
    expect(report.symbolShapedShare).toBe(0.5);
  });

  it("reports a null symbol-shaped share when there are no greps", () => {
    expect(aggregateAudits([emptyAudit({})]).symbolShapedShare).toBeNull();
  });
});

describe("runAudit", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagent-audit-"));
    const subDir = join(root, "session-a", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-new.jsonl"),
      [
        userPrompt(`Task\n${WTO8_LINE}`, { timestamp: "2026-10-02T00:00:00Z" }),
        toolUse("mcp__tea-rags__find_symbol", { path: "/repo", symbol: "Foo" }),
      ].join("\n"),
    );
    writeFileSync(
      join(subDir, "agent-old.jsonl"),
      [
        userPrompt(`Task\n${LEGACY_HEADER}`, { timestamp: "2026-09-01T00:00:00Z" }),
        toolUse("Bash", { command: "grep -rn Foo src/" }),
      ].join("\n"),
    );
    writeFileSync(
      join(root, "session-a.jsonl"),
      [userPrompt("main session"), toolUse("Bash", { command: "grep -rn Foo src/" })].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("audits only subagent transcripts", async () => {
    const run = await runAudit({ roots: [root] });
    expect(run.files).toBe(2);
    expect(run.roots).toEqual([root]);
    expect(run.since).toBeNull();
    expect(run.byInjection.wto8.agents).toBe(1);
    expect(run.byInjection.legacy.agents).toBe(1);
    expect(run.byInjection.legacy.bashSearchRead).toBe(1);
    expect(run.byInjection.none.agents).toBe(0);
  });

  it("drops subagents older than --since", async () => {
    const run = await runAudit({ roots: [root], since: "2026-10-01" });
    expect(run.since).toBe("2026-10-01");
    expect(run.byInjection.wto8.agents).toBe(1);
    expect(run.byInjection.legacy.agents).toBe(0);
  });

  it("tolerates a missing root", async () => {
    const run = await runAudit({ roots: [join(root, "does-not-exist")] });
    expect(run.files).toBe(0);
  });
});
