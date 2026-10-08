"""Local storage: files on disk and one SQLite database (WAL mode)."""

from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

from .base import ACTIVE_STATES, JobRecord, Storage, VideoRecord

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, json TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL, cache_key TEXT NOT NULL, state TEXT NOT NULL,
  json TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_cache ON jobs(cache_key, state);
CREATE INDEX IF NOT EXISTS jobs_video ON jobs(video_id);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, data TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON job_events(job_id, seq);
CREATE TABLE IF NOT EXISTS results (
  cache_key TEXT PRIMARY KEY, video_id TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS junction (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at REAL NOT NULL);
"""


class LocalStorage(Storage):
    def __init__(self, root: Path) -> None:
        self.root = root
        self.videos_dir = root / "videos"
        self.results_dir = root / "results"
        self.tmp_dir = root / "tmp"
        self.db_path = root / "signaltwin.db"
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ plumbing
    def init(self) -> None:
        for d in (self.root, self.videos_dir, self.results_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock, closing(sqlite3.connect(self.db_path, timeout=30, isolation_level=None)) as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA busy_timeout=30000")
            c.row_factory = sqlite3.Row
            yield c

    # ------------------------------------------------------------------ videos
    def _video_path(self, rec: VideoRecord) -> Path:
        return self.videos_dir / f"{rec.id}{rec.ext}"

    def add_video(self, tmp_path: Path, record: VideoRecord) -> VideoRecord:
        record = record.model_copy(update={"created_at": time.time()})
        dest = self._video_path(record)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp_path), str(dest))
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO videos(id, sha256, json, created_at) VALUES (?,?,?,?)",
                (record.id, record.sha256, record.model_dump_json(), record.created_at),
            )
        return record

    def get_video(self, video_id: str) -> VideoRecord | None:
        with self._conn() as c:
            row = c.execute("SELECT json FROM videos WHERE id=?", (video_id,)).fetchone()
        if not row:
            return None
        rec = VideoRecord.model_validate_json(row["json"])
        return rec if self._video_path(rec).exists() else None

    def find_video_by_sha(self, sha256: str) -> VideoRecord | None:
        with self._conn() as c:
            row = c.execute("SELECT id FROM videos WHERE sha256=?", (sha256,)).fetchone()
        return self.get_video(row["id"]) if row else None

    def video_file(self, video_id: str) -> Path:
        rec = self.get_video(video_id)
        if rec is None:
            raise FileNotFoundError(video_id)
        return self._video_path(rec)

    def delete_video(self, video_id: str) -> bool:
        with self._conn() as c:
            row = c.execute("SELECT json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not row:
                return False
            rec = VideoRecord.model_validate_json(row["json"])
            keys = [r["cache_key"] for r in c.execute("SELECT cache_key FROM results WHERE video_id=?", (video_id,))]
            job_ids = [r["id"] for r in c.execute("SELECT id FROM jobs WHERE video_id=?", (video_id,))]
            c.execute("DELETE FROM results WHERE video_id=?", (video_id,))
            for jid in job_ids:
                c.execute("DELETE FROM job_events WHERE job_id=?", (jid,))
            c.execute("DELETE FROM jobs WHERE video_id=?", (video_id,))
            c.execute("DELETE FROM videos WHERE id=?", (video_id,))
        self._video_path(rec).unlink(missing_ok=True)
        for k in keys:
            self._result_path(k).unlink(missing_ok=True)
        return True

    # ------------------------------------------------------------------ jobs
    def create_job(self, job: JobRecord) -> None:
        now = time.time()
        job = job.model_copy(update={"created_at": now, "updated_at": now})
        with self._conn() as c:
            c.execute(
                "INSERT INTO jobs(id, video_id, cache_key, state, json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (job.id, job.video_id, job.cache_key, job.state, job.model_dump_json(), now, now),
            )

    def update_job(self, job_id: str, **fields: Any) -> None:
        with self._conn() as c:
            row = c.execute("SELECT json FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return
            job = JobRecord.model_validate_json(row["json"]).model_copy(update={**fields, "updated_at": time.time()})
            c.execute(
                "UPDATE jobs SET state=?, json=?, updated_at=? WHERE id=?",
                (job.state, job.model_dump_json(), job.updated_at, job_id),
            )

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._conn() as c:
            row = c.execute("SELECT json FROM jobs WHERE id=?", (job_id,)).fetchone()
        return JobRecord.model_validate_json(row["json"]) if row else None

    def find_active_job(self, cache_key: str) -> JobRecord | None:
        q = ",".join("?" for _ in ACTIVE_STATES)
        with self._conn() as c:
            row = c.execute(
                f"SELECT json FROM jobs WHERE cache_key=? AND state IN ({q}) ORDER BY created_at LIMIT 1",
                (cache_key, *ACTIVE_STATES),
            ).fetchone()
        return JobRecord.model_validate_json(row["json"]) if row else None

    def jobs_in_states(self, states: tuple[str, ...]) -> list[JobRecord]:
        q = ",".join("?" for _ in states)
        with self._conn() as c:
            rows = c.execute(f"SELECT json FROM jobs WHERE state IN ({q}) ORDER BY created_at", states).fetchall()
        return [JobRecord.model_validate_json(r["json"]) for r in rows]

    def delete_job(self, job_id: str) -> bool:
        with self._conn() as c:
            c.execute("DELETE FROM job_events WHERE job_id=?", (job_id,))
            cur = c.execute("DELETE FROM jobs WHERE id=?", (job_id,))
            return cur.rowcount > 0

    # ------------------------------------------------------------------ events
    def append_event(self, job_id: str, type_: str, data: dict[str, Any]) -> int:
        with self._conn() as c:
            row = c.execute("SELECT COALESCE(MAX(seq),0)+1 AS n FROM job_events WHERE job_id=?", (job_id,)).fetchone()
            seq = int(row["n"])
            c.execute(
                "INSERT INTO job_events(job_id, seq, type, data, created_at) VALUES (?,?,?,?,?)",
                (job_id, seq, type_, json.dumps(data, separators=(",", ":")), time.time()),
            )
        return seq

    def events_since(self, job_id: str, last_id: int) -> list[tuple[int, str, dict[str, Any]]]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT seq, type, data FROM job_events WHERE job_id=? AND seq>? ORDER BY seq", (job_id, last_id)
            ).fetchall()
        return [(int(r["seq"]), str(r["type"]), json.loads(r["data"])) for r in rows]

    # ------------------------------------------------------------------ results
    def _result_path(self, cache_key: str) -> Path:
        return self.results_dir / f"{cache_key}.json.gz"

    def save_result(self, cache_key: str, video_id: str, gz_bytes: bytes) -> None:
        tmp = self.tmp_dir / f"{cache_key}.{threading.get_ident()}.part"
        tmp.write_bytes(gz_bytes)
        self.save_result_file(cache_key, video_id, tmp)

    def save_result_file(self, cache_key: str, video_id: str, gz_path: Path) -> None:
        dest = self._result_path(cache_key)
        size = gz_path.stat().st_size
        shutil.move(str(gz_path), str(dest))
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO results(cache_key, video_id, size_bytes, created_at) VALUES (?,?,?,?)",
                (cache_key, video_id, size, time.time()),
            )

    def load_result(self, cache_key: str) -> bytes | None:
        p = self._result_path(cache_key)
        return p.read_bytes() if p.exists() else None

    def has_result(self, cache_key: str) -> bool:
        return self._result_path(cache_key).exists()

    # ------------------------------------------------------------------ junction
    def get_junction(self) -> dict[str, Any] | None:
        with self._conn() as c:
            row = c.execute("SELECT json FROM junction WHERE id='default'").fetchone()
        return json.loads(row["json"]) if row else None

    def put_junction(self, junction: dict[str, Any]) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO junction(id, json, updated_at) VALUES ('default', ?, ?)",
                (json.dumps(junction), time.time()),
            )

    # ------------------------------------------------------------------ housekeeping
    def purge_expired(self, retention_hours: float, stale_upload_hours: float = 1.0) -> dict[str, int]:
        removed = {"videos": 0, "results": 0, "tmp": 0}
        now = time.time()
        for f in self.tmp_dir.glob("*"):
            try:
                if now - f.stat().st_mtime > stale_upload_hours * 3600:
                    f.unlink(missing_ok=True)
                    removed["tmp"] += 1
            except OSError:
                continue
        if retention_hours > 0:
            cutoff = now - retention_hours * 3600
            with self._conn() as c:
                old = [r["id"] for r in c.execute("SELECT id FROM videos WHERE created_at<?", (cutoff,))]
            for vid in old:
                if self.delete_video(vid):
                    removed["videos"] += 1
        return removed

    def mark_interrupted_jobs(self) -> int:
        n = 0
        for job in self.jobs_in_states(ACTIVE_STATES[1:]):  # jobs still waiting in the queue are not interrupted
            self.update_job(
                job.id,
                state="error",
                finished_at=time.time(),
                error={
                    "code": "job_failed",
                    "status": 500,
                    "title": "The analysis was interrupted",
                    "detail": "The server restarted while this video was being analysed.",
                    "fix": "Start the analysis again. Finished analyses are kept.",
                    "retryable": True,
                },
            )
            self.append_event(job.id, "error", {"problem": {"code": "job_failed", "title": "The analysis was interrupted",
                "detail": "The server restarted while this video was being analysed.",
                "fix": "Start the analysis again. Finished analyses are kept.", "retryable": True}})
            n += 1
        return n

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free
