#!/usr/bin/env bash
# Dispatch exactly one successor of production-synthetic-monitor.
# Uses GITHUB_TOKEN / GH_TOKEN. Never prints the token.
set -euo pipefail

if [[ "${GITHUB_RUN_ATTEMPT:-1}" != "1" ]]; then
  echo "successor_dispatch=skipped_retry"
  exit 0
fi

marker="${RUNNER_TEMP:-/tmp}/iranpay-successor-dispatched"
if [[ -f "$marker" ]]; then
  echo "successor_dispatch=duplicate_blocked"
  exit 1
fi

ref="${GITHUB_REF_NAME:-main}"
# Do not pass duration_ms: the workflow default on the ref is used.
# A failed dispatch must fail this step (set -e) so the run is red and
# SYNTHETIC:RUNNER:STALE can open if nobody restarts the loop.
gh workflow run production-synthetic-monitor.yml \
  --repo "${GITHUB_REPOSITORY:-$GH_REPO}" \
  --ref "$ref" \
  -f mode=session

touch "$marker"
echo "successor_dispatch=ok"
echo "successor_ref=$ref"
echo "predecessor_run=${GITHUB_RUN_ID:-unknown}"
echo "dispatched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
