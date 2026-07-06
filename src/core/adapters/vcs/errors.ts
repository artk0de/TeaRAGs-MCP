/**
 * VCS adapter errors.
 *
 * Fail-loud contract: an explicitly selected adapter whose backing binding
 * cannot load throws — there is no silent fallback. The hint must be
 * executable by an agent as-is (install, retry, no human intervention).
 */

import { InfraError } from "../errors.js";

const INSTALL_HINTS: Record<string, string> = {
  darwin: `Install (darwin):
  npm install -g es-git          # arm64 + x64 prebuilt binaries
  # If no prebuild exists for your platform, install the Rust toolchain first:
  #   brew install rustup && rustup-init -y
  # then re-run the npm install.`,
  linux: `Install (linux):
  npm install -g es-git          # x64/arm64 gnu + musl prebuilt binaries
  # No prebuild: apt install build-essential (or dnf groupinstall
  # "Development Tools"), install rustup, then re-run the npm install.`,
  win32: `Install (win32):
  npm install -g es-git          # x64 prebuilt binary
  # No prebuild: install Visual Studio Build Tools + rustup,
  # then re-run the npm install.`,
};

export class VcsAdapterUnavailableError extends InfraError {
  constructor(adapter: string, cause: string, platform: string = process.platform) {
    const installHint = INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux;
    super({
      code: "INFRA_VCS_ADAPTER_UNAVAILABLE",
      message: `${adapter} adapter selected (GIT_ADAPTER=${adapter}) but the binding failed to load.\nCause: ${cause}`,
      hint:
        `${installHint}\n\n` +
        `Then retry the command. Alternatively set GIT_ADAPTER=git to use the CLI adapter for this project.`,
      httpStatus: 503,
    });
  }
}
