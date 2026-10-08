"""Runtime settings, read from environment variables (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

API_VERSION = "0.1.0"
PIPELINE_VERSION = "2"
SIM_VERSION = "1"  # bump when the simulator port changes, so cached experiment results are not reused


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False)

    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    api_key: str = ""
    max_upload_mb: int = 800
    max_duration_s: int = 45 * 60
    max_width: int = 3840
    retention_hours: float = 24.0
    workers: int = 1
    queue_max: int = 8
    job_timeout_factor: float = 3.0
    job_timeout_min_s: int = 600
    job_memory_limit_mb: int = 6000
    max_proc_width: int = 1280
    target_fps: float = 10.0
    min_fps: float = 5.0

    model_weights: str = "models/yolo11n.pt"
    model_weights_5class: str = ""
    detector: str = "yolo"  # yolo | stub | synthetic
    device: str = "auto"
    confidence: float = 0.30
    iou: float = 0.5

    storage: Literal["local", "supabase"] = "local"
    data_dir: Path = Field(default=Path("data"))
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_bucket: str = "videos"

    log_level: str = "INFO"
    rate_limit_per_minute: int = 240
    upload_limit_per_hour: int = 30
    max_json_kb: int = 4096
    max_sim_horizon_s: int = 7200  # one synchronous /simulate call
    max_experiment_work: int = 30_000_000  # simulated seconds in one experiment: runs x horizon

    @field_validator("data_dir", mode="before")
    @classmethod
    def _path(cls, v: object) -> Path:
        return Path(str(v))

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
