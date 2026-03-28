import { TeaRagsError } from "../errors.js";

export class MigrationStepError extends TeaRagsError {
  constructor(pipeline: string, stepName: string, cause: Error) {
    super({
      code: "INGEST_MIGRATION_FAILED",
      message: `Migration "${stepName}" failed in pipeline "${pipeline}": ${cause.message}`,
      hint: "Check the error details and retry. If persistent, try forceReindex=true.",
      httpStatus: 500,
      cause,
    });
  }
}
