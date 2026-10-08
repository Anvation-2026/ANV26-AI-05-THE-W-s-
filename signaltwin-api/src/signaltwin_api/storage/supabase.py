"""Supabase storage: Postgres tables for records, Storage buckets for files. Used only when STORAGE=supabase.

Not exercised against a live project in this repository's own checks: tests/test_storage_conformance.py runs the same
contract against LocalStorage and against this class with an in-memory stand-in for the Supabase client.
Videos are cached on local disk while a worker reads them; the bucket holds the durable copy.

Limits to know before deploying (see docs/DEPLOYMENT.md): free projects cap each file at 50 MB, and the standard upload
used here suits files up to a few hundred MB. Larger videos need the resumable upload protocol.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from ..config import Settings
from .base import ACTIVE_STATES, JobRecord, Storage, VideoRecord


class SupabaseStorage(Storage):
    def __init__(self, settings: Settings, client: Any = None) -> None:
        self.settings = settings
        self.root = settings.data_dir
        self.tmp_dir = self.root / "tmp"
        self.cache_dir = self.root / "cache"
        self.bucket_videos = settings.supabase_bucket or "videos"
        self.bucket_results = "results"
        self._client = client
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ plumbing
    @property
    def db(self) -> Any:
        if self._client is None:
            if not self.settings.supabase_url or not self.settings.supabase_service_role_key:
                raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set when STORAGE=supabase.")
            from supabase import create_client  # imported late: needs the 'supabase' extra

            self._client = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)
        return self._client

    def init(self) -> None:
        for d in (self.root, self.tmp_dir, self.cache_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.db.table("videos").select("id").limit(1).execute()  # fails early and clearly if the schema is missing

    @staticmethod
    def _iso(ts: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + f".{int((ts % 1) * 1000):03d}Z"  # milliseconds, so short retention periods compare correctly

    # ------------------------------------------------------------------ videos
    def _remote_name(self, rec: VideoRecord) -> str:
        return f"{rec.id}{rec.ext}"

    def _cache_path(self, rec: VideoRecord) -> Path:
        return self.cache_dir / self._remote_name(rec)

    def add_video(self, tmp_path: Path, record: VideoRecord) -> VideoRecord:
        record = record.model_copy(update={"created_at": time.time()})
        name = self._remote_name(record)
        with tmp_path.open("rb") as f:
            self.db.storage.from_(self.bucket_videos).upload(name, f, {"content-type": "application/octet-stream", "upsert": "true"})
        dest = self._cache_path(record)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp_path), str(dest))
        self.db.table("videos").upsert({"id": record.id, "sha256": record.sha256, "data": json.loads(record.model_dump_json()), "created_at": self._iso(record.created_at)}).execute()
        return record

    def _video_from_row(self, row: dict[str, Any]) -> VideoRecord:
        return VideoRecord.model_validate(row["data"])

    def get_video(self, video_id: str) -> VideoRecord | None:
        rows = self.db.table("videos").select("data").eq("id", video_id).limit(1).execute().data
        return self._video_from_row(rows[0]) if rows else None

    def find_video_by_sha(self, sha256: str) -> VideoRecord | None:
        rows = self.db.table("videos").select("data").eq("sha256", sha256).limit(1).execute().data
        return self._video_from_row(rows[0]) if rows else None

    def video_file(self, video_id: str) -> Path:
        rec = self.get_video(video_id)
        if rec is None:
            raise FileNotFoundError(video_id)
        path = self._cache_path(rec)
        if not path.exists():  # the local cache was cleared: fetch the durable copy
            data = self.db.storage.from_(self.bucket_videos).download(self._remote_name(rec))
            tmp = self.tmp_dir / f"dl_{rec.id}.part"
            tmp.write_bytes(data)
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(tmp), str(path))
        return path

    def delete_video(self, video_id: str) -> bool:
        rec = self.get_video(video_id)
        if rec is None:
            return False
        keys = [r["cache_key"] for r in self.db.table("results").select("cache_key").eq("video_id", video_id).execute().data]
        if keys:
            self.db.storage.from_(self.bucket_results).remove([f"{k}.json.gz" for k in keys])
            self.db.table("results").delete().eq("video_id", video_id).execute()
        self.db.table("jobs").delete().eq("video_id", video_id).execute()  # job_events go with them (on delete cascade)
        self.db.storage.from_(self.bucket_videos).remove([self._remote_name(rec)])
        self.db.table("videos").delete().eq("id", video_id).execute()
        self._cache_path(rec).unlink(missing_ok=True)
        return True

    # ------------------------------------------------------------------ jobs
    def _job_row(self, job: JobRecord) -> dict[str, Any]:
        return {
            "id": job.id,
            "video_id": job.video_id,
            "cache_key": job.cache_key,
            "state": job.state,
            "data": json.loads(job.model_dump_json()),
            "created_at": self._iso(job.created_at),
            "updated_at": self._iso(job.updated_at),
        }

    def create_job(self, job: JobRecord) -> None:
        now = time.time()
        job = job.model_copy(update={"created_at": now, "updated_at": now})
        self.db.table("jobs").insert(self._job_row(job)).execute()

    def update_job(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self.get_job(job_id)
            if job is None:
                return
            job = job.model_copy(update={**fields, "updated_at": time.time()})
            self.db.table("jobs").update({"state": job.state, "data": json.loads(job.model_dump_json()), "updated_at": self._iso(job.updated_at)}).eq("id", job_id).execute()

    def get_job(self, job_id: str) -> JobRecord | None:
        rows = self.db.table("jobs").select("data").eq("id", job_id).limit(1).execute().data
        return JobRecord.model_validate(rows[0]["data"]) if rows else None

    def find_active_job(self, cache_key: str) -> JobRecord | None:
        rows = self.db.table("jobs").select("data").eq("cache_key", cache_key).in_("state", list(ACTIVE_STATES)).order("created_at").limit(1).execute().data
        return JobRecord.model_validate(rows[0]["data"]) if rows else None

    def jobs_in_states(self, states: tuple[str, ...]) -> list[JobRecord]:
        rows = self.db.table("jobs").select("data").in_("state", list(states)).order("created_at").execute().data
        return [JobRecord.model_validate(r["data"]) for r in rows]

    def delete_job(self, job_id: str) -> bool:
        rows = self.db.table("jobs").delete().eq("id", job_id).execute().data
        return bool(rows)

    # ------------------------------------------------------------------ events
    def append_event(self, job_id: str, type_: str, data: dict[str, Any]) -> int:
        res = self.db.rpc("append_job_event", {"p_job_id": job_id, "p_type": type_, "p_data": data}).execute()
        return int(res.data)

    def events_since(self, job_id: str, last_id: int) -> list[tuple[int, str, dict[str, Any]]]:
        rows = self.db.table("job_events").select("seq,type,data").eq("job_id", job_id).gt("seq", last_id).order("seq").execute().data
        return [(int(r["seq"]), str(r["type"]), r["data"]) for r in rows]

    # ------------------------------------------------------------------ results
    def save_result(self, cache_key: str, video_id: str, gz_bytes: bytes) -> None:
        self.db.storage.from_(self.bucket_results).upload(f"{cache_key}.json.gz", gz_bytes, {"content-type": "application/gzip", "upsert": "true"})
        self.db.table("results").upsert({"cache_key": cache_key, "video_id": video_id, "size_bytes": len(gz_bytes)}).execute()

    def save_result_file(self, cache_key: str, video_id: str, gz_path: Path) -> None:
        data = gz_path.read_bytes()
        gz_path.unlink(missing_ok=True)
        self.save_result(cache_key, video_id, data)

    def load_result(self, cache_key: str) -> bytes | None:
        if not self.has_result(cache_key):
            return None
        return bytes(self.db.storage.from_(self.bucket_results).download(f"{cache_key}.json.gz"))

    def has_result(self, cache_key: str) -> bool:
        return bool(self.db.table("results").select("cache_key").eq("cache_key", cache_key).limit(1).execute().data)

    # ------------------------------------------------------------------ junction
    def get_junction(self) -> dict[str, Any] | None:
        rows = self.db.table("junction").select("data").eq("id", "default").limit(1).execute().data
        return rows[0]["data"] if rows else None

    def put_junction(self, junction: dict[str, Any]) -> None:
        self.db.table("junction").upsert({"id": "default", "data": junction, "updated_at": self._iso(time.time())}).execute()

    # ------------------------------------------------------------------ housekeeping
    def purge_expired(self, retention_hours: float, stale_upload_hours: float = 1.0) -> dict[str, int]:
        removed = {"videos": 0, "results": 0, "tmp": 0}
        now = time.time()
        for d in (self.tmp_dir,):
            for f in d.glob("*"):
                try:
                    if now - f.stat().st_mtime > stale_upload_hours * 3600:
                        f.unlink(missing_ok=True)
                        removed["tmp"] += 1
                except OSError:
                    continue
        if retention_hours > 0:
            cutoff = self._iso(now - retention_hours * 3600)
            old = self.db.table("videos").select("id").lt("created_at", cutoff).execute().data
            for r in old:
                if self.delete_video(r["id"]):
                    removed["videos"] += 1
        return removed

    def mark_interrupted_jobs(self) -> int:
        n = 0
        problem = {
            "code": "job_failed", "status": 500, "title": "The analysis was interrupted",
            "detail": "The server restarted while this video was being analysed.",
            "fix": "Start the analysis again. Finished analyses are kept.", "retryable": True,
        }
        for job in self.jobs_in_states(ACTIVE_STATES[1:]):
            self.update_job(job.id, state="error", finished_at=time.time(), error=problem)
            self.append_event(job.id, "error", {"problem": problem})
            n += 1
        return n

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free
