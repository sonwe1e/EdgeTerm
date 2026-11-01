#!/usr/bin/env bash
# Usage: scripts/version-bump.sh <major.minor.patch>
#
# Bumps the four version files and stops. Earlier revisions committed and
# pushed in one step, which bypassed review; pushing a release is a
# maintainer decision, so this script never touches git now.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version="${1:?Usage: scripts/version-bump.sh <major.minor.patch>}"

npm run version:set -- "$version"
npm run version:check
printf '%s\n' \
  "Review the diff, then commit the four version files yourself:" \
  "  git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock" \
  "  git commit -m \"chore: bump version to ${version}\""
