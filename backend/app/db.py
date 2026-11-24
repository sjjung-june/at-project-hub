from pathlib import Path
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def make_pool(url: str):
    if not url:
        return None
    return ConnectionPool(url, min_size=1, max_size=10, open=False,
                          timeout=5, kwargs={"row_factory": dict_row, "connect_timeout": 5})


def migrate(pool):
    with pool.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(827351)")
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        applied = {row["name"] for row in conn.execute("SELECT name FROM schema_migrations")}
        for path in sorted((Path(__file__).resolve().parent / "migrations").glob("*.sql")):
            if path.name not in applied:
                conn.execute(path.read_text())
                conn.execute("INSERT INTO schema_migrations(name) VALUES(%s)", [path.name])


if __name__ == "__main__":
    from .config import Settings
    pool = make_pool(Settings().database_url.get_secret_value())
    if pool is None:
        raise SystemExit("DATABASE_URL is required")
    with pool:
        migrate(pool)
    print("Database migrations applied")
