/**
 * Local-filesystem adapter errors.
 */

import { InfraError } from "../errors.js";

/**
 * The short alias directory an over-long unix socket moves into (see
 * `boundedUnixSocketPath`) already exists and belongs to another user (bd
 * tea-rags-mcp-8tbaa). The alias lives under a shared tmp dir, so it is never
 * taken over: replacing it would hand that user's daemon address to ours, and
 * a raw `EACCES` / `EEXIST` at `listen` would not say why the daemon is down.
 */
export class UnixSocketDirForeignOwnerError extends InfraError {
  constructor(aliasDir: string, ownerUid: number | undefined, cause?: Error) {
    super({
      code: "INFRA_UNIX_SOCKET_DIR_FOREIGN_OWNER",
      message:
        `Unix socket alias directory ${aliasDir} is owned by uid ${ownerUid ?? "unknown"}, not by this user; ` +
        "the daemon cannot listen there",
      hint:
        `Remove ${aliasDir} (it is not ours), or shorten TEA_RAGS_DATA_DIR / HOME so the daemon socket ` +
        "fits the platform's unix socket path limit without an alias.",
      httpStatus: 503,
      cause,
    });
  }
}
