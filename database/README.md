# Database Backup

PostgreSQL 스키마 및 데이터 백업 파일입니다.

## 파일 구성

- `schema.sql` - 테이블 구조 정의 (CREATE TABLE 등)
- `data.sql` - 실제 데이터 (INSERT 문)

## 복원 방법

```bash
# 스키마 먼저 복원
psql $DATABASE_URL -f database/schema.sql

# 데이터 복원
psql $DATABASE_URL -f database/data.sql
```

## 백업 방법 (수동 업데이트 시)

```bash
pg_dump $DATABASE_URL --schema-only --no-owner --no-privileges --no-comments > database/schema.sql
pg_dump $DATABASE_URL --data-only --inserts --no-owner --no-privileges --no-comments --exclude-table=visits > database/data.sql

# Replit 내부 토큰 제거
sed -i '/\\restrict/d' database/schema.sql database/data.sql
sed -i '/\\unrestrict/d' database/schema.sql database/data.sql
```

## 테이블 목록

| 테이블 | 설명 |
|--------|------|
| `announcements` | 공지사항 |
| `announcement_reads` | 공지사항 읽음 확인 |
| `memos` | 주간 포스트잇 메모 |
| `polls` | 투표 |
| `votes` | 투표 결과 |
| `ideas` | 마케팅 아이디어 |
| `idea_likes` | 아이디어 좋아요 |

> `visits` 테이블(방문자 기록)은 용량이 크고 중요도가 낮아 백업에서 제외했습니다.
