/**
 * Re-export from the shared infra home so existing imports continue to resolve.
 * The implementation was relocated to `infra/materialize.ts` so that both the
 * `ingest` chunker and the `trajectory` codegraph provider can import it without
 * a domain-boundary violation (trajectory → ingest is forbidden).
 */
export { materializeTree } from "../../../../infra/materialize.js";
