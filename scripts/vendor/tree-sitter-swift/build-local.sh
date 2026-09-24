#!/bin/sh
# Build @artk0de/tree-sitter-swift with the two macOS prebuilds this machine can
# produce (darwin-arm64 native, darwin-x64 cross-compiled) and pack it.
# Linux and Windows prebuilds come from prebuild.workflow.yml; a pack from this
# script alone is for local validation, NOT for publishing.
#
# Usage: sh scripts/vendor/tree-sitter-swift/build-local.sh <work-dir>
set -eu
WORK=${1:?usage: build-local.sh <work-dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$WORK"
node "$HERE/prepare.js" "$WORK/pkg"
cd "$WORK/pkg"
npm install --omit peer --ignore-scripts --no-audit --no-fund
npx prebuildify --napi --strip --arch arm64
npx prebuildify --napi --strip --arch x64
rm -rf build node_modules
npm pack --pack-destination "$WORK"
