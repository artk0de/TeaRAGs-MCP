/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testGitMetadata(qdrant, embeddings) {
  section("17. Git Metadata Integration");

  const gitTestDir = join(TEST_DIR, "git_metadata_test");
  await fs.mkdir(gitTestDir, { recursive: true });

  // Initialize git repo
  const execGit = async (args) => {
    const { execSync } = await import("child_process");
    return execSync(`git ${args}`, { cwd: gitTestDir, encoding: "utf8", stdio: "pipe" });
  };

  try {
    await execGit("init");
    await execGit('config user.email "test@example.com"');
    await execGit('config user.name "Test User"');
  } catch (e) {
    skip("Git not available, skipping git metadata tests");
    return;
  }

  // === TEST 1: Create files with commits and task IDs ===
  log("info", "Creating test files with git history...");

  // File 1 - with JIRA-style task ID
  await createTestFile(gitTestDir, "auth-service.ts", `
export class AuthService {
  login(username: string, password: string): boolean {
    // TD-1234: Implement login logic
    return username === "admin" && password === "secret";
  }
}
`);
  await execGit("add auth-service.ts");
  await execGit('commit -m "TD-1234 Add authentication service"');

  await sleep(100);

  // File 2 - with GitHub-style task ID
  await createTestFile(gitTestDir, "user-service.ts", `
export class UserService {
  getUser(id: number): { id: number; name: string } {
    // Fixes #567 - user lookup
    return { id, name: "John" };
  }
}
`);
  await execGit("add user-service.ts");
  await execGit('commit -m "Fixes #567 - Add user service"');

  await sleep(100);

  // File 3 - modify first file (adds second commit to it)
  await createTestFile(gitTestDir, "auth-service.ts", `
export class AuthService {
  login(username: string, password: string): boolean {
    // TD-1234: Implement login logic
    return username === "admin" && password === "secret";
  }

  logout(): void {
    // TD-5678: Session management
    console.log("Logged out");
  }
}
`);
  await execGit("add auth-service.ts");
  await execGit('commit -m "TD-5678 Add logout functionality"');

  // === TEST 2: Index with git metadata enabled ===
  log("info", "Indexing with git metadata enabled...");

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    enableGitMetadata: true,
  }));

  resources.trackIndexedPath(gitTestDir);
  const stats = await indexer.indexCodebase(gitTestDir);
  
  assert(stats.status === "completed", `Indexing completed: ${stats.status}`);
  assert(stats.filesIndexed === 2, `Files indexed: ${stats.filesIndexed}`);
  assert(stats.chunksCreated > 0, `Chunks created: ${stats.chunksCreated}`);

  // === TEST 3: Verify git metadata structure in search results ===
  log("info", "Verifying git metadata in search results...");

  const authResults = await indexer.searchCode(gitTestDir, "authentication login");
  assert(authResults.length > 0, `Found auth results: ${authResults.length}`);

  const authChunk = authResults[0];
  const gitMeta = authChunk.metadata?.git;

  assert(gitMeta !== undefined, "Git metadata present in chunk");
  assert(typeof gitMeta?.lastModifiedAt === "number", `lastModifiedAt is number: ${gitMeta?.lastModifiedAt}`);
  assert(typeof gitMeta?.firstCreatedAt === "number", `firstCreatedAt is number: ${gitMeta?.firstCreatedAt}`);
  assert(typeof gitMeta?.dominantAuthor === "string", `dominantAuthor is string: ${gitMeta?.dominantAuthor}`);
  assert(typeof gitMeta?.dominantAuthorEmail === "string", `dominantAuthorEmail is string: ${gitMeta?.dominantAuthorEmail}`);
  assert(Array.isArray(gitMeta?.authors), `authors is array: ${JSON.stringify(gitMeta?.authors)}`);
  assert(typeof gitMeta?.commitCount === "number", `commitCount is number: ${gitMeta?.commitCount}`);
  assert(typeof gitMeta?.lastCommitHash === "string", `lastCommitHash is string: ${gitMeta?.lastCommitHash?.slice(0, 8)}...`);
  assert(typeof gitMeta?.ageDays === "number", `ageDays is number: ${gitMeta?.ageDays}`);
  assert(Array.isArray(gitMeta?.taskIds), `taskIds is array: ${JSON.stringify(gitMeta?.taskIds)}`);

  assert(gitMeta?.dominantAuthor === "Test User", `Correct author: ${gitMeta?.dominantAuthor}`);
  assert(gitMeta?.dominantAuthorEmail === "test@example.com", `Correct email: ${gitMeta?.dominantAuthorEmail}`);

  // === TEST 4: Verify task ID extraction ===
  log("info", "Verifying task ID extraction...");

  const allResults = await indexer.searchCode(gitTestDir, "service function class");
  const allTaskIds = new Set();
  for (const result of allResults) {
    const taskIds = result.metadata?.git?.taskIds || [];
    taskIds.forEach(id => allTaskIds.add(id));
  }

  assert(allTaskIds.has("TD-1234") || allTaskIds.has("TD-5678"), `JIRA-style task IDs extracted: ${[...allTaskIds].join(", ")}`);
  assert(allTaskIds.has("#567"), `GitHub-style task ID extracted: ${[...allTaskIds].join(", ")}`);

  // === TEST 5: Search filter by author ===
  log("info", "Testing author filter...");

  const authorResults = await indexer.searchCode(gitTestDir, "service", {
    author: "Test User",
  });
  assert(authorResults.length > 0, `Author filter returns results: ${authorResults.length}`);
  assert(
    authorResults.every(r => r.metadata?.git?.dominantAuthor === "Test User"),
    "All results match author filter"
  );

  // === TEST 6: Search filter by task ID ===
  log("info", "Testing task ID filter...");

  const taskResults = await indexer.searchCode(gitTestDir, "service", {
    taskId: "TD-1234",
  });
  assert(taskResults.length > 0, `Task ID filter returns results: ${taskResults.length}`);
  assert(
    taskResults.every(r => r.metadata?.git?.taskIds?.includes("TD-1234")),
    "All results contain requested task ID"
  );

  // === TEST 7: Search filter by age ===
  log("info", "Testing age filters...");

  const freshResults = await indexer.searchCode(gitTestDir, "service", {
    maxAgeDays: 1,
  });
  assert(freshResults.length > 0, `maxAgeDays filter works: ${freshResults.length} results`);

  const oldResults = await indexer.searchCode(gitTestDir, "service", {
    minAgeDays: 100,
  });
  assert(oldResults.length === 0, `minAgeDays filter excludes fresh code: ${oldResults.length} results`);

  // === TEST 8: Search filter by date range ===
  log("info", "Testing date range filters...");

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const dateRangeResults = await indexer.searchCode(gitTestDir, "service", {
    modifiedAfter: yesterday,
    modifiedBefore: tomorrow,
  });
  assert(dateRangeResults.length > 0, `Date range filter works: ${dateRangeResults.length} results`);

  const futureResults = await indexer.searchCode(gitTestDir, "service", {
    modifiedAfter: tomorrow,
  });
  assert(futureResults.length === 0, `Future modifiedAfter returns nothing: ${futureResults.length}`);

  // === TEST 9: Search filter by commit count (churn) ===
  log("info", "Testing commit count filter...");

  const churnResults = await indexer.searchCode(gitTestDir, "service", {
    minCommitCount: 2,
  });
  const highChurnCount = churnResults.filter(r => r.metadata?.git?.commitCount >= 2).length;
  log("info", `High churn chunks (commitCount >= 2): ${highChurnCount}`);

  // === TEST 10: Git metadata with reindex ===
  log("info", "Testing git metadata survives reindex...");

  await createTestFile(gitTestDir, "new-service.ts", `
export class NewService {
  // AB#890: Azure DevOps style task
  process(): void {}
}
`);
  await execGit("add new-service.ts");
  await execGit('commit -m "AB#890 Add new service"');

  const reindexStats = await indexer.reindexChanges(gitTestDir);
  assert(reindexStats.status === "completed", `Reindex completed: ${reindexStats.status}`);

  const newResults = await indexer.searchCode(gitTestDir, "NewService process");
  if (newResults.length > 0) {
    const newMeta = newResults[0].metadata?.git;
    assert(newMeta !== undefined, "New file has git metadata after reindex");
    assert(newMeta?.taskIds?.includes("AB#890"), `Azure DevOps task ID extracted: ${newMeta?.taskIds?.join(", ")}`);
  }

  log("pass", "Git metadata integration verified");

  // === CORNER CASES ===
  log("info", "Testing corner cases...");

  // Corner case 1: Empty search result (no matching author)
  const noMatchAuthor = await indexer.searchCode(gitTestDir, "service", {
    author: "Nonexistent Author",
  });
  assert(noMatchAuthor.length === 0, `No results for nonexistent author: ${noMatchAuthor.length}`);

  // Corner case 2: Combined filters (author + age)
  const combinedFilters = await indexer.searchCode(gitTestDir, "service", {
    author: "Test User",
    maxAgeDays: 1,
  });
  assert(combinedFilters.length > 0, `Combined filters work: ${combinedFilters.length}`);

  // Corner case 3: Very old date filter (before repo existed)
  const ancientResults = await indexer.searchCode(gitTestDir, "service", {
    modifiedBefore: "2000-01-01",
  });
  assert(ancientResults.length === 0, `No results before repo existed: ${ancientResults.length}`);

  log("pass", "Corner cases verified");
}

/**
 * Documented real-world scenarios for git metadata
 */
export const scenarios = {
  findCodeByAuthor: {
    name: "Find code by author",
    description: "Show code where specific developer wrote most lines",
    uses: ["Code review", "Onboarding", "Debugging ownership"],
  },
  findRecentChanges: {
    name: "Find recent changes",
    description: "Filter by maxAgeDays for sprint review",
    uses: ["Sprint review", "Incident response", "Release notes"],
  },
  findLegacyCode: {
    name: "Find legacy code",
    description: "Filter by minAgeDays for tech debt assessment",
    uses: ["Tech debt", "Documentation needs", "Modernization"],
  },
  findHighChurn: {
    name: "Find high-churn code",
    description: "Filter by minCommitCount for problematic areas",
    uses: ["Code quality", "Refactoring candidates", "Risk assessment"],
  },
  findByTaskId: {
    name: "Find code by task ID",
    description: "Filter by taskId for traceability",
    uses: ["Requirements tracing", "Impact analysis", "Audit"],
  },
};
