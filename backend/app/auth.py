import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from .errors import DomainError
from .schemas import Actor

bearer = HTTPBearer(auto_error=False)


def get_actor(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Actor:
    settings = request.app.state.settings
    if settings.dev_auth and settings.app_env == "local":
        return Actor(id="local-developer", name="로컬 개발자", role="at-head", team="개발팀", authenticated=False)
    if not credentials or not request.app.state.jwks:
        raise DomainError("로그인이 필요합니다.", 401)
    try:
        key = request.app.state.jwks.get_signing_key_from_jwt(credentials.credentials).key
        claims = jwt.decode(credentials.credentials, key, algorithms=["RS256"],
                            issuer=settings.oidc_issuer, audience=settings.oidc_audience,
                            options={"require": ["sub", "exp", "iat", "iss", "aud"]})
        # These custom claims must be assigned by the trusted corporate identity provider.
        return Actor(id=claims["sub"], name=claims.get("name", claims["sub"]),
                     role=claims.get("at_role", "member"), team=claims.get("at_team", ""))
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        raise DomainError("로그인 정보가 유효하지 않습니다.", 401) from None


def make_jwks(settings):
    if not all([settings.oidc_issuer, settings.oidc_audience, settings.oidc_jwks_url]):
        return None
    if not settings.oidc_jwks_url.startswith("https://"):
        raise ValueError("OIDC_JWKS_URL must use HTTPS")
    return PyJWKClient(settings.oidc_jwks_url, cache_keys=True, timeout=5)
