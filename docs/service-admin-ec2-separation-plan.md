# 서비스 백오피스 조회 API EC2 이전 작업 문서

> 상태: 코드 분리와 로컬 이미지 빌드 후 이전 버전을 EC2에 수동 배포했고, 해당 버전의 health·overview API 응답을 확인했다. 현재 토큰 인증 제거는 로컬 코드와 Compose에만 반영했다. EC2에는 토큰 검사가 포함된 이전 이미지가 계속 실행 중이며, 변경 반영을 위한 이미지 재빌드·재배포와 Railway 중계 전환은 아직 하지 않았다.

> 인증 상태: 분리된 EC2 API는 현재 요청별 인증을 적용하지 않는다. Docker 호스트 포트는 loopback에만 바인딩되어 있지만, 같은 Docker 네트워크의 컨테이너에서는 API에 접근할 수 있다. Railway와 연결할 네트워크 경로 및 그 경로의 접근 제어 방식은 전환 전에 결정해야 한다.

현재 Railway 서버는 추출한 모듈을 불러와 기존 MySQL 조회 API를 그대로 제공한다. EC2 전환 전까지 중복 SQL을 만들지 않고 기존 동작을 유지하기 위한 임시 상태다.

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

EC2 API의 실제 HTTPS 주소와 프록시 경로는 운영 설정 확인 후 확정한다. `api.knockdog.net`에서 관리자 API 경로를 Node로 라우팅하는 안을 우선 검토하지만, 현재 해당 경로가 설정돼 있다고 가정하지 않는다.

Railway에서 EC2 API를 호출하려면 먼저 HTTPS 역방향 프록시·로드 밸런서 또는 사설 연결 등 네트워크 경로가 필요하다. `SERVICE_ADMIN_API_TOKEN`은 네트워크 경로를 만들지 않고, 경로가 열린 뒤 호출자를 식별하는 공유 비밀값이다. 공개 HTTPS 경로를 사용할 경우 Node API 또는 앞단 게이트웨이에서 호출자 인증을 적용해야 한다. 인증된 사설 연결로 호출자를 제한하는 경우 Node의 공유 토큰 검사는 선택 사항이다.

## 현재 코드에서 확인한 범위

| 항목 | 위치·동작 |
| --- | --- |
| 화면 | `public/service-admin.html`. `/home`에서 제공한다. 화면은 같은 출처의 `/api/service-admin/**`을 호출한다. |
| 조회 API | `apps/daeng-admin/service-admin.js`의 `GET /api/service-admin/{health,overview,members,schools,verifications}`. MySQL에 직접 쿼리하며 변경 API는 없다. 현재 Railway `server.js`가 이 모듈을 등록한다. |
| 공통 코드 | 같은 모듈에 MySQL 풀, Basic 인증 미들웨어, DB 설정 확인, 오류 응답, 개인정보 마스킹이 있다. 기존 Railway 앱은 Basic 인증 미들웨어를 사용하고, 분리된 EC2 앱은 현재 DB 설정 확인만 적용한다. |
| EC2 API 인증 | 현재 요청별 인증은 없다. 공개 HTTPS 경로를 택한다면 Railway 중계가 `x-service-admin-token` 헤더를 보내고 EC2 앱이 `SERVICE_ADMIN_API_TOKEN`과 비교하는 방안을 적용할 수 있다. 이 방식은 아직 코드에 적용되지 않았다. |
| 설정 | `SERVICE_DB_*`, `SERVICE_ADMIN_USER/PASSWORD`를 `process.env`에서 읽는다. 이 레포에 `.env` 자동 로딩은 없다. |
| 화면 오류 | 대시보드 조회가 실패하면 더미 수치가 남는다. 실제 연동 시 오류 상태를 명확히 표시해야 한다. |

`daeng_v1_back/docker-compose.yml`에는 Spring·MySQL·Redis가 있고 MySQL 호스트 포트는 `127.0.0.1:3306`에만 바인딩돼 있다. 관리자 컨테이너가 실제로 접근할 수 있는 Docker 네트워크, EC2의 자원 사용량, 프록시 경로, 현재 Railway→MySQL 조회 성공 여부는 아직 확인하지 않았다.

## 코드와 배포 파일 배치

```text
daeng_discord/
├── server.js                      # /home 유지, 관리자 MySQL 조회 라우트는 중계로 교체
├── public/service-admin.html      # Railway에 유지
├── apps/daeng-admin/
│   ├── server.js                  # EC2용 Express 조회 API
│   ├── service-admin.js           # 공통 조회 라우터·MySQL 연결
│   ├── package.json               # express, mysql2 등 최소 의존성
│   ├── package-lock.json
│   ├── Dockerfile                 # Node 런타임 + 앱 + 의존성
│   ├── docker-compose.yml        # 관리자 컨테이너 수동 실행 설정
│   └── .dockerignore              # .env, node_modules 제외
└── .railwayignore                 # 중계 전환 후 EC2 전용 앱을 Railway 업로드에서 제외
```

- 새 앱에는 다섯 GET 응답의 필드·검색·필터·페이지네이션·마스킹을 유지한다. PostgreSQL 풀, `initDatabase()`, 팀 운영 라우트, Discord 작업, 관리자 HTML은 포함하지 않는다. 기존 `server.js` 전체를 새 앱에서 `require()`하지 않는다.
- **현재 단계에서는 `.railwayignore`를 추가하지 않는다.** Railway `server.js`가 추출한 모듈을 사용하기 때문이다. EC2로 트래픽을 전환하고 Railway의 모듈 참조를 제거한 뒤 추가한다.
- Railway의 `server.js`에는 `/home`의 Basic 인증과 `/api/service-admin/**` 중계만 남긴다. 중계는 허용된 GET 경로·쿼리 문자열만 전달하고, 응답 상태·본문·시간 초과·upstream 오류를 처리한다.
- **공개 HTTPS 경로를 택할 경우의 서비스 간 인증 방안(미구현):** 브라우저의 Basic `Authorization` 헤더를 EC2로 그대로 전달하지 않는다. Railway 중계가 `x-service-admin-token` 헤더에 별도 토큰을 넣고 EC2 앱이 `SERVICE_ADMIN_API_TOKEN`과 비교한다. 두 환경의 값은 Railway Variables와 Infisical `prod`에 각각 설정한다. 공개 경로를 열기 전에 토큰 검사 또는 동등한 게이트웨이 인증을 구현한다. 인증된 사설 경로로 Railway만 접근하게 할 경우에는 해당 경로의 접근 제어를 검증한다. 인증 우회 플래그는 새 앱에 복사하지 않는다.
- 기존 Basic 인증은 이번 조회 이전 동안만 유지한다. 향후 개인별 Google 로그인·권한 요구사항을 Basic 인증이나 공유 서비스 토큰으로 충족했다고 간주하지 않는다.

## EC2 실행·시크릿

1. EC2의 CPU 아키텍처, 메모리 여유, 기존 MySQL 컨테이너의 Docker 네트워크, HTTPS 프록시 설정을 확인한다. `daeng_v1_back`의 Compose 파일을 수정하는 것은 이번 수동 배포의 전제가 아니다.
2. `apps/daeng-admin/`만 빌드 컨텍스트로 사용한다. EC2 아키텍처에 맞게 빌드한 이미지를 ECR의 `daeng-admin` 저장소에 고정 태그로 올린다. EC2에서 ECR 인증 후 해당 이미지를 내려받고, 전체 이미지 URI와 태그를 `DAENG_ADMIN_IMAGE`에 지정한다. 현재 로컬에만 있는 이미지 태그는 EC2에서 바로 사용할 수 없다.
3. 관리자 컨테이너는 이 저장소의 `apps/daeng-admin/docker-compose.yml`을 EC2의 백엔드 Compose와 **다른 디렉터리**에 두고 별도 `daeng-admin` 프로젝트로 수동 실행한다. 기존 `/home/ec2-user/docker-compose.yml`을 덮어쓰지 않는다. Compose는 이미지를 실행하고 호출한 셸의 환경변수를 전달하며 Infisical 시크릿을 직접 가져오지는 않는다. EC2에서 `docker inspect mysql`로 MySQL 컨테이너가 속한 Docker 네트워크 이름을 확인해 `SERVICE_DB_DOCKER_NETWORK`에 지정한다. 관리자 Compose는 그 기존 네트워크를 `external`로 사용한다. `SERVICE_DB_HOST`·`SERVICE_DB_NAME` 등 접속 대상은 환경변수로 지정하며, 현재 백엔드 Compose 기준 값은 `mysql`·`knockdog`다. `daeng_v1_back` Compose는 수정하지 않는다. Node HTTP 포트는 EC2 호스트의 loopback에만 바인딩하고 외부 HTTPS 프록시로 접근한다. 개발자용 SSM DB 터널이나 MySQL 공인 포트는 사용하지 않는다.
4. 관리자 컨테이너 전용 **읽기 권한 DB 계정**을 준비한다. 필요한 테이블에만 권한을 부여하고 Spring DB 계정이나 MySQL 관리자 계정을 공유하지 않는다.
5. DB 사용자·비밀번호는 Infisical `prod`를 원본으로 관리한다. 수동 배포 시 EC2의 Infisical CLI 인증·프로젝트 접근을 먼저 준비하고 `infisical run --env=prod -- docker-compose ... up -d` 형태로 Compose 실행 프로세스에 값을 전달한다. EC2에 Infisical CLI와 인증이 이미 있는지는 확인하지 않았다. 비밀번호를 이미지·Compose 파일·레포에 넣지 않는다. 공유 토큰 방식을 선택한 경우에만 해당 값을 추가한다.
6. Railway에는 선택한 EC2 API 접속 주소를 설정한다. 공유 토큰 방식을 선택한 경우 토큰은 Railway Variables와 Infisical `prod`에서 관리한다. 전환 후 Railway의 `SERVICE_DB_*`와 `mysql2`를 제거한다. 실제 시크릿 값은 로그·오류 응답에 남기지 않는다.

**기존 배포와의 관계:** `daeng_v1_back/scripts/deploy-remote.sh`는 배포 때 `docker-compose down`을 실행한다. 관리자 컨테이너를 별도로 실행하면 Spring 배포 과정에서 MySQL이 재시작되는 동안 관리자 API의 DB 요청은 일시적으로 실패할 수 있다. 관리자 컨테이너가 연결할 기존 Docker 네트워크가 재생성되는지도 EC2에서 확인해야 한다. 관리자 실행 정의와 이미지 태그는 이 저장소의 배포 문서로 관리한다.

## 구현·전환 순서

1. **사전 확인:** EC2 자원·프록시·기존 Docker 네트워크·Railway의 기존 조회 성공 여부를 확인한다. 읽기 권한 DB 계정을 준비한다.
2. **API 추출:** 다섯 GET API와 공통 코드를 독립 앱으로 옮긴다. 필수 DB 설정이 없으면 정상 기동으로 표시하지 않는다. Railway 중계 전 네트워크 경로와 해당 경로의 접근 제어 방식을 확정한다.
3. **EC2 수동 배포:** ECR에서 관리자 이미지를 받아 `DAENG_ADMIN_IMAGE`와 기존 MySQL 네트워크 이름을 지정한다. Infisical CLI로 관리자 시크릿을 주입해 관리자 Compose만 수동 실행한다. EC2 내부 DB 연결과 API 응답을 확인한 뒤 HTTPS 프록시 경로를 연결한다.
4. **Railway 중계:** 기존 MySQL 조회 라우트를 upstream 중계로 교체한다. `/home`과 화면의 API 경로를 유지한다. API 실패 시 더미 대시보드가 정상 데이터처럼 보이지 않도록 수정한다.
5. **전환 후 정리:** Railway에서 더 이상 사용하지 않는 `SERVICE_DB_*`와 `mysql2`를 제거한다. 사용 중인 이미지 태그와 수동 배포·복구 절차를 기록한다.

## 확인 항목과 복구

- 기존 Basic 인증이 `/home`·Railway API 요청에 유지되는지 확인한다. EC2 API를 공개 HTTPS 경로로 연결한다면 무인증 요청이 Node 또는 앞단 게이트웨이에서 거부되는지 확인한다. 사설 경로라면 허용된 호출자만 접근할 수 있는지 확인한다.
- 다섯 GET API의 응답 필드, 검색·필터·페이지네이션, 개인정보 마스킹, 빈 목록, DB 연결 실패를 확인한다.
- Railway 화면에서 실제 데이터가 표시되는지, API 실패 시 더미 수치가 실제 데이터처럼 남지 않는지 확인한다.
- Spring 배포 이후에도 관리자 컨테이너의 DB 연결·이미지 태그·환경변수·프록시 경로가 유지되는지 확인한다.
- 장애 시 우선 EC2 관리자 이미지를 이전 고정 태그로 되돌린다. Railway의 이전 MySQL 직접 연결은 **실제로 동작했음이 확인된 경우에만** 복구 경로로 사용한다.

## 완료 기준

- 기존 `/home` 화면과 조회 API 응답을 유지하면서 MySQL 쿼리는 EC2 관리자 Node 컨테이너에서만 실행한다.
- Railway는 관리자 DB 자격 증명을 보유하지 않고, MySQL 포트는 외부에 공개하지 않는다.
- 관리자 컨테이너는 전용 읽기 권한으로 DB에 접근하며, 외부 요청은 HTTPS·인증을 거친다.
- 사용 중인 이미지 태그와 복구 절차가 기록돼 있고, 기존 체크인 기능과 Railway PostgreSQL에 영향이 없다.
