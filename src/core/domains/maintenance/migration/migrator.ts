/**
 * Migrator — single entry point for all migration pipelines.
 *
 * Routes run(pipelineName) to the appropriate MigrationRunner.
 * Runner reads version once, runs applicable migrations in order,
 * stores new version on success.
 */

import { MigrationStepError } from "./errors.js";
import type { MigrationRunner, MigrationSummary } from "./types.js";

type PipelineName = "snapshot" | "schema" | "sparse";

export class Migrator {
  private readonly pipelines: Map<PipelineName, MigrationRunner>;

  constructor(pipelines: Record<PipelineName, MigrationRunner>) {
    this.pipelines = new Map(Object.entries(pipelines) as [PipelineName, MigrationRunner][]);
  }

  async run(pipeline: PipelineName): Promise<MigrationSummary> {
    const runner = this.pipelines.get(pipeline);
    if (!runner) {
      throw new Error(`Unknown migration pipeline: ${pipeline}`);
    }

    const currentVersion = await runner.getVersion();
    const migrations = runner
      .getMigrations()
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    const summary: MigrationSummary = {
      pipeline,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      steps: [],
    };

    if (migrations.length === 0) return summary;

    for (const migration of migrations) {
      try {
        const result = await migration.apply();
        summary.steps.push({
          name: migration.name,
          status: "applied",
          applied: result.applied,
        });
        summary.toVersion = migration.version;
      } catch (error) {
        throw new MigrationStepError(
          pipeline,
          migration.name,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    await runner.setVersion(summary.toVersion);
    return summary;
  }
}
