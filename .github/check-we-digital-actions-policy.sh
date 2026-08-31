#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

manifest=.github/we-digital-actions-allowlist.txt
workflow=.github/workflows/build-and-deploy.yaml

manifest_count=$(awk '!/^#/ && NF { count++ } END { print count+0 }' "$manifest")
[[ "$manifest_count" -eq 1 ]] || {
  echo "expected exactly one reviewed workflow in $manifest" >&2
  exit 1
}

read -r expected_blob expected_path < <(awk '!/^#/ && NF { print $1, $2 }' "$manifest")
[[ "$expected_path" == "$workflow" ]] || {
  echo "unexpected allowlisted workflow: $expected_path" >&2
  exit 1
}
[[ "$expected_blob" =~ ^[a-f0-9]{40}$ ]] || {
  echo "invalid reviewed workflow blob hash" >&2
  exit 1
}

workflow_count=$(find .github/workflows -maxdepth 1 -type f \
  \( -name '*.yml' -o -name '*.yaml' \) -print | wc -l | tr -d ' ')
workflow_path=$(find .github/workflows -maxdepth 1 -type f \
  \( -name '*.yml' -o -name '*.yaml' \) -print | LC_ALL=C sort | head -n 1)
[[ "$workflow_count" -eq 1 && "$workflow_path" == "$workflow" ]] || {
  echo "workflow inventory differs from the closed allowlist" >&2
  find .github/workflows -maxdepth 1 -type f \
    \( -name '*.yml' -o -name '*.yaml' \) -print | LC_ALL=C sort >&2
  exit 1
}

actual_blob=$(git hash-object "$workflow")
[[ "$actual_blob" == "$expected_blob" ]] || {
  echo "reviewed workflow changed: expected $expected_blob, got $actual_blob" >&2
  echo "review the diff and intentionally refresh the manifest" >&2
  exit 1
}

if grep -Eq '^  (pull_request|pull_request_target|schedule):|^    tags(-ignore)?:' "$workflow"; then
  echo "forbidden trigger found in $workflow" >&2
  exit 1
fi

grep -Eq '^    branches: \[main, staging\]$' "$workflow"
[[ $(awk '/^jobs:/{inside=1; next} inside && /^  [A-Za-z0-9_-]+:$/ { count++ } END { print count+0 }' "$workflow") -eq 1 ]]
grep -Fqx '  build:' "$workflow"
grep -Fqx '  contents: read' "$workflow"
grep -Fqx '  packages: write' "$workflow"

echo "GitHub Actions policy OK: one reviewed packaging workflow"
