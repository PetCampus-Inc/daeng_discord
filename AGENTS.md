# AGENTS.md

This file is the canonical onboarding doc for AI coding agents (Claude Code,
Cursor, etc.) working on this repo. Read it before making any change.

## 1. Repo at a glance

**daeng_discord** — Knockdog 사이드 프로젝트 운영용 내부 어드민 + Discord
sync 봇 + 모집 자동화의 모놀리식 저장소.

* 라이브: <https://admin.knockdog.net>
* 배포: Railway (`522da9d1-...` 프로젝트의 `daeng_discord` 서비스)
* DB: Railway Postgres (`DATABASE_URL` env). 로컬 개발 시엔 `daeng_local` DB
* 자동 배포는 **현재 꺼져 있음**. push 후 `railway up -y --ci` 로 사용자가
  직접 띄움 (자세한 건 §6)

## 2. 작업 방식 (중요 — 항상 지켜야 함)

* **commit / push / deploy 는 명시 요청이 있을 때만.** 사용자가 "이대로
  commit 해줘", "푸시 진행해줘" 처럼 명확히 말한 뒤에만 실행. 변경이
  완료된 것 같아도 자동으로 묶지 말 것.
* 코드 변경 후엔 (1) 검증, (2) 짧은 요약 + 영향 범위 보고, (3) "commit
  하실까요?" 로 끝낼 것. 사용자 확인 받기 전까지 git 명령 금지.
* 시크릿 / 토큰 같은 거 채팅에 노출되면 사용자에게 즉시 revoke + 회전
  안내할 것.
* 한국어로 응답하는 게 기본. 코드 주석은 영어, 사용자 대화는 한국어.
* 회피 응답 ("어렵습니다", "안전상...") 보다는 옵션·트레이드오프·추천을
  먼저 제시. 결정은 사용자가 한다.
* 새 파일 생성보다 기존 파일 편집 우선. 문서·README 도 사용자가 명시할
  때만 새로 만들 것.

## 3. Tech stack

* **Node 22 + Express 5** — `server.js` 한 파일에 라우트 다 모여있음
  (≈1.8k 라인). 빌드 단계 없음.
* **Postgres (`pg`)** — `pool = new Pool({ connectionString: DATABASE_URL })`.
  스키마는 `server.js` 의 `initDatabase()` 가 매번 idempotent 하게 보장
  (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`).
  별도 마이그레이션 도구 없음. `database/schema.sql` 은 참조용 덤프
  (실행 안 함).
* **단일 HTML 프론트** — `public/index.html` 한 파일에 inline CSS + JS 다
  들어있음 (≈3.5k 라인). 빌드 없음, 새로고침이 곧 배포.
* **Discord.js + node-cron** — `index.js` 가 봇 엔트리지만 현재 봇 토큰
  없으면 `dashboard-only mode` 로 떠서 정적/API 만 동작. 운영은 대부분
  대시보드 중심.
* **Playwright** — `scripts/hola/` 의 holaworld 자동 게시용. **devDep**
  으로만 있어서 prod 이미지엔 안 들어감.
* **Jira API 클라이언트** — `src/jira-client.js`. 일부 엔드포인트가 이걸
  사용함.

## 4. 디렉토리 레이아웃

```
.
├── server.js                # Express + Postgres 백엔드 (모놀리식)
├── index.js                 # Discord 봇 엔트리 (대시보드만이면 안 떠도 됨)
├── public/index.html        # SPA-스럽지만 단일 HTML 프론트
├── src/jira-client.js       # Jira REST 래퍼
├── scripts/hola/            # holaworld.io 자동 모집 글 게시
│   ├── login.js             # 1회성 OAuth 로그인 → state.json
│   ├── ping.js              # 2시간마다 세션 갱신 (Chromium 불필요)
│   ├── post.js              # 폼 자동 작성 + 등록
│   ├── config.js            # post A (BE/FE 모집)
│   ├── config-b.js          # post B (PM/디자이너 모집)
│   ├── upload-state.sh      # state.json 을 GitHub secret 으로 업로드
│   └── README.md            # holaworld 셋업 상세
├── .github/workflows/
│   ├── hola-ping.yml        # 2시간마다 세션 핑
│   ├── hola-post-a.yml      # 홀수일 10시 KST A 글 게시
│   └── hola-post-b.yml      # 짝수일 10시 KST B 글 게시
├── database/schema.sql      # 참고용 덤프 (런타임 사용 X)
└── attached_assets/         # 설계 시 받은 자산
```

## 5. 로컬 개발

```bash
# DB는 로컬 postgres 의 daeng_local 사용 (USER@localhost:5432)
DATABASE_URL="postgres://USER@localhost:5432/daeng_local" node server.js
# → http://localhost:5000
```

* 코드 수정 → 서버 재시작이 필요한 건 `server.js` 변경 시에만. `public/`
  은 새로고침이면 됨.
* 검증은 `curl` + `psql` 조합으로 한다. 가짜 데이터 만들고 검증 끝나면
  반드시 `psql daeng_local -c "DELETE FROM ... WHERE user_name LIKE '%테스트%'"`
  로 정리.
* 시간은 항상 **KST** 기준. JS 에서는 `new Date(Date.now() + 9*3600*1000)`
  로 KST 시각 만든 후 `.getUTCHours()` 같이 UTC API 로 읽음.
* 작업일 모델: **07:00 → 익일 03:00 (20 시간)**. 클라/서버 모두
  `toVirtMin()` 으로 가상 분(0~1200)으로 환산해서 비교. 자정 크로싱이
  자연스럽게 처리됨.

## 6. 배포

* GitHub → Railway 자동 배포 트리거가 **죽어 있음** (조직 GitHub App
  연결이 끊긴 상태). API 로 `deploymentTriggerCreate` 시도해도
  `Resource not accessible` 받음.
* **임시 배포 방법**: `railway up -y --ci` 가 로컬 파일을 그대로 업로드
  해서 빌드 + 배포 (≈1분).
* Railway CLI 는 로그인 되어 있음 (`railway whoami` 로 확인 가능).
  프로젝트 링크: `~/.railway/config.json` 에 저장.
* 자동 배포 복구 절차: GitHub Org settings 에서 Railway App 권한 재부여 →
  Railway 대시보드에서 서비스 Settings → Source 재연결. 코드 작업
  아니라 사용자가 UI 에서 직접 해야 함.

## 7. 핵심 데이터 모델

* `team_members (name, team, archived)` — 사람. `team` 은 `기획 / 개발 /
  디자인 / 기타 / ""`. 이름은 모두 **NFC 정규화**해서 저장 (macOS 클립보드의
  NFD 와 byte-mismatch 방지). 이름 바꾸기는 PATCH 가 cascade 로
  `checkins.user_name`, `announcement_reads.user_name`, `ideas.author`,
  `memos.author`, `polls.created_by`, `votes.voter_name`, `idea_likes.user_name`
  까지 같이 갱신.
* `checkins (check_date, user_name, start_time, end_time, hours_text,
  unavailable_text, done, tasks, blockers, link_url, checked_in_at)` —
  `(check_date, user_name)` UNIQUE. `done`/`tasks` 는 **JSON 직렬화된
  `[{text, url}, ...]`** 으로 저장 (레거시 평문도 호환). `unavailable_text`
  는 `;` 구분자로 여러 범위 (`13:00-13:30 회의; 15:00-15:30 외부미팅`).
  `checked_in_at` 은 첫 본문 작성 시 KST HH:MM 으로 한 번만 기록 → start_time +
  30 분 지나면 `isLate=true` 로 표시 (UI 에선 "Delayed").
* `quick_links (id, name, url, icon_url, position)` — 히어로 오른쪽
  "자주 쓰는 도구" 6 개 시드 후 사용자가 자유 편집.
* `announcements` — 히어로의 단일 공지. `is_active=true` 인 가장 최근
  것만 표시. 누구나 수정/삭제.
* `bug_reports (id, title, description, page_url, reporter_name, status,
  decided_by, decided_at, decision_note)` — 익명 제보 허용. 누구나
  approve/reject/resolve/reopen. status 변경 시 누가 눌렀는지·언제·메모를
  기록.
* `ideas`, `idea_likes`, `polls`, `votes`, `memos`, `visits` — 레거시 잔존
  테이블. 현재 UI 직접 노출 거의 없음 (cascade 만 신경 쓰면 됨).

## 8. 자주 건드리는 흐름 / 함정

### 시간 관련

* 작업일 가상축 (`toVirtMin`) 안 거치고 raw clock 으로 비교하면 자정
  크로싱 (예: 15:00–01:30) 에서 잘못 막힘. 새 시간 비교를 추가할 땐
  반드시 가상축 사용.
* "시작 예정" 날짜는 `/register` 에서 필수 (홀라). 비워두면 "등록하기"
  버튼이 silent 하게 disabled — 폼 검증으로는 안 잡힘. `post.js` 가
  비어있으면 오늘로 자동 채움.

### 체크인

* `done`/`tasks` 가 새 형식 (배열) 이지만 응답엔 `done`/`tasks` 평문도
  같이 내려줌 (레거시 클라용). 새 코드는 **`doneItems`/`tasksItems`** 만
  쓸 것.
* URL 은 항목별 (`{text, url}`). 라벨에 `(필수)` 만 띄우고 검증은 안 함
  (사용자 결정).
* 체크인 취소·삭제는 `done=[], tasks=[], blockers=""` 로 비우는 POST.
  복원 위해 토스트의 "복원" 액션이 원본을 다시 보냄.

### 멤버 rename

* PATCH `/api/members/:name` 은 URL 파라미터를 NFC normalize 후, 전체
  `team_members` 를 fetch 해서 fuzzy match (NFC/whitespace 차이 흡수)
  로 실제 DB 키를 찾음. `rowCount=0` 이면 404 로 명시 실패.
* 새 rename 추가 시 cascade 대상 테이블이 늘어나면 PATCH 안의 UPDATE
  체인에 추가할 것.

### 주간 평일 5일 룰

* 평일 (월–금) 은 **0/5 또는 5/5** 만 허용. 1~4/5 부분 채움은 서버에서
  `WEEKDAY_REQUIRED` 로 거부. 시간만 살짝 고치는 인라인 셀 수정도
  여기에 걸릴 수 있으니 주의.

### 시작 시간 잠금

* 오늘 `start_time` 의 컷오프 (시작+30분) 가 이미 지난 상태에서 더
  늦은 시간으로 옮기는 변경은 서버에서 `START_TIME_LOCKED` 로 거부.
  체크인 지각 회피 어뷰징 방지용.

### holaworld 자동화

* `scripts/hola/state.json` 은 **gitignore** 되어 있음. GitHub Actions
  에선 `HOLA_STATE_B64` 시크릿에서 디코드해서 씀.
* `HOLA_STATE_B64` 는 매 ping/post 끝에 갱신된 쿠키로 **자동 회전**
  (GH_PAT 시크릿 있어야 함).
* 만료 알림은 `DISCORD_WEBHOOK_URL` 시크릿 등록 시에만 옴.
* 카카오 OAuth 는 stealth 적용 후 통과. 구글 OAuth 는 "안전하지 않은
  앱" 으로 막힐 수 있으니 카카오 우선.

### 모바일 / 반응형

* 768px 이하에서 weekly 보드는 `<table>` 이 멀쩡한 카드 리스트로
  CSS-only 변환됨. 데스크탑은 Gantt 타임라인이 기본.
* 모바일에선 `.day-meta` (불가/Delayed) 가 카드 안에서 그대로 보이고,
  데스크탑에선 숨김 (간트 표시로 대체).

### 팀 색상

* 4 색 팔레트: 기획=보라, 개발=파랑, 디자인=핑크, 기타=앰버, 미지정=회색.
  추가 팀명은 해시 → 4색 중 하나로 deterministic 매핑.

## 9. 최근 작업 흐름 (참조용)

다음 단위 작업들이 차례로 들어갔어요 — 새 변경이 이전 결정을 깨지 않는지
확인할 때 참고:

1. 평일 5일 모두 입력 필수 (`WEEKDAY_REQUIRED`) — 부분 채움 후 추후
   기재 방지.
2. 시작시간 + 30 분 지나면 Delayed 마킹 (체크인은 허용, 다만 표시만).
3. start_time 컷오프 후 더 늦은 시간으로 변경 금지 (`START_TIME_LOCKED`).
4. unavail 시간 다중 (`;` 구분), Gantt 에 빨간 사선으로 표시.
5. 작업일 가상축 07–03 (자정 크로싱).
6. 팀 컬럼 + 그룹 헤더 (기획/개발/디자인/기타).
7. 사용자 선택 1년 쿠키 + localStorage 양방향.
8. 멀티 아이템 한일/할일 + 각자 URL.
9. 버그 제보 큐 (익명 OK, 누가 승인했는지 기록).
10. holaworld 자동 게시 (Playwright + GitHub Actions, 2 시간 ping +
    2 일에 한 번 게시, 글 두 종 엇갈려 매일 한 건씩).

각 항목의 코드 변경은 git log 에 남아있음:

```bash
git log --oneline -25
```

## 10. 새 작업 시작할 때 체크리스트

* 사용자의 요청이 모호하면 옵션 2~3 개 + 추천 + 트레이드오프로 먼저
  설계 정렬.
* 변경 범위가 크면 `TaskCreate` 로 작업 쪼개고 단계별로 in_progress →
  completed 표기.
* `server.js` 의 새 스키마는 `initDatabase()` 에 `ALTER TABLE ADD
  COLUMN IF NOT EXISTS` 로 추가 (마이그레이션 시스템 없음).
* `pg` 쿼리에서 같은 파라미터 `$1` 을 다른 타입 컨텍스트로 두 번 쓰면
  Postgres 가 타입 추론 실패하므로 JS 에서 값 계산해서 분리 슬롯에
  넣을 것 (`bug_reports` PATCH 한 번 깨졌던 사례).
* 검증은 로컬에서 `node server.js` 띄우고 `curl` 로 행복/슬픔 경로 다
  돌려본 뒤 사용자에게 보고. 시드 데이터 정리는 동일 단계에서.
* 사용자 확인 받기 전엔 `git commit` 절대 금지.
