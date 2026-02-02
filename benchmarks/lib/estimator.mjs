/**
 * Time Estimator
 *
 * Estimates indexing time for different project sizes based on benchmark results.
 */

import { c } from "./colors.mjs";
import { PROJECT_SIZES, AVG_LOC_PER_CHUNK } from "./config.mjs";

/**
 * Format time duration in human-readable form
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
}

/**
 * Format number with K/M suffix
 */
function formatNumber(num) {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  } else if (num >= 1_000) {
    return `${(num / 1_000).toFixed(0)}K`;
  }
  return num.toString();
}

/**
 * Print time estimation table based on benchmark results
 */
export function printTimeEstimates(embeddingRate, storageRate) {
  console.log(`${c.bold}Estimated indexing times:${c.reset}`);
  console.log();

  // Table header
  const header = `  ${"Project Type".padEnd(20)} ${"LoC".padStart(8)} ${"Chunks".padStart(10)} ${"Embedding".padStart(12)} ${"Storage".padStart(10)} ${"Total".padStart(10)}`;
  console.log(`${c.dim}${header}${c.reset}`);
  console.log(`${c.dim}  ${"─".repeat(72)}${c.reset}`);

  for (const project of PROJECT_SIZES) {
    const chunks = Math.ceil(project.loc / AVG_LOC_PER_CHUNK);

    // Calculate times
    const embeddingTime = embeddingRate > 0 ? chunks / embeddingRate : 0;
    const storageTime = storageRate > 0 ? chunks / storageRate : 0;
    const totalTime = embeddingTime + storageTime;

    // Determine row color based on total time
    const rowColor = totalTime < 60 ? c.green :
                    totalTime < 600 ? c.yellow :
                    totalTime < 3600 ? c.dim : c.red;

    const row = `  ${project.name.padEnd(20)} ${formatNumber(project.loc).padStart(8)} ${formatNumber(chunks).padStart(10)} ${formatDuration(embeddingTime).padStart(12)} ${formatDuration(storageTime).padStart(10)} ${formatDuration(totalTime).padStart(10)}`;
    console.log(`${rowColor}${row}${c.reset}`);
  }

  console.log();
  console.log(`${c.dim}  Note: Estimates based on ${embeddingRate} chunks/s (embedding) and ${storageRate} chunks/s (storage)${c.reset}`);
  console.log(`${c.dim}  Actual times may vary based on code complexity and file sizes${c.reset}`);
  console.log();
}

/**
 * Get estimates as data (for env file)
 */
export function getTimeEstimatesData(embeddingRate, storageRate) {
  return PROJECT_SIZES.map(project => {
    const chunks = Math.ceil(project.loc / AVG_LOC_PER_CHUNK);
    const embeddingTime = embeddingRate > 0 ? chunks / embeddingRate : 0;
    const storageTime = storageRate > 0 ? chunks / storageRate : 0;
    const totalTime = embeddingTime + storageTime;

    return {
      name: project.name,
      loc: project.loc,
      chunks,
      embeddingTime,
      storageTime,
      totalTime,
      formattedTotal: formatDuration(totalTime),
    };
  });
}
