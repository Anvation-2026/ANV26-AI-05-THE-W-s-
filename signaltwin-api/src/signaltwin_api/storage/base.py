"""Storage interface. Two adapters implement it: local (disk + SQLite) and Supabase."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

ACTIVE_STATES = ("queued", "probing", "decoding", "detecting", "running", "postprocessing")
TERMINAL_STATES = ("done", "error", "cancelled")


class VideoRecord(BaseModel):
    id: str
    sha256: str
    filename: str = ""
    size_bytes: int
    duration_s: float
    width: int
    height: int
    fps: float
    codec: str
    rotation: int = 0
    has_audio: bool = False
    start_offset_s: float = 0.0
    ext: str = ".mp4"
    created_at: float = 0.0
    warnings: list[str] = Field(default_factory=list)


class JobRecord(BaseModel):
    id: str
    video_id: str  # empty for jobs that have no video, such as experiments
    state: str = "queued"
    cache_key: str
    request: dict[str, Any] = Field(default_factory=dict)
    error: dict[str, Any] | None = None
    progress: dict[str, Any] = Field(default_factory=dict)
    created_at: float = 0.0
    updated_at: float = 0.0
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False
    from_cache: bool = False


class Storage(ABC):
    """Everything the API persists. Methods are synchronous and thread-safe."""

    tmp_dir: Path  # local scratch space for uploads and worker output, whatever the backing store

    @abstractmethod
    def init(self) -> None: ...

    # videos
    @abstractmethod
    def add_video(self, tmp_path: Path, record: VideoRecord) -> VideoRecord: ...
    @abstractmethod
    def get_video(self, video_id: str) -> VideoRecord | None: ...
    @abstractmethod
    def find_video_by_sha(self, sha256: str) -> VideoRecord | None: ...
    @abstractmethod
    def video_file(self, video_id: str) -> Path: ...
    @abstractmethod
    def delete_video(self, video_id: str) -> bool: ...

    # jobs
    @abstractmethod
    def create_job(self, job: JobRecord) -> None: ...
    @abstractmethod
    def update_job(self, job_id: str, **fields: Any) -> None: ...
    @abstractmethod
    def get_job(self, job_id: str) -> JobRecord | None: ...
    @abstractmethod
    def find_active_job(self, cache_key: str) -> JobRecord | None: ...
    @abstractmethod
    def jobs_in_states(self, states: tuple[str, ...]) -> list[JobRecord]: ...
    @abstractmethod
    def delete_job(self, job_id: str) -> bool: ...

    # events (server-sent events are replayed from here, which makes reconnects exact)
    @abstractmethod
    def append_event(self, job_id: str, type_: str, data: dict[str, Any]) -> int: ...
    @abstractmethod
    def events_since(self, job_id: str, last_id: int) -> list[tuple[int, str, dict[str, Any]]]: ...

    # results, keyed by cache key so a repeat request is instant
    @abstractmethod
    def save_result(self, cache_key: str, video_id: str, gz_bytes: bytes) -> None: ...
    @abstractmethod
    def save_result_file(self, cache_key: str, video_id: str, gz_path: Path) -> None: ...
    @abstractmethod
    def load_result(self, cache_key: str) -> bytes | None: ...
    @abstractmethod
    def has_result(self, cache_key: str) -> bool: ...

    # one saved junction (a single anonymous owner until sign-in exists)
    @abstractmethod
    def get_junction(self) -> dict[str, Any] | None: ...
    @abstractmethod
    def put_junction(self, junction: dict[str, Any]) -> None: ...

    # housekeeping
    @abstractmethod
    def purge_expired(self, retention_hours: float, stale_upload_hours: float = 1.0) -> dict[str, int]: ...
    @abstractmethod
    def mark_interrupted_jobs(self) -> int: ...
    @abstractmethod
    def free_bytes(self) -> int: ...
