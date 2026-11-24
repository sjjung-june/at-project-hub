# 기본 개발 대상: FastAPI

독립 실행과 신규 개발은 [backend/README.md](../backend/README.md)를 참고하세요. 아래는 이전 Node.js 프레임의 실행 설명입니다.

# PostgreSQL 기본 프레임

현재 배포 사이트는 브라우저 저장 시연입니다. 이 프레임은 별도의 Node.js API 서버와 PostgreSQL을 사내 환경에 설치할 수 있도록 제공합니다. 배포 사이트에 운영 DB가 자동 연결되거나 브라우저 데이터가 자동 업로드되지 않습니다.

## 로컬 실행

Node.js 22 이상과 Docker가 필요합니다.

1. `.env.example`을 `.env`로 복사합니다.
2. `POSTGRES_PASSWORD`와 `DATABASE_URL`의 비밀번호를 같은 값으로 바꿉니다. URL의 특수문자는 URL 인코딩합니다.
3. 다음을 실행합니다.

```sh
npm ci
docker compose up -d postgres
npm run db:migrate
npm run api:dev
```

API는 `http://127.0.0.1:3001/api`에서 동작합니다. 상태 확인은 `/api/health`입니다. Docker 볼륨에 DB 데이터를 유지합니다. `docker compose down`은 볼륨을 유지합니다.

`DEV_AUTH=true`는 루프백에서만 실행하는 개발용 고정 사용자입니다. 요청 헤더나 본문에서 역할을 받지 않습니다. 운영에서는 `createApp({ pool, authenticate })`에 사내 SSO 세션을 검증하는 어댑터를 주입해야 합니다. 기본 실행기는 운영 모드 또는 개발 인증 미설정 시 실행을 중단합니다.

## 구성과 데이터

- `server/db.mjs`: pg 연결 풀, 동일 연결에서 실행하는 트랜잭션.
- `server/migrations/001_initial.sql`: 과제, 승인 요청, 추가만 가능한 감사 이력.
- `server/migrate.mjs`: 파일 순서대로 1회 실행하고 동시 마이그레이션을 직렬화.
- `server/project-service.mjs`: 등록, 실적, 승인 요청/처리, 충돌 검사.
- `server/app.mjs`: 인증 어댑터를 주입하는 HTTP API.
- `src/api-client.js`: 화면의 저장 코드를 비동기 API 호출로 바꿀 때 사용하는 클라이언트. 현재 화면에서는 호출하지 않습니다.

초기 모델은 `projects.document` JSONB에 Step 계획·실적·기존 보존 기록을 함께 둡니다. 검색용 id/title/team/revision은 별도 열, 승인 요청과 감사 이력은 별도 테이블로 투영합니다. Step·월별 값을 정규화한 개별 테이블 구조는 아직 적용하지 않았습니다. 감사 이력의 UPDATE/DELETE는 트리거로 차단하지만 DB 소유자의 관리 권한까지 제한하는 체계는 아닙니다.

## API

모든 업무 API는 인증된 사용자가 필요합니다. 전체 목록 조회는 조직 내 인증 사용자 기준이며, 향후 부서별 조회 범위가 필요하면 서비스에 정책을 추가해야 합니다. 편집은 생성자·서버 등록 참여자·소속 팀장·AT 담당장·관리자에 허용합니다. 승인 처리는 기존 ApprovalModel의 검토 역할·자기 승인 제한을 적용합니다. 관리자가 승인 권한을 자동으로 갖지는 않습니다. 역할과 참여자 ID는 서버에서 관리해야 하며, 조직도/SSO 매핑·참여자 지정 API는 후속 연결 지점입니다.

| Method | 경로 | 용도 |
|---|---|---|
| GET | `/api/projects` | 최근 과제 최대 500건 |
| POST | `/api/projects` | 과제 등록, 서버 UUID·계획 상태·소유자 지정 |
| GET | `/api/projects/:id` | 과제와 `_revision`, ETag 조회 |
| PUT | `/api/projects/:id/reports` | Step별 또는 전체 실적 저장 |
| POST | `/api/projects/:id/change-requests` | `{candidate, reason}` 변경 승인 요청 |
| POST | `/api/projects/:id/change-requests/:requestId/decisions` | `{decision, comment}` 승인·반려·철회 |
| GET | `/api/projects/:id/history` | 감사 이력 메타데이터 |

수정 요청은 `If-Match: "3"`처럼 현재 `_revision`을 포함해야 합니다. 버전이 다르면 409를 반환합니다. 저장·승인 투영·감사 이벤트는 한 트랜잭션에서 처리합니다. 승인 시 요청 후 추가된 최신 실적을 유지합니다. 감사 테이블의 before/after에 상세 상태를 보존하며 현재 이력 API는 메타데이터만 반환합니다.

Step 실적 본문 예시:

```json
{"stepReports":{"step-id":{"2026-11":{"actual":100,"reason":"","catchup":""}}}}
```

**API 저장 단위**는 기존 호환성을 위해 Step 자체의 완료 비율 0~100입니다. **화면 입력 단위**는 전체 과제 기여도 0~Step 비중입니다. 비중 40%인 Step에 화면에서 20%를 입력하면 `normalizedContribution(20,40)=50`을 API에 전달합니다. 표시할 때는 `contribution(50,40)=20`으로 환산합니다. 전체 합계에 비중을 두 번 적용하지 않습니다. 월별 목표도 같은 내부 단위를 사용합니다.

기존 브라우저 데이터 일괄 가져오기, 실제 SSO, 사내 메신저 발송, 운영 DB 호스팅/백업은 이 기본 프레임에 포함되지 않습니다. 현재의 동기식 브라우저 저장 함수를 API 클라이언트의 비동기 명령으로 바꾸고, 같은 도메인의 `/api`에 역방향 프록시를 연결해야 합니다. 기본 API는 CORS를 열지 않습니다.

## 검증

```sh
# 테스트 전용 DB를 지정합니다. 실제 업무 DB를 사용하지 마세요.
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/test_database npm run test:db
```

테스트는 별도 임시 스키마를 생성·제거합니다. 마이그레이션 재실행, 인증, 편집 권한, 동시 수정 충돌, 승인 중 최신 실적 보존, 트랜잭션 원복, 감사 이력 변경 차단을 실제 PostgreSQL에서 확인합니다. GitHub Actions는 PostgreSQL 17 서비스로 이 테스트를 실행합니다.

설계 참고: [node-postgres 트랜잭션](https://node-postgres.com/features/transactions), [매개변수 쿼리](https://node-postgres.com/features/queries), [PostgreSQL 행 잠금](https://www.postgresql.org/docs/current/explicit-locking.html).
