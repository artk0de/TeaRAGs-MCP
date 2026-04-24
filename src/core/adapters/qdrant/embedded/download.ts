import { execSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigValueInvalidError } from "../../../../bootstrap/errors.js";
import { QdrantOperationError } from "../errors.js";

export const EMBEDDED_QDRANT_VERSION = "1.17.0";

/* v8 ignore next 3 -- fallback for backward compat when DI paths not provided */
function fallbackAppDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

const PLATFORM_MAP: Record<string, Record<string, string>> = {
  darwin: {
    arm64: "qdrant-aarch64-apple-darwin.tar.gz",
    x64: "qdrant-x86_64-apple-darwin.tar.gz",
  },
  linux: {
    x64: "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    arm64: "qdrant-aarch64-unknown-linux-musl.tar.gz",
  },
  win32: {
    x64: "qdrant-x86_64-pc-windows-msvc.zip",
  },
};

export function getPlatformAsset(platform: string, arch: string): string {
  const archMap = PLATFORM_MAP[platform];
  if (!archMap?.[arch]) {
    throw new ConfigValueInvalidError(
      "platform",
      `${platform}-${arch}`,
      "linux-x64, linux-arm64, darwin-x64, darwin-arm64",
    );
  }
  return archMap[arch];
}

export function getQdrantBinaryDir(appDataPath?: string): string {
  return join(appDataPath ?? fallbackAppDataDir(), "qdrant", "bin");
}

export function getBinaryPath(platform = process.platform, appDataPath?: string): string {
  const name = platform === "win32" ? "qdrant.exe" : "qdrant";
  return join(getQdrantBinaryDir(appDataPath), name);
}

export function getDownloadUrl(asset: string): string {
  return `https://github.com/qdrant/qdrant/releases/download/v${EMBEDDED_QDRANT_VERSION}/${asset}`;
}

function getVersionPath(appDataPath?: string): string {
  return join(dirname(getBinaryPath(undefined, appDataPath)), "qdrant.version");
}

function getInstalledVersion(appDataPath?: string): string | null {
  try {
    return readFileSync(getVersionPath(appDataPath), "utf-8").trim();
  } catch {
    return null;
  }
}

function writeInstalledVersion(appDataPath?: string): void {
  writeFileSync(getVersionPath(appDataPath), EMBEDDED_QDRANT_VERSION, "utf-8");
}

export function isBinaryPresent(appDataPath?: string): boolean {
  return existsSync(getBinaryPath(undefined, appDataPath));
}

export function isBinaryUpToDate(appDataPath?: string): boolean {
  return isBinaryPresent(appDataPath) && getInstalledVersion(appDataPath) === EMBEDDED_QDRANT_VERSION;
}

export async function downloadQdrant(
  platform = process.platform,
  arch = process.arch,
  appDataPath?: string,
): Promise<string> {
  const asset = getPlatformAsset(platform, arch);
  const url = getDownloadUrl(asset);
  const binaryPath = getBinaryPath(platform, appDataPath);
  const cacheDir = dirname(binaryPath);

  mkdirSync(cacheDir, { recursive: true });

  const archivePath = join(cacheDir, asset);
  await downloadFile(url, archivePath);

  if (asset.endsWith(".zip")) {
    // Windows: unzip
    execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${cacheDir}' -Force"`, {
      stdio: "pipe",
    });
  } else {
    // macOS/Linux: tar
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(cacheDir)} qdrant`, {
      stdio: "pipe",
    });
  }

  unlinkSync(archivePath);

  if (platform !== "win32") {
    chmodSync(binaryPath, 0o755);
  }

  writeInstalledVersion(appDataPath);
  return binaryPath;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (reqUrl: string) => {
      get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const { location } = res.headers;
          if (!location) {
            reject(new QdrantOperationError("download", "Redirect without location"));
            return;
          }
          request(location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new QdrantOperationError("download", `HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", reject);
    };
    request(url);
  });
}
