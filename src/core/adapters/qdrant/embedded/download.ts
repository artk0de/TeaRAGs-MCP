import { chmodSync, createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const QDRANT_VERSION = "1.17.0";

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
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return archMap[arch];
}

export function getBinaryPath(platform = process.platform): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const name = platform === "win32" ? "qdrant.exe" : "qdrant";
  return join(__dirname, "../../node_modules/.cache/tea-rags", name);
}

export function getDownloadUrl(asset: string): string {
  return `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/${asset}`;
}

export function isBinaryPresent(): boolean {
  return existsSync(getBinaryPath());
}

export async function downloadQdrant(
  platform = process.platform,
  arch = process.arch,
): Promise<string> {
  const asset = getPlatformAsset(platform, arch);
  const url = getDownloadUrl(asset);
  const binaryPath = getBinaryPath(platform);
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

  return binaryPath;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (reqUrl: string) => {
      get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) return reject(new Error("Redirect without location"));
          request(location);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
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
