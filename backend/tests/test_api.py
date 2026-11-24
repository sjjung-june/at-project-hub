import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.api.projects import get_service
from app.auth import get_actor
from app.errors import DomainError


def test_api_docs_and_auth_fail_closed():
    app = create_app(Settings(_env_file=None, app_env="test"))
    with TestClient(app) as client:
        assert client.get("/docs").status_code == 200
        schema = client.get("/openapi.json").json()
        assert "/api/projects/{project_id}/reports" in schema["paths"]
        assert client.get("/api/projects").status_code == 401
        assert client.get("/api/projects", headers={"Authorization": "Bearer forged"}).status_code == 401
        assert client.get("/api/health").status_code == 503


def test_production_never_enables_development_auth():
    with pytest.raises(ValueError, match="local"):
        Settings(_env_file=None, app_env="production", dev_auth=True)


def test_revision_validation_and_validation_redaction(actor, project):
    class Service:
        def reports(self, pid, revision, body, actor):
            if revision != 3:
                raise DomainError("동시 수정", 409)
            return {"id": pid, "_revision": 4}
    app = create_app(Settings(_env_file=None, app_env="test"))
    app.dependency_overrides[get_actor] = lambda: actor
    app.dependency_overrides[get_service] = Service
    with TestClient(app) as client:
        path = "/api/projects/project/reports"
        assert client.put(path, json={"stepReports": {}}).status_code == 409
        assert client.put(path, headers={"If-Match": '"2"'}, json={"stepReports": {}}).status_code == 409
        result = client.put(path, headers={"If-Match": '"3"'}, json={"stepReports": {}})
        assert result.status_code == 200
        assert result.headers["etag"] == '"4"'
        result = client.put(path, headers={"If-Match": '"3"'}, json={"stepReports": {"s": {"2025-01": {"actual": 200, "reason": "secret-content"}}}})
        assert result.status_code == 422
        assert "secret-content" not in result.text


def test_signed_oidc_identity_and_invalid_tokens():
    import time
    import jwt
    from types import SimpleNamespace
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app = create_app(Settings(_env_file=None, app_env="test", oidc_issuer="https://sso.example", oidc_audience="at-project-hub"))
    app.state.jwks = SimpleNamespace(get_signing_key_from_jwt=lambda token: SimpleNamespace(key=key.public_key()))
    class Service:
        def list(self, limit, offset):
            return []
    app.dependency_overrides[get_service] = Service
    now = int(time.time())
    claims = {"sub": "user-123", "name": "검증 사용자", "iss": "https://sso.example", "aud": "at-project-hub", "iat": now, "exp": now + 120, "at_role": "member", "at_team": "AT팀"}
    with TestClient(app) as client:
        token = jwt.encode(claims, key, algorithm="RS256")
        assert client.get("/api/projects", headers={"Authorization": "Bearer " + token}).status_code == 200
        for patch in ({"iss": "https://wrong.example"}, {"aud": "other"}, {"exp": now - 100}, {"at_role": "invented-admin"}):
            bad = jwt.encode({**claims, **patch}, key, algorithm="RS256")
            assert client.get("/api/projects", headers={"Authorization": "Bearer " + bad}).status_code == 401
        forged = jwt.encode({**claims, "at_role": "at-head"}, "attacker-secret-that-is-at-least-32-characters", algorithm="HS256")
        assert client.get("/api/projects", headers={"Authorization": "Bearer " + forged}).status_code == 401
