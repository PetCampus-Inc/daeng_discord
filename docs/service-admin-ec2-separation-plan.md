# 서비스 백오피스 조회 API EC2 이전 작업 문서

> 상태: `daeng-admin:20261011` 이미지를 EC2에 수동 배포했다. EC2 내부와 `https://api.knockdog.net/api/service-admin/`의 health·overview 응답은 HTTP 200으로 확인했다. Railway 중계 코드는 작성했으며 **Railway 배포와 관리자 화면의 실제 동작 확인은 아직 하지 않았다.**

> 인증 상태: EC2 Node API에는 현재 요청별 인증이 없다. Nginx가 관리자 API 경로를 외부 HTTPS로 공개하고 있으므로 URL을 아는 호출자는 Railway를 거치지 않고도 접근할 수 있다. 운영자 로그인·권한 검사는 후속 작업이다.

현재 배포 중인 Railway 서버는 추출한 모듈로 MySQL 조회를 직접 수행한다. 이번 로컬 변경은 이 경로를 EC2 HTTPS 중계로 교체하며, Railway에 배포하기 전까지 운영 동작은 바뀌지 않는다.

## 이번 작업의 결정

- 관리자 화면(`public/service-admin.html`)과 `/home`은 현재 레포의 Railway 서비스에 둔다.
- 현재 `server.js`의 **조회 API 5개와 MySQL 접속 코드만** 별도 Express 앱으로 분리해 MySQL이 있는 EC2의 Docker에서 실행한다.
- 브라우저의 기존 `/api/service-admin/**` 요청은 Railway Express가 EC2 API로 중계한다. 화면의 상대 경로와 기존 Basic 인증은 우선 유지한다. 따라서 이 레포는 백오피스 화면뿐 아니라 **얇은 API 중계**도 담당한다.
- 이번 작업은 기존 조회 기능 연결에 한정한다. Google 로그인, 운영자 계정·권한, 승인, 공지·약관 변경, 감사 이력 등 향후 기능을 Node와 Spring 중 어디에 구현할지는 별도 결정이 필요하다. Node를 영구적인 업무 백엔드로 채택한 것은 아니다.

```text
브라우저
  └─ Railway: /home 및 /api/service-admin/**
       └─ Express: 기존 Basic 인증 + 조회 요청 중계
            └─ HTTPS: EC2의 관리자 Node API
                 └─ EC2의 MySQL (연결 경로는 현장 확인 후 결정)

기존 팀 일정·체크인 ── Railway Express ── Railway PostgreSQL
기존 앱 API ───────── daeng_v1_back Spring ── 같은 MySQL·Redis
```

EC2 Nginx는 `api.knockdog.net/api/service-admin/` 요청을 Node 컨테이너의 `127.0.0.1:3001`로 전달한다. Railway 중계는 기본값으로 이 HTTPS 주소를 사용하며, 필요하면 `SERVICE_ADMIN_API_ORIGIN`으로 출처를 바꿀 수 있다.

`SERVICE_ADMIN_API_TOKEN`은 현재 코드와 EC2 Compose에서 사용하지 않는다. 공유 토큰은 호출 서버만 식별할 수 있고 운영자별 권한을 대신하지 못한다. 후속 로그인 작업에서는 EC2 API 자체가 운영자 세션과 권한을 요청마다 확인하도록 설계한다.

## 현재 코드에서 확인한 범위

| 항목 | 위치·동작 |
| --- | --- |
| 화면 | `public/service-admin.html`. `/home`에서 제공한다. 화면은 같은 출처의 `/api/service-admin/**`을 호출한다. |
| 조회 API | `apps/daeng-admin/service-admin.js`의 `GET /api/service-admin/{health,overview,members,schools,verifications}`. MySQL에 직접 쿼리하며 변경 API는 없다. Railway는 이 모듈을 더 이상 불러오지 않는다. |
| Railway 인증·중계 | `src/service-admin-auth.js`가 기존 Basic 인증을 담당한다. `src/service-admin-proxy.js`는 다섯 GET 경로와 쿼리 문자열만 EC2로 보내며 Basic 인증 헤더는 전달하지 않는다. |
| EC2 API 인증 | 현재 요청별 인증은 없다. Railway의 Basic 인증이 EC2 공개 주소에 직접 들어오는 요청까지 보호하지는 않는다. |
| 설정 | EC2는 `SERVICE_DB_*`, Railway는 `SERVICE_ADMIN_USER/PASSWORD`와 선택적 `SERVICE_ADMIN_API_ORIGIN`을 읽는다. 이 레포에 `.env` 자동 로딩은 없다. |
| 화면 오류 | API 실패 시 더미 수치를 지우고 조회 실패 상태를 표시한다. |

관리자 컨테이너는 EC2의 기존 `ec2-user_default` Docker 네트워크에서 `mysql:3306`에 접속한다. MySQL 호스트 포트는 `127.0.0.1:3306`에만 바인딩돼 있다.

## 코드와 배포 파일 배치

```text
daeng_discord/
├── .railwayignore                # EC2 전용 앱의 Railway CLI 업로드 제외
├── server.js                      # /home 유지, 관리자 MySQL 조회 라우트는 중계로 교체
├── public/service-admin.html      # Railway에 유지
├── src/service-admin-auth.js       # Railway의 기존 Basic 인증
├── src/service-admin-proxy.js      # Railway의 EC2 조회 API 중계
├── apps/daeng-admin/
│   ├── server.js                  # EC2용 Express 조회 API
│   ├── service-admin.js           # EC2 조회 라우터·MySQL 연결
│   ├── package.json               # express, mysql2 등 최소 의존성
│   ├── package-lock.json
│   ├── Dockerfile                 # Node 런타임 + 앱 + 의존성
│   ├── docker-compose.yml        # 관리자 컨테이너 수동 실행 설정
│   └── .dockerignore              # .env, node_modules 제외
└── docs/service-admin-ec2-separation-plan.md
```

- 새 앱에는 다섯 GET 응답의 필드·검색·필터·페이지네이션·마스킹을 유지한다. PostgreSQL 풀, `initDatabase()`, 팀 운영 라우트, Discord 작업, 관리자 HTML은 포함하지 않는다. 기존 `server.js` 전체를 새 앱에서 `require()`하지 않는다.
- Railway 런타임은 EC2 전용 모듈을 불러오지 않는다. 루트 `.railwayignore`가 `apps/daeng-admin/`을 `railway up` 업로드에서 제외한다.
- Railway의 `server.js`에는 `/home`의 Basic 인증과 `/api/service-admin/**` 중계만 남긴다. 중계는 허용된 GET 경로·쿼리 문자열만 전달하고, 응답 상태·본문·시간 초과·upstream 오류를 처리한다. 브라우저의 Basic `Authorization` 헤더는 EC2로 전달하지 않는다.
- EC2 공개 API의 요청별 인증은 아직 없다. 운영자별 세션·권한 검사를 추가할 때까지 이 경로로 조회 데이터가 노출될 수 있다. Railway Basic 인증만으로 EC2 주소에 직접 들어오는 요청을 막을 수 없다.
- 기존 Basic 인증은 이번 조회 이전 동안만 유지한다. 향후 개인별 Google 로그인·권한 요구사항을 Basic 인증이나 공유 서비스 토큰으로 충족했다고 간주하지 않는다.

## EC2 실행·시크릿

1. EC2의 CPU 아키텍처, 메모리 여유, 기존 MySQL 컨테이너의 Docker 네트워크, HTTPS 프록시 설정을 확인한다. `daeng_v1_back`의 Compose 파일을 수정하는 것은 이번 수동 배포의 전제가 아니다.
2. `apps/daeng-admin/`만 빌드 컨텍스트로 사용한다. 현재 이미지는 `linux/amd64`의 `daeng-admin:20261011`이다. 로컬 Docker 이미지를 `docker save | gzip`으로 비공개 S3 배포 버킷에 올리고, EC2에서는 짧은 수명의 사전 서명 URL로 받아 `docker load`했다. EC2의 AWS 자격 증명으로 S3 객체를 직접 읽는 요청은 403이었다.
3. 관리자 컨테이너는 `/home/ec2-user/daeng-admin/docker-compose.yml`의 별도 `daeng-admin` 프로젝트에서 실행한다. 기존 Spring Compose는 수정하지 않는다. Compose의 외부 네트워크는 EC2의 `ec2-user_default`, MySQL 접속 대상은 `mysql:3306/knockdog`다. Node HTTP 포트는 EC2 호스트의 `127.0.0.1:3001`에만 바인딩하고 Nginx가 HTTPS 경로를 중계한다.
4. 현재 관리자 컨테이너는 Infisical의 `SPRING_DATASOURCE_USERNAME/PASSWORD`를 재사용한다. 필요한 테이블에만 SELECT 권한을 갖는 전용 계정으로 교체하는 작업이 남아 있다.
5. DB 사용자·비밀번호는 EC2에서 `infisical run --env=prod --path=/ -- docker-compose up -d --force-recreate`로 전달한다. EC2에는 Infisical CLI 인증이 준비돼 있다. 비밀번호를 이미지·Compose 파일·레포에 넣지 않는다.
6. Railway 중계는 기본적으로 `https://api.knockdog.net`을 사용한다. 다른 환경에서는 `SERVICE_ADMIN_API_ORIGIN`으로 출처를 지정할 수 있다. Railway 런타임에서 MySQL 직접 연결 코드와 `mysql2` 의존성을 제거했다. Railway 변수의 불필요한 `SERVICE_DB_*`는 배포 후 정리한다.

**기존 배포와의 관계:** `daeng_v1_back/scripts/deploy-remote.sh`는 배포 때 `docker-compose down`을 실행한다. 관리자 컨테이너를 별도로 실행하면 Spring 배포 과정에서 MySQL이 재시작되는 동안 관리자 API의 DB 요청은 일시적으로 실패할 수 있다. 관리자 컨테이너가 연결할 기존 Docker 네트워크가 재생성되는지도 EC2에서 확인해야 한다. 관리자 실행 정의와 이미지 태그는 이 저장소의 배포 문서로 관리한다.

## 구현·전환 순서

1. **완료 — API 분리·EC2 배포:** 다섯 GET API를 독립 앱으로 옮기고 S3 아카이브로 EC2 Docker에 적재했다. Infisical로 DB 접속값을 주입해 Compose를 실행했다.
2. **완료 — 외부 HTTPS 경로:** Nginx를 통해 health·overview가 외부에서 HTTP 200을 반환하는 것을 확인했다.
3. **로컬 코드 완료 — Railway 중계:** 기존 MySQL 조회 라우트를 EC2 중계로 교체하고 화면의 API 경로를 유지했다. API 실패 시 더미 수치가 남지 않게 수정했다. **Railway 배포는 아직 하지 않았다.**
4. **배포 후 확인:** Railway 화면의 조회 결과, 다섯 API, 체크인 기능을 확인하고 더 이상 사용하지 않는 Railway `SERVICE_DB_*` 변수를 정리한다.
5. **후속 보안 작업:** EC2 API에 운영자별 로그인·권한 검사를 추가하고, DB 계정을 전용 읽기 권한으로 분리한다.

## 확인 항목과 복구

- 기존 Basic 인증이 `/home`·Railway API 요청에 유지되는지 확인한다. EC2 공개 API에는 현재 인증이 없으므로 운영자 권한 검사를 추가하기 전까지 직접 호출도 가능하다.
- 다섯 GET API의 응답 필드, 검색·필터·페이지네이션, 개인정보 마스킹, 빈 목록, DB 연결 실패를 확인한다.
- Railway 화면에서 실제 데이터가 표시되는지, API 실패 시 더미 수치가 실제 데이터처럼 남지 않는지 확인한다.
- Spring 배포 이후에도 관리자 컨테이너의 DB 연결·이미지 태그·환경변수·프록시 경로가 유지되는지 확인한다.
- 장애 시 우선 EC2 관리자 이미지를 이전 고정 태그로 되돌린다. Railway의 이전 MySQL 직접 연결은 **실제로 동작했음이 확인된 경우에만** 복구 경로로 사용한다.

## 완료 기준

- 기존 `/home` 화면과 조회 API 응답을 유지하면서 MySQL 쿼리는 EC2 관리자 Node 컨테이너에서만 실행한다.
- Railway는 관리자 DB 자격 증명을 보유하지 않고, MySQL 포트는 외부에 공개하지 않는다.
- 관리자 컨테이너는 향후 전용 읽기 권한 DB 계정과 운영자별 요청 인증을 적용한다. 현재는 HTTPS만 적용돼 있다.
- 사용 중인 이미지 태그와 복구 절차가 기록돼 있고, 기존 체크인 기능과 Railway PostgreSQL에 영향이 없다.
