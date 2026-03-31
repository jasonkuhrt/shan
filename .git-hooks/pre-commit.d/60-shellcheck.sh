#!/usr/bin/env bash
set -euo pipefail

declare -a shell_paths=()

while IFS= read -r shell_path; do
  [[ -n "$shell_path" ]] || continue
  shell_paths+=("$shell_path")
done < <(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/).+\.sh$' || true)

if [[ "${#shell_paths[@]}" -eq 0 ]]; then
  exit 0
fi

exec shellcheck "${shell_paths[@]}"
