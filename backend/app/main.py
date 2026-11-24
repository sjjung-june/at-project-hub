from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from .config import Settings
from .db import make_pool
from .auth import make_jwks
from .errors import DomainError
from .api.projects import router
from .api.pilot import router as pilot_router
from .request_limits import UploadBodyLimit


def create_app(settings=None, pool=None):
    settings = settings or Settings()
    owns_pool = pool is None
    pool = pool or make_pool(settings.database_url.get_secret_value())

    @asynccontextmanager
    async def lifespan(app):
        if owns_pool and pool:
            pool.open(wait=True, timeout=10)
        try:
            yield
        finally:
            if owns_pool and pool:
                pool.close()

    app = FastAPI(title="AT Project Hub API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(UploadBodyLimit,max_bytes=settings.attachment_max_bytes+1024*1024)
    app.state.settings = settings
    app.state.pool = pool
    app.state.jwks = make_jwks(settings)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                           allow_methods=["GET", "POST", "PUT"], allow_headers=["Authorization", "Content-Type", "If-Match"], expose_headers=["ETag"])

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": error.message}, headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else {})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Avoid echoing submitted documents/credentials in error payloads.
        return JSONResponse(status_code=422, content={"error": "입력 형식과 범위를 확인해 주세요.", "fields": [".".join(map(str, item["loc"])) for item in error.errors()]})

    async def database_error(request, error):
        return JSONResponse(status_code=503, content={"error": "데이터베이스 요청을 처리하지 못했습니다."})

    app.add_exception_handler(DatabaseError, database_error)
    app.add_exception_handler(PoolTimeout, database_error)

    @app.get("/api/health", tags=["Health"])
    def health():
        if pool is None:
            raise DomainError("데이터베이스가 설정되지 않았습니다.", 503)
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "database": "postgresql", "framework": "fastapi"}

    app.include_router(router)
    app.include_router(pilot_router)
    return app


app = create_app()
