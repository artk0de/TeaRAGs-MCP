// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/** Native-asset download errors: a verified download that failed or did not match its digest. */

import { InfraError } from "../errors.js";

/** The asset could not be fetched: the request was rejected, or the server answered without a body. */
export class NativeAssetDownloadError extends InfraError {
  constructor(url: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_NATIVE_ASSET_DOWNLOAD_FAILED",
      message: `Downloading ${url} failed (${detail})`,
      hint: "Retry; check the network connection and, behind a proxy, that HTTPS_PROXY is set",
      cause,
    });
  }
}

/** The downloaded bytes do not hash to the digest the asset is pinned to; nothing was kept. */
export class NativeAssetIntegrityError extends InfraError {
  constructor(o: { fileName: string; url: string; expected: string; actual: string }) {
    super({
      code: "INFRA_NATIVE_ASSET_INTEGRITY_MISMATCH",
      message: `sha256 mismatch for ${o.fileName} from ${o.url}: expected ${o.expected}, got ${o.actual}`,
      hint: "Re-run the command to download it again; a repeated mismatch means the upstream asset changed",
    });
  }
}
