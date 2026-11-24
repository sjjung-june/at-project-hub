import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import uuid4
import pytest
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from fastapi.testclient import TestClient
from app.db import migrate
from app.main import create_app
from app.config import Settings
from app.auth import get_actor
from app.schemas import Actor, ProjectPlan, ReportUpdate, ChangeRequest, Decision
from app.services import ProjectService
from app.errors import DomainError


@pytest.fixture
def pool():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is required for real PostgreSQL tests")
    schema = "fastapi_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        with ConnectionPool(url, kwargs={"options": f"-c search_path={schema}", "row_factory": dict_row}, min_size=1, max_size=4) as pool:
            migrate(pool)
            migrate(pool)
            yield pool
    finally:
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_database_workflow_locking_rollback_and_audit(pool, project, actor):
    service = ProjectService(pool)
    original = service.create(ProjectPlan.model_validate({**project, "_ownerId": "forged"}), actor)
    pid = original["id"]
    assert original["_ownerId"] == actor.id
    assert original["status"] == "계획"
    assert len(service.list()) == 1
    stranger = Actor(id="stranger", name="일반 사용자", role="member", team="AT팀")
    with pytest.raises(DomainError) as error:
        service.reports(pid, 1, ReportUpdate(stepReports={}), stranger)
    assert error.value.status == 403
    candidate = deepcopy(original)
    candidate["title"] = "승인할 제목"
    pending = service.request_change(pid, 1, ChangeRequest(candidate=ProjectPlan.model_validate(candidate), reason="제목 개선"), actor)
    request_id = pending["_changeRequests"][0]["id"]
    reported = service.reports(pid, 2, ReportUpdate.model_validate({"stepReports": {"a": {"2025-01": {"actual": 100}}, "b": {"2025-01": {"actual": 60}}}}), actor)
    assert reported["monthly"]["2025-01"]["actual"] == 76
    def write():
        try:
            return service.reports(pid, 3, ReportUpdate.model_validate({"stepReports": {"b": {"2025-02": {"actual": 100}}}}), actor)
        except DomainError as e:
            return e.status
    with ThreadPoolExecutor(max_workers=2) as threads:
        outcomes = list(threads.map(lambda _: write(), range(2)))
    assert sum(isinstance(r, dict) for r in outcomes) == 1
    assert 409 in outcomes
    with pytest.raises(DomainError):
        service.decide(pid, 4, request_id, Decision(decision="approved", comment="본인 승인"), actor)
    lead = Actor(id="lead", name="소속 팀장", role="team-lead", team="AT팀")
    approved = service.decide(pid, 4, request_id, Decision(decision="approved", comment="승인 완료"), lead)
    assert approved["title"] == "승인할 제목"
    assert approved["stepReports"]["b"]["2025-01"]["actual"] == 60
    assert approved["_revision"] == 5
    with pytest.raises(DomainError):
        service.reports(pid, 5, ReportUpdate.model_validate({"stepReports": {"unknown": {"2025-01": {"actual": 100}}}}), actor)
    assert service.get(pid)["_revision"] == 5
    assert len(service.history(pid)) == 5
    with pytest.raises(psycopg.Error, match="append-only"):
        with pool.connection() as conn:
            conn.execute("DELETE FROM audit_events WHERE project_id=%s", [pid])
    with pool.connection() as conn:
        assert conn.execute("SELECT count(*) AS count FROM schema_migrations").fetchone()["count"] == 1
        assert conn.execute("SELECT status FROM change_requests WHERE id=%s", [request_id]).fetchone()["status"] == "approved"


def test_postgres_http_contract(pool, project, actor):
    app = create_app(Settings(_env_file=None, app_env="test"), pool=pool)
    app.dependency_overrides[get_actor] = lambda: actor
    with TestClient(app) as client:
        assert client.get("/api/health").json()["framework"] == "fastapi"
        created = client.post("/api/projects", json=project)
        assert created.status_code == 201
        assert created.headers["etag"] == '"1"'
        pid = created.json()["id"]
        assert client.get(f"/api/projects/{pid}").status_code == 200
        assert client.get("/api/projects?limit=1").json()["projects"][0]["id"] == pid
        assert client.get("/api/projects?limit=501").status_code == 422
        assert client.put(f"/api/projects/{pid}/reports", json={"stepReports": {}}).status_code == 409
        invalid = client.put(f"/api/projects/{pid}/reports", headers={"If-Match": '"1"'}, json={"stepReports": {"a": {"2025-01": {"actual": 80}}}})
        assert invalid.status_code == 422
        history = client.get(f"/api/projects/{pid}/history?snapshots=true").json()["events"]
        assert len(history) == 1
        assert history[0]["after_document"]["id"] == pid
        assert client.get("/api/projects/unknown").status_code == 404
