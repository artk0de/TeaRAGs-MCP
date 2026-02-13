/**
 * Output Generation
 *
 * Functions for generating output files and displaying results.
 */

import { writeFileSync } from "fs";
import { join } from "path";

import { c } from "./colors.mjs";
import { config, SAMPLE_SIZE } from "./config.mjs";
import { getTimeEstimatesData } from "./estimator.mjs";

/**
 * Generate environment file content
 */
export function generateEnvContent(optimal, metrics, totalTime) {
  const estimates = getTimeEstimatesData(metrics.embeddingRate, metrics.storageRate);

  return `# Tea Rags MCP - Tuned Environment Variables
# Generated: ${new Date().toISOString()}
# Hardware: ${config.EMBEDDING_BASE_URL} (${config.EMBEDDING_MODEL})
# Duration: ${totalTime}s
# Sample size: ${SAMPLE_SIZE} chunks

# Embedding configuration
EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE}
EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY}

# Qdrant storage configuration
QDRANT_UPSERT_BATCH_SIZE=${optimal.QDRANT_UPSERT_BATCH_SIZE}
QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING}
QDRANT_FLUSH_INTERVAL_MS=${optimal.QDRANT_FLUSH_INTERVAL_MS}
BATCH_FORMATION_TIMEOUT_MS=${optimal.BATCH_FORMATION_TIMEOUT_MS}

# Qdrant deletion configuration
QDRANT_DELETE_BATCH_SIZE=${optimal.QDRANT_DELETE_BATCH_SIZE}
QDRANT_DELETE_CONCURRENCY=${optimal.QDRANT_DELETE_CONCURRENCY}

# Performance metrics (for reference)
# Embedding rate: ${metrics.embeddingRate || "N/A"} chunks/s
# Storage rate: ${metrics.storageRate || "N/A"} chunks/s
# Deletion rate: ${metrics.deletionRate || "N/A"} del/s

# Estimated indexing times:
${estimates.map((e) => `# ${e.name.padEnd(20)} (${formatLoc(e.loc)} LoC): ${e.formattedTotal}`).join("\n")}
`;
}

function formatLoc(loc) {
  if (loc >= 1_000_000) return `${(loc / 1_000_000).toFixed(1)}M`;
  if (loc >= 1_000) return `${(loc / 1_000).toFixed(0)}K`;
  return loc.toString();
}

/**
 * Write environment file
 */
export function writeEnvFile(projectRoot, optimal, metrics, totalTime) {
  const envContent = generateEnvContent(optimal, metrics, totalTime);
  const envPath = join(projectRoot, "tuned_environment_variables.env");
  writeFileSync(envPath, envContent);
  return envPath;
}

/**
 * Print summary
 */
export function printSummary(optimal) {
  console.log(`${c.bold}Optimal configuration:${c.reset}`);
  console.log();
  console.log(`  ${c.dim}# Embedding${c.reset}`);
  console.log(`  EMBEDDING_BATCH_SIZE      = ${c.green}${c.bold}${optimal.EMBEDDING_BATCH_SIZE}${c.reset}`);
  console.log(`  EMBEDDING_CONCURRENCY     = ${c.green}${c.bold}${optimal.EMBEDDING_CONCURRENCY}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}# Qdrant storage${c.reset}`);
  console.log(
    `  QDRANT_UPSERT_BATCH_SIZE           = ${c.green}${c.bold}${optimal.QDRANT_UPSERT_BATCH_SIZE}${c.reset}`,
  );
  console.log(`  QDRANT_BATCH_ORDERING     = ${c.green}${c.bold}${optimal.QDRANT_BATCH_ORDERING}${c.reset}`);
  console.log(`  QDRANT_FLUSH_INTERVAL_MS  = ${c.green}${c.bold}${optimal.QDRANT_FLUSH_INTERVAL_MS}${c.reset}`);
  console.log(`  BATCH_FORMATION_TIMEOUT_MS = ${c.green}${c.bold}${optimal.BATCH_FORMATION_TIMEOUT_MS}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}# Qdrant deletion${c.reset}`);
  console.log(`  QDRANT_DELETE_BATCH_SIZE         = ${c.green}${c.bold}${optimal.QDRANT_DELETE_BATCH_SIZE}${c.reset}`);
  console.log(`  QDRANT_DELETE_CONCURRENCY        = ${c.green}${c.bold}${optimal.QDRANT_DELETE_CONCURRENCY}${c.reset}`);
  console.log();
}

/**
 * Print usage instructions
 */
export function printUsage(optimal) {
  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  ${c.dim}# Add to Claude Code MCP config:${c.reset}`);
  console.log(`  ${c.dim}claude mcp add tea-rags ... \\${c.reset}`);
  console.log(`    -e EMBEDDING_BATCH_SIZE=${optimal.EMBEDDING_BATCH_SIZE} \\`);
  console.log(`    -e EMBEDDING_CONCURRENCY=${optimal.EMBEDDING_CONCURRENCY} \\`);
  console.log(`    -e QDRANT_UPSERT_BATCH_SIZE=${optimal.QDRANT_UPSERT_BATCH_SIZE} \\`);
  console.log(`    -e QDRANT_BATCH_ORDERING=${optimal.QDRANT_BATCH_ORDERING} \\`);
  console.log(`    -e QDRANT_FLUSH_INTERVAL_MS=${optimal.QDRANT_FLUSH_INTERVAL_MS} \\`);
  console.log(`    -e BATCH_FORMATION_TIMEOUT_MS=${optimal.BATCH_FORMATION_TIMEOUT_MS} \\`);
  console.log(`    -e QDRANT_DELETE_BATCH_SIZE=${optimal.QDRANT_DELETE_BATCH_SIZE} \\`);
  console.log(`    -e QDRANT_DELETE_CONCURRENCY=${optimal.QDRANT_DELETE_CONCURRENCY}`);
  console.log();
}
