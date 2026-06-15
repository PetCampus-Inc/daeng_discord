#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="scripts/inflearn/state.json"
if [ ! -s "$STATE_FILE" ]; then
  echo "missing $STATE_FILE"
  exit 1
fi

base64 -w0 "$STATE_FILE" | gh secret set INFLEARN_STATE_B64
echo "INFLEARN_STATE_B64 updated"
