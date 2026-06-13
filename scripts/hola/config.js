// Edit this with the post content you want to publish.
// All combobox values must match holaworld's option text EXACTLY (확인된 옵션 목록은 아래 주석 참고).

module.exports = {
  // 모집 구분 — 옵션: 프로젝트 | 스터디
  type: "프로젝트",

  // 모집 인원 — 옵션: 인원 미정 | 1명 | 2명 | … | 10명 이상
  recruitCount: "4명",

  // 진행 방식 — 옵션: 온라인 | 오프라인 | 온/오프라인  (※ "전체"는 등록용 아님)
  mode: "온/오프라인",

  // 진행 기간 — 옵션: 기간 미정 | 1개월 | 2개월 | 3개월 | 4개월 | 5개월 | 6개월 | 장기
  period: "6개월",

  // 시작 예정 (YYYY-MM-DD). 비워두면 오늘 날짜 그대로.
  startDate: "",

  // 기술 스택 (멀티). 사이트 옵션 텍스트 그대로(점 없음 주의):
  // JavaScript, TypeScript, React, Vue, Nodejs, Spring, Java, Nextjs, Nestjs, Express,
  // Go, C, Python, Django, Swift, Kotlin, MySQL, MongoDB, php, GraphQL, Firebase,
  // ReactNative, Unity, Flutter, AWS, Kubernetes, Docker, Git, Figma, Zeplin, Jest, Svelte
  skills: ["React", "Java", "Spring"],

  // 모집 포지션 (멀티). 옵션: 프론트엔드, 백엔드, 디자이너, IOS, 안드로이드, 데브옵스, PM, 기획자, 마케터
  positions: ["프론트엔드", "백엔드"],

  // 연락 방법 — 옵션: 오픈톡 | 이메일 | 구글 폼
  contactType: "구글 폼",
  contactValue: "https://home.knockdog.net/careers/index.html",

  // 제목
  title:
    "🐶[🚨급) BE 1명/ FE 1명 급 추가 충원!!! (~6/17) ⚡] [실제 유저 사용 중] 7년 차 빅테크 BE 개발자와 함께 하는 '반려련 플랫폼 사이드 프로젝트' 충원",

  // 본문 (Quill 에디터). Obsidian 의 ~/Documents/Obsidian Vault/내용.md 기반,
  // 마크다운 헤딩(##/###) 과 링크 문법 [text](url) 은 평문으로 정리.
  body: `🐶 반려견 플랫폼 사이드프로젝트 팀원 모집

⚡ 인원이 거의 다 픽스되어 킥오프 직전입니다.

기획 아이데이션 중 추가 기능이 생각보다 많아 FE, BE 1명씩 더 추가 충원합니다. ((기한 연장)) ⚡

기존 인원의 취업 및 역할 확장으로 인해 새로운 팀원을 충원합니다.

(토스증권, 네이버파이낸셜, 번개장터, IM뱅크, Series A~C 스타트업 다수 이직 및 취업)

⚡ 빠르게 마감될 수 있습니다.

> 많은 트래픽은 아직 아니지만 꾸준히 사용자가 증가하고 있습니다. 전월대비 55% 상승 📈

> 놀랍게도 마케팅 전혀 없는데 트래픽이 증가하는 기이한 상황 마케팅까지 한다면..?

━━━━━━━━━━━━━━━━━━━━━━━━

🎯 모집 포지션

[개발]

- FE 개발자

- BE 개발자

[기획 / 디자인]

- PM 1명

- UX/UI 디자이너 1명

- FE / BE / PM / UXUI 기존 메인 멤버 존재

- 인수인계 및 협업 구조 안정화

- User Side 중심 서비스 고도화 + 확장 목적

━━━━━━━━━━━━━━━━━━━━━━━━

📍 About Me

안녕하세요. 현재 네카라쿠배 중 한 곳에서 백엔드 개발자로 재직 중인 7년차 개발자입니다.

또한 교육기관 멘토 및 강사 활동도 3년째 진행 중입니다.

크몽 2024 올해의 멘토

→ https://kmong.com/gig/474656

━━━━━━━━━━━━━━━━━━━━━━━━

🎉 합류 시 기대할 수 있는 경험

- 실제 운영 중인 B2C 서비스 경험

- 대규모 리팩토링 및 기술부채 개선

- 사용자 중심 서비스 기획 / 개발 / 디자인 협업

- 모의면접 및 이력서 첨삭 지원

━━━━━━━━━━━━━━━━━━━━━━━━

📍 프로젝트 배경

교육기관 및 현업 멘토 네트워크를 기반으로 실전형 사이드프로젝트를 운영 중입니다.

[현재 진행 상황]

- MVP Version 1, 2 개발 완료

- 테스트 앱 출시 완료

- Android / iOS 스토어 심사 진행 중

[현재 목표]

🚀 Version 3 고도화

기존 Version 1, 2에서 기술부채로 남겨두었던 부분들을 재정비하고,

실제 서비스 운영 수준까지 고도화하는 단계입니다.

━━━━━━━━━━━━━━━━━━━━━━━━

📍 프로젝트 개요

서비스 분야　🐶 반려견 관련 플랫폼

상세 정보　https://home.knockdog.net/

[특징]

- B2C 기반 User Side 중심

- Admin은 별도 팀 운영

- 실제 서비스 운영 목적

━━━━━━━━━━━━━━━━━━━━━━━━

📍 프로젝트 기간 및 진행 방식

기간　3~6개월

[방식]

- 주 1회 오프라인 미팅 (왕십리 인근)

- 스터디룸 비용 외 추가 비용 없음

- 실제 서비스 운영 관점 중심 진행

━━━━━━━━━━━━━━━━━━━━━━━━

📍 기술 스택

[FE]

React　·　TypeScript　·　Tanstack Query v5

Recoil　·　Styled Components　·　React Hook Form

[BE]

Java (Kotlin 리팩토링 예정)

Spring Boot　·　Spring Security　·　JPA

AWS　·　Hexagonal Architecture

[PM]

PRD　·　사용자 흐름 설계　·　서비스 기획

[UX/UI]

UX 설계　·　UI 디자인　·　프로토타이핑

━━━━━━━━━━━━━━━━━━━━━━━━

📍 지원 자격

- 오프라인 참여 가능하신 분

- 단순 경험 목적이 아닌 실제 운영 / 고도화에 관심 있으신 분

- 협업을 즐기시는 분

━━━━━━━━━━━━━━━━━━━━━━━━

📍 현재 팀 구성

- 기획 1명

- UI/UX 2명

- FE 2명

- BE 2명

- 기타 협업 인원 다수

━━━━━━━━━━━━━━━━━━━━━━━━

📍 지원 방법

[구글폼 지원]

https://forms.gle/mZWXdj6ZjzH2kisv6

[커리어 페이지 지원] 👍 추천

https://home.knockdog.net/careers/index.html

※ 커리어 페이지 지원 시 보다 빠른 검토 및 답변이 가능합니다.

━━━━━━━━━━━━━━━━━━━━━━━━

📍 참고사항

- 충원 완료 시 마감

- 지원 시 프로젝트 상세 설명 제공

함께 실제 서비스를 성장시키며, 운영 / 개선 / 확장까지

경험하고 싶은 분들의 많은 관심 부탁드립니다. 🙌`,

  // 자동화 옵션
  dryRun: process.env.HOLA_DRY_RUN === "1",
};
