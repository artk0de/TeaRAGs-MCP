/**
 * Error contract — defines the shape all TeaRags errors must satisfy.
 */

/**
 * Every TeaRags error implements this contract.
 * Machine-readable code, human-readable message+hint, HTTP status, optional cause.
 */
export interface TeaRagsErrorContract {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly httpStatus: number;
  readonly cause?: Error;
}

/**
 * Loose runtime contract for error codes. Strict per-domain unions live in
 * each domain's `errors.ts` (see `IngestErrorCode`, `ExploreErrorCode`,
 * `TrajectoryErrorCode`, `InfraErrorCode`, `InputErrorCode`,
 * `ConfigErrorCode`). Aggregating those here would violate
 * `domain-boundaries.md` (contracts cannot import from domains).
 */
export type ErrorCode = string;
