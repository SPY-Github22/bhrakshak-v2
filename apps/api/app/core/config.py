from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "BhuRakshak API"
    debug: bool = True
    demo_mode: bool = True
    fixture_mode: bool = False

    database_url: str = "postgresql+asyncpg://bhrakshak:bhrakshak@localhost:5433/bhrakshak"
    redis_url: str = "redis://localhost:6380/0"

    mqtt_host: str = "localhost"
    mqtt_port: int = 1883

    minio_endpoint: str = "localhost:9000"
    minio_root_user: str = "bhrakshak"
    minio_root_password: str = "bhrakshak-secret"
    minio_bucket: str = "bhrakshak-media"

    jwt_secret: str = "change-me-in-production-9f2c1a"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 14

    open_meteo_base: str = "https://api.open-meteo.com/v1"

    cors_origins: str = "*"

    # alert channels — dryrun by default so demo never needs real keys
    sms_provider: str = "dryrun"
    alert_sms_dryrun: str = "true"
    fcm_dryrun: str = "true"
    siren_webhook_url: str | None = None

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def jwt_secret_is_default(self) -> bool:
        return self.jwt_secret == "change-me-in-production-9f2c1a" or len(self.jwt_secret) < 32

    @property
    def sync_database_url(self) -> str:
        return self.database_url.replace("+asyncpg", "+psycopg")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
