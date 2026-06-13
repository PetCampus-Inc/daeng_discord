# holaworld.io 자동 모집글 게시

브라우저 자동화로 홀라(holaworld.io) 의 프로젝트 모집글을 자동 등록합니다.
로그인은 카카오/구글 OAuth 만 있어서 첫 1회는 사용자가 직접, 이후는 저장된 세션으로 자동.

## 구성
- `login.js` — 헤드풀 로그인 → `state.json` 저장
- `post.js` — 저장된 세션으로 폼 자동 작성 + 등록
- `ping.js` — `/api/auth/token` 호출로 세션 갱신만 (Chromium 불필요)
- `config.js` — 게시 내용 (제목/본문/포지션/스택 등)
- `state.json` — 로그인 세션 (gitignored)
- `upload-state.sh` — state.json 을 GitHub secret 으로 올리는 헬퍼

## 로컬 사용

### 최초 1회 — 로그인
```
npm run hola:login
```
브라우저가 떠서 카카오로 로그인 → 자동 감지 → `state.json` 저장.

### 내용 수정
`scripts/hola/config.js` 편집. **combobox 옵션 텍스트는 사이트 표기와 정확히 일치**해야 함.

### 드라이런 (등록 안 함)
```
npm run hola:post:dry
```

### 실제 등록
```
npm run hola:post
```

### 세션만 갱신
```
npm run hola:ping
```

## GitHub Actions 셋업 — 2일 1회 자동 게시 + 2시간마다 세션 ping

### 1. GitHub PAT 생성 (secret 자동 회전용)
- https://github.com/settings/tokens → "Generate new token (fine-grained)"
- Repository access: 이 레포만 선택
- Permissions: **Secrets — Read and write**, **Metadata — Read**
- 토큰 복사

### 2. Repo Secret 등록
1. `gh secret set GH_PAT --body "ghp_..."` ← 위에서 만든 토큰
2. `./scripts/hola/upload-state.sh` ← 로컬 state.json 을 `HOLA_STATE_B64` 로 업로드
3. (옵션) `gh secret set DISCORD_WEBHOOK_URL --body "https://discord.com/api/webhooks/..."` ← 실패 알림

### 3. Workflow 활성화
- 파일: `.github/workflows/hola-post.yml`, `hola-ping.yml`
- 푸시하면 자동 활성화. Actions 탭에서 수동 트리거(dispatch) 도 가능.

### 동작 흐름
- `hola-ping.yml` — 매 짝수시각(2시간마다) `/api/auth/token` 호출 + 갱신된 쿠키를 secret 으로 다시 업로드
- `hola-post.yml` — 2일마다 KST 10:00 에 폼 자동 작성 + 등록 + 갱신된 쿠키를 secret 으로 업로드
- 어느 쪽이든 **세션 만료 감지(exit 3)** 시 디스코드 알림

### 세션 만료 시 회복
1. 디스코드 알림 도착
2. 로컬에서 `npm run hola:login` (1회)
3. `./scripts/hola/upload-state.sh` (state 갱신)
4. 다음 워크플로부터 자동 복구

## 주의
- 홀라 약관에 자동화 도구 사용 금지 조항이 있을 수 있으니 본인 책임 하에.
- 동일 글 빈번 게시는 스팸으로 비칠 수 있어 2일 이상 간격 권장.
- combobox 옵션은 사이트 표기 그대로 (`Nodejs` 점 없음, `구글 폼` 띄어쓰기 있음 등).
