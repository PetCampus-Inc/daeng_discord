#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="scripts/inflearn/state.json"
COMPACT_FILE="$(mktemp)"
if [ ! -s "$STATE_FILE" ]; then
  echo "missing $STATE_FILE"
  exit 1
fi

node - "$STATE_FILE" "$COMPACT_FILE" <<'NODE'
const fs = require("fs");
const [, , input, output] = process.argv;
const state = JSON.parse(fs.readFileSync(input, "utf8"));
const compact = {
  cookies: (state.cookies || []).filter((cookie) =>
    String(cookie.domain || "").includes("inflearn.com")
  ),
  origins: (state.origins || [])
    .filter((origin) => {
      try {
        return new URL(origin.origin).hostname.endsWith("inflearn.com");
      } catch (_) {
        return false;
      }
    })
    .map((origin) => ({
      origin: origin.origin,
      localStorage: (origin.localStorage || []).filter(
        (item) => !String(item.name || "").startsWith("hackle-workspace-config_")
      ),
      indexedDB: origin.indexedDB || [],
    })),
};
fs.writeFileSync(output, JSON.stringify(compact));
NODE

if base64 --help 2>&1 | grep -q -- "-w"; then
  base64 -w0 "$COMPACT_FILE" | gh secret set INFLEARN_STATE_B64
else
  base64 -i "$COMPACT_FILE" | tr -d '\n' | gh secret set INFLEARN_STATE_B64
fi
rm -f "$COMPACT_FILE"
echo "INFLEARN_STATE_B64 updated"
