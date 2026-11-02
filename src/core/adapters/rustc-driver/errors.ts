/** rustc call-site driver release errors (GitHub Release download). */

import { InfraError } from "../errors.js";

/** The release carries no driver for this platform, or its manifest could not be fetched. */
export class RustcDriverReleaseUnavailableError extends InfraError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INFRA_RUSTC_DRIVER_RELEASE_UNAVAILABLE",
      message: `No prebuilt rustc call-site driver: ${detail}`,
      hint: "Build it locally instead: rustup toolchain install <pin> -c rustc-dev,rust-src, then reindex — the driver is built on first use",
      cause,
    });
  }
}

/** The release was built from another pin or driver source than this tea-rags build expects. */
export class RustcDriverReleaseStaleError extends InfraError {
  constructor(released: { pin: string; sourceHash: string }, expected: { pin: string; sourceHash: string }) {
    super({
      code: "INFRA_RUSTC_DRIVER_RELEASE_STALE",
      message:
        `Stale rustc driver release: built for ${released.pin} ${released.sourceHash.slice(0, 12)}, ` +
        `this tea-rags expects ${expected.pin} ${expected.sourceHash.slice(0, 12)}`,
      hint: "Install the driver from the release matching this tea-rags version (tea-rags rustc-driver install --version <x.y.z>)",
    });
  }
}
