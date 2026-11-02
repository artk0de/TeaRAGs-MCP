/**
 * The `sun_path` guard every unix-socket daemon shares (bd tea-rags-mcp-js1ie,
 * tea-rags-mcp-8tbaa, tea-rags-mcp-64j9p). A daemon socket lives in its HOME
 * dir (the codegraph key dir, the app-data dir for ONNX); when that path is
 * past the platform bound, `listen` fails with EINVAL, so the socket moves
 * into a short per-user ALIAS dir under tmp — a symlink to the home dir, so
 * `dirname(socket)` still reaches the home dir's other files.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { UnixSocketDirForeignOwnerError } from "./errors.js";

/** What the derivation depends on besides the home dir; tests inject it. */
export interface UnixSocketHost {
  platform?: NodeJS.Platform;
  tmpDir?: string;
  /** The user the alias belongs to; defaults to `process.getuid()`. */
  uid?: number;
}

/**
 * Usable bytes of a unix socket path: `sun_path` is 108 bytes on Linux and
 * 104 on macOS / the BSDs, both including the terminating NUL. Unknown POSIX
 * platforms take the stricter BSD bound.
 */
export function unixSocketPathMaxBytes(platform: NodeJS.Platform): number {
  return platform === "linux" || platform === "android" ? 107 : 103;
}

function hostUid(host: UnixSocketHost): number | undefined {
  return host.uid ?? process.getuid?.();
}

/**
 * The socket `fileName` of the daemon whose home is `homeDir` — the one
 * derivation the listening daemon and every client share. Normally
 * `<homeDir>/<fileName>`. Over the bound, it moves to
 * `<tmp>/tea-rags-<uid>-<hash of homeDir>/<fileName>`, falling back to `/tmp`
 * when the tmp dir itself is too deep (macOS `/var/folders/...`). The uid
 * keeps the name per user: `/tmp` is shared, and a name another user could
 * predict and pre-create would block our daemon (8tbaa). Same home dir + same
 * user → same path. Windows is exempt: there is no `sun_path` to bound.
 */
export function boundedUnixSocketPath(homeDir: string, fileName: string, host: UnixSocketHost = {}): string {
  const platform = host.platform ?? process.platform;
  const inHomeDir = join(homeDir, fileName);
  if (platform === "win32") return inHomeDir;
  const maxBytes = unixSocketPathMaxBytes(platform);
  if (Buffer.byteLength(inHomeDir) <= maxBytes) return inHomeDir;
  const uid = hostUid(host);
  const hash = createHash("sha256").update(homeDir).digest("hex").slice(0, 12);
  const alias = uid === undefined ? `tea-rags-${hash}` : `tea-rags-${uid}-${hash}`;
  const underTmp = join(host.tmpDir ?? tmpdir(), alias, fileName);
  if (Buffer.byteLength(underTmp) <= maxBytes) return underTmp;
  return join("/tmp", alias, fileName);
}

/** The alias dir `socketPath` uses for `homeDir`, or undefined when it sits in the home dir or a custom place. */
function unixSocketAliasDir(homeDir: string, socketPath: string, host: UnixSocketHost): string | undefined {
  const socketDir = dirname(socketPath);
  if (socketDir === homeDir) return undefined;
  return socketPath === boundedUnixSocketPath(homeDir, basename(socketPath), host) ? socketDir : undefined;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Make the socket's parent dir exist before `listen`. An in-home socket needs
 * only the dir; an alias dir is (re)pointed at `homeDir` — a stale alias of
 * OURS is replaced, a matching one kept. An alias owned by another user is
 * never touched: it throws `UnixSocketDirForeignOwnerError` (8tbaa), as does
 * losing the create race to one.
 */
export function ensureUnixSocketDir(homeDir: string, socketPath: string, host: UnixSocketHost = {}): void {
  const aliasDir = unixSocketAliasDir(homeDir, socketPath, host);
  if (aliasDir === undefined) {
    mkdirSync(dirname(socketPath), { recursive: true });
    return;
  }
  mkdirSync(homeDir, { recursive: true });
  const uid = hostUid(host);
  const existing = lstatOrUndefined(aliasDir);
  if (existing !== undefined) {
    if (uid !== undefined && existing.uid !== uid) throw new UnixSocketDirForeignOwnerError(aliasDir, existing.uid);
    if (existing.isSymbolicLink() && readlinkSync(aliasDir) === homeDir) return;
    rmSync(aliasDir, { recursive: true, force: true });
  }
  try {
    symlinkSync(homeDir, aliasDir, "dir");
  } catch (error) {
    // A concurrent spawn of our own may have created the same link first.
    const raced = lstatOrUndefined(aliasDir);
    if (raced?.isSymbolicLink() && raced.uid === uid && readlinkSync(aliasDir) === homeDir) return;
    throw new UnixSocketDirForeignOwnerError(aliasDir, raced?.uid, error as Error);
  }
}

/**
 * Drop the alias dir `ensureUnixSocketDir` made for `homeDir` — on a clean
 * daemon shutdown and when the home dir itself is swept. Only an alias of
 * ours is removed; an in-home socket dir and another user's alias are left.
 */
export function removeUnixSocketAlias(homeDir: string, socketPath: string, host: UnixSocketHost = {}): void {
  const aliasDir = unixSocketAliasDir(homeDir, socketPath, host);
  if (aliasDir === undefined) return;
  const existing = lstatOrUndefined(aliasDir);
  if (existing === undefined) return;
  const uid = hostUid(host);
  if (uid !== undefined && existing.uid !== uid) return;
  rmSync(aliasDir, { recursive: true, force: true });
}
