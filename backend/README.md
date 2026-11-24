# AT Project Hub FastAPI backend

프런트엔드와 독립적으로 실행·개발하는 Python 3.12+ 백엔드입니다. Node.js나 `dist/` 파일을 실행 시 참조하지 않습니다. PostgreSQL 17과 기존 JSONB 스키마를 사용하며 기존 API 주소·본문·ETag 형식을 유지합니다.

## HCP 이전

사내 Docker·Jenkins 템플릿으로 이관할 때는 [HCP 마이그레이션 인수인계 노트](HCP_MIGRATION_NOTES.md)를 확인합니다. 현재 실행 계약, 템플릿 확인 항목, Secret/SSO/DB 설정, Jenkins 단계, 롤백, 프런트엔드 연결과 데이터 이전의 남은 작업을 정리했습니다.

## 로컬 실행

이 `backend/` 폴더로 이동합니다.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.lock
cp .env.example .env
```

`.env`의 DB 비밀번호와 DATABASE_URL을 같은 값으로 설정합니다. Windows에서는 `.venv\Scripts\activate`로 가상환경을 활성화합니다.

```sh
# PostgreSQL만 컨테이너로 실행
docker compose up -d postgres
# SQL 마이그레이션, 이어서 별도 FastAPI 프로세스
python -m app.db
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

또는 `docker compose up --build -d`로 DB → 마이그레이션 → FastAPI를 함께 시작합니다. 비밀번호에 URL 예약 문자가 있다면 Docker 방식에서는 영숫자로 된 로컬 개발 비밀번호를 사용하거나 Compose의 DATABASE_URL을 URL 인코딩한 값으로 수정합니다. API는 localhost에만 공개합니다.

- API: http://127.0.0.1:8000/api
- Swagger 문서/호출 화면: http://127.0.0.1:8000/docs
- OpenAPI: http://127.0.0.1:8000/openapi.json
- DB 상태 확인: http://127.0.0.1:8000/api/health

별도 DB를 이미 실행 중이면 첫 Docker 명령을 생략하고 해당 DATABASE_URL을 지정합니다. 루트 Compose와 backend Compose를 동시에 실행하면 호스트 5432 포트가 충돌합니다. 기본 Compose 볼륨은 서로 별개입니다. 기존 DB를 재사용하려면 기존 인스턴스 주소를 `.env`에 지정하고 로컬 Python 방식으로 실행합니다.

## 프로젝트 구성

```text
backend/
  app/
    main.py             앱 생성, DB 수명 관리, 오류 처리, CORS
    config.py           환경 설정
    auth.py             개발 인증 / OIDC JWT 검증
    schemas.py          입력 모델과 OpenAPI 정의
    api/projects.py     HTTP 라우터
    services.py         업무 명령·트랜잭션·권한·저장
    db.py               연결 풀과 SQL 마이그레이션 실행
    domain/plans.py     목표·실적·누적 지연 계산
    domain/approvals.py 변경 승인·최신 실적 보존
    migrations/         기존 DB와 호환되는 SQL
  tests/                업무 규칙·HTTP·인증·실제 DB 테스트
  requirements.lock     실행 의존성 고정
  requirements-dev.lock 테스트 의존성까지 고정
  Dockerfile
  compose.yaml
```

SQL 파일명과 schema_migrations 규격을 기존 Node 서버와 맞췄습니다. 이미 `001_initial.sql`을 적용한 DB에서는 다시 테이블을 만들지 않습니다. 새 DB에서는 전체 테이블을 생성합니다. 기존 운영 DB 사용 전 백업과 별도 검증을 권장합니다.

## 구현된 API

| Method | 경로 | 기능 |
|---|---|---|
| GET | `/api/projects?limit=100&offset=0` | 과제 목록, 최대 500건씩 |
| POST | `/api/projects` | 목표 계획 등록, 서버 ID·소유자·계획 상태 지정 |
| GET | `/api/projects/{id}` | 상세 조회, ETag 응답 |
| PUT | `/api/projects/{id}/reports` | Step/과제별 실적 저장 |
| POST | `/api/projects/{id}/change-requests` | 변경 승인 요청 |
| POST | `/api/projects/{id}/change-requests/{request_id}/decisions` | 승인·반려·철회 |
| GET | `/api/projects/{id}/history` | 감사 이력, limit/offset/snapshots 옵션 |

수정은 `If-Match: "현재_revision"`이 필요합니다. 누락·충돌은 409입니다. 입력 검증은 422, 인증 실패는 401, 권한 부족은 403입니다. 저장·승인 투영·전체 감사 이력은 한 트랜잭션으로 처리합니다. 감사 테이블은 UPDATE/DELETE를 차단합니다.

과제 JSON 안의 Step 목표/실적은 기존과 동일하게 **Step 자체의 완료 비율 0~100**입니다. 화면의 **0~Step 비중 기여도**와 구분합니다. 비중 40%의 Step에 화면에서 20%를 입력하면 API에는 50을 전달하며, 전체 합산에는 20%가 반영됩니다. 내부 단위를 바꾸지 않아 기존 저장 기록을 유지합니다.

등록 예시:

```json
{
  "title": "HBM 공정 분석 개선",
  "team": "AT팀",
  "tech": ["HBM ALL"],
  "startDate": "2026-11-01",
  "endDate": "2026-12-31",
  "stepPlanMode": "weighted-steps-v1",
  "steps": [
    {"id": "analysis", "name": "분석", "weight": 40, "startDate": "2026-11-01", "endDate": "2026-11-30", "monthly": {"2026-11": {"goal": 100}}},
    {"id": "validation", "name": "검증", "weight": 60, "startDate": "2026-11-01", "endDate": "2026-12-31", "monthly": {"2026-11": {"goal": 50}, "2026-12": {"goal": 100}}}
  ]
}
```

승인에는 `{candidate: 전체계획, reason: 변경사유}`, 처리에는 `{decision: "approved" | "rejected" | "withdrawn", comment: 검토의견}`을 전달합니다. `candidate`의 실적·소유자·이력은 권한 근거로 받지 않습니다. 실제 SSO ID와 서버의 소유자/참여자 ID로 편집을 검사하며 PO/PM 이름 문자열만으로 편집 권한을 부여하지 않습니다.

## 인증 및 권한

`APP_ENV=local` + `DEV_AUTH=true`는 고정된 로컬 개발 사용자입니다. 운영 환경에서 개발 인증을 켜면 시작 설정 검증에 실패합니다. 운영은 `DEV_AUTH=false`를 사용하고 다음을 설정합니다.

```text
APP_ENV=production
OIDC_ISSUER=https://your-corporate-issuer
OIDC_AUDIENCE=at-project-hub
OIDC_JWKS_URL=https://your-corporate-issuer/jwks
```

Authorization Bearer JWT의 RS256 서명·issuer·audience·만료·필수 클레임을 검증합니다. 검증된 `sub`는 사용자 ID, `name`은 표시명, 사내 인증 서버가 부여한 `at_role`/`at_team`은 역할/팀으로 사용합니다. 허용 역할은 at-head, team-lead, system-admin, project-representative, participant, member입니다. 본문이나 임의 역할 헤더를 신뢰하지 않습니다. issuer/audience/JWKS 미설정이면 인증을 차단합니다.

편집은 생성자·서버 등록 참여자·소속 팀장·담당장·관리자에 허용합니다. 승인 처리는 팀장/담당장과 자기 승인 제한을 별도로 적용합니다. 목록·상세·이력은 조직의 인증 사용자에게 공개합니다. 조직별 조회 범위 정책, 조직도 사용자/참여자 ID 지정, SSO 리다이렉트 로그인·세션 발급은 실제 사내 환경에 맞춰 연결해야 합니다. 이 API는 세션을 발급하지 않고 검증된 액세스 토큰을 받습니다.

## 프런트엔드 연결

루트 `src/api-client.js`를 사용할 수 있습니다.

```js
const api = createApiClient({
  baseUrl: 'http://127.0.0.1:8000/api',
  getAccessToken: async () => corporateSession.accessToken
});
const {projects} = await api.list();
```

개발 중 다른 포트의 프런트엔드는 CORS_ORIGINS에 명시한 주소만 허용합니다. 운영은 HTTPS와 동일 출처 `/api` 프록시 사용을 권장합니다. 현재 배포된 UI는 브라우저 저장 시연이며, 전체 UI의 비동기 저장 전환·사내 DB/SSO 배포는 완료되지 않았습니다. 이 작업에서는 독립 백엔드와 연결 어댑터를 구현했습니다. AI 호출과 메신저 실제 발송은 외부 연동 지점이며 구현하지 않았습니다.

## 테스트

```sh
python -m pytest -q
# 테스트 전용 PostgreSQL을 지정하면 실제 DB 테스트도 실행
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/test_db python -m pytest -q
```

DB 테스트는 별도 스키마를 생성·제거합니다. GitHub Actions는 PostgreSQL 17에서 과제 저장, 승인 중 실적 보존, 동시 수정 충돌, 트랜잭션 원복, 감사 이력 변경 차단을 실행하고 백엔드 Docker 이미지를 빌드합니다. DB 주소가 없으면 DB 테스트만 건너뜁니다.

구조 참고: [FastAPI APIRouter](https://fastapi.tiangolo.com/tutorial/bigger-applications/), [Psycopg 연결 풀과 트랜잭션](https://www.psycopg.org/psycopg3/docs/advanced/pool.html).

## 파일럿 보완 기능

- `/api/me`, `/api/statistics?month=YYYY-MM`: 인증 사용자와 동일 월 통계. 확정 실적은 보존된 당시 계획 기준으로 집계합니다.
- `POST /api/projects/{id}/attachments`, `GET .../attachments`, `GET .../attachments/{file_id}/download`: 과제·Step·보고 월 증빙 및 새 버전. 업로드는 multipart `file`, 선택 `step_id`/`month`/`replaces_id`, `If-Match`를 사용합니다.
- `POST /api/projects/{id}/months/{month}/submit`: 해당 월 실적 제출과 계획·실적·증빙 스냅샷. 완료 증빙 필수 Step은 파일을 확인합니다.
- `GET /api/projects/{id}/submissions`: 제출/보완/확정 내역.
- `POST /api/projects/{id}/submissions/{sid}/review`: `{decision: "approved" | "returned", comment: 검토의견}`. 같은 팀장/담당장 검토, 자기 확정 금지.

`002_pilot_reporting.sql`, `003_submission_retention.sql`을 추가했습니다. 기존 DB에도 `python -m app.db`를 다시 실행해야 합니다. 파일 저장 위치는 `ATTACHMENT_DIR`, 기본 한도는 `ATTACHMENT_MAX_BYTES`입니다. Docker 이미지는 `/data/attachments`를 사용하며 영속 볼륨을 연결해야 합니다. 현재 구현은 파일 볼륨 저장소이며 HCP 오브젝트 스토리지·악성코드 검사 연결은 후속 작업입니다.

백엔드 단독 ZIP에는 공용 프런트엔드가 포함되지 않습니다. 전체 작업공간은 전체 저장소의 `deploy/pilot.compose.yaml`로 실행합니다. [파일럿 검증 노트](../docs/pilot-validation.md)에 시나리오와 실제 사용자 파일럿 전 조건을 정리했습니다.
