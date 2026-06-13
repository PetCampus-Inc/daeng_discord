#!/usr/bin/env bash
# 로컬 state.json 을 GitHub repo secret `HOLA_STATE_B64` 로 업로드.
# 사용:
#   chmod +x scripts/hola/upload-state.sh
#   ./scripts/hola/upload-state.sh
#
# 사전 조건:
#   - gh CLI 가 로그인되어 있어야 함 (`gh auth status` 로 확인)
#   - 현재 리포지토리가 git remote `origin` 으로 GitHub 에 연결되어 있어야 함

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_PATH="$ROOT_DIR/scripts/hola/state.json"

if [ ! -s "$STATE_PATH" ]; then
  echo "❌ $STATE_PATH 가 없습니다. 먼저 'npm run hola:login' 으로 로그인하세요."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ gh CLI 가 설치되어 있지 않습니다. https://cli.github.com/ 참고."
  exit 1
fi

# Cross-platform base64 single-line encode
B64=$(base64 < "$STATE_PATH" | tr -d '\n')

echo -n "$B64" | gh secret set HOLA_STATE_B64
echo "✅ HOLA_STATE_B64 업로드 완료 ($(echo -n "$B64" | wc -c) bytes)"
