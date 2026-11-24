from typing import Literal
from pathlib import Path
from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_env: Literal["local", "test", "production"] = "production"
    database_url: SecretStr = SecretStr("")
    dev_auth: bool = False
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_url: str = ""
    cors_origins: list[str] = []
    attachment_dir: Path = Path("./var/attachments")
    attachment_max_bytes: int = 20 * 1024 * 1024

    @model_validator(mode="after")
    def safe_local_auth(self):
        if self.dev_auth and self.app_env != "local":
            raise ValueError("DEV_AUTH is allowed only with APP_ENV=local")
        return self
