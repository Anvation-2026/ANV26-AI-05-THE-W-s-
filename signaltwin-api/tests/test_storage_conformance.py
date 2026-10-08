"""Every storage adapter must behave the same. These tests run against local storage and against the Supabase adapter."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from signaltwin_api.config import Settings
from signaltwin_api.storage.base import JobRecord, Storage, VideoRecord
from signaltwin_api.storage.local import LocalStorage
from signaltwin_api.storage.supabase import SupabaseStorage

from .fake_supabase import FakeSupabase


@pytest.fixture(params=["local", "supabase"])
def store(request: pytest.FixtureRequest, tmp_path: Path) -> Storage:
    if request.param == "local":
        s: Storage = LocalStorage(tmp_path / "data")
    else:
        s = SupabaseStorage(Settings(data_dir=tmp_path / "data", storage="supabase", _env_file=None), client=FakeSupabase())  # type: ignore[call-arg]
    s.init()
    return s


def video(i: int = 1, ext: str = ".mp4") -> VideoRecord:
    return VideoRecord(id=f"v_{i:020d}", sha256=f"{i:064x}", filename="a.mp4", size_bytes=5, duration_s=10, width=640, height=360, fps=25, codec="h264", ext=ext)


def put(store: Storage, rec: VideoRecord, content: bytes = b"hello") -> VideoRecord:
    tmp = store.tmp_dir / f"up_{rec.id}.part"
    tmp.write_bytes(content)
    return store.add_video(tmp, rec)


def test_videos_round_trip(store: Storage) -> None:
    rec = put(store, video(1))
    assert rec.created_at > 0
    got = store.get_video(rec.id)
    assert got is not None and got.sha256 == rec.sha256 and got.filename == "a.mp4"
    assert store.find_video_by_sha(rec.sha256) is not None and store.find_video_by_sha("0" * 64) is None
    assert store.video_file(rec.id).read_bytes() == b"hello"
    assert store.get_video("v_missing") is None
    with pytest.raises(FileNotFoundError):
        store.video_file("v_missing")
    assert not list(store.tmp_dir.glob("up_*"))  # the upload was moved, not copied


def test_delete_video_removes_jobs_events_and_results(store: Storage) -> None:
    rec = put(store, video(1))
    other = put(store, video(2), b"other")
    job = JobRecord(id="j_1", video_id=rec.id, cache_key="k1")
    store.create_job(job)
    store.append_event("j_1", "queued", {})
    store.save_result("k1", rec.id, b"gz")
    store.create_job(JobRecord(id="j_2", video_id=other.id, cache_key="k2"))
    store.save_result("k2", other.id, b"gz2")
    assert store.delete_video(rec.id) is True
    assert store.get_video(rec.id) is None and store.get_job("j_1") is None
    assert store.events_since("j_1", 0) == [] and store.has_result("k1") is False and store.load_result("k1") is None
    assert store.get_video(other.id) is not None and store.get_job("j_2") is not None and store.load_result("k2") == b"gz2"
    assert store.delete_video(rec.id) is False


def test_jobs_lifecycle(store: Storage) -> None:
    store.create_job(JobRecord(id="j_a", video_id="v", cache_key="same"))
    store.create_job(JobRecord(id="j_b", video_id="v", cache_key="other", state="detecting"))
    time.sleep(0.01)
    store.create_job(JobRecord(id="j_c", video_id="v", cache_key="same"))
    assert store.find_active_job("same").id == "j_a"  # type: ignore[union-attr]  # the oldest
    assert store.find_active_job("nothing") is None
    store.update_job("j_a", state="done", progress={"fraction": 1.0})
    assert store.get_job("j_a").state == "done" and store.get_job("j_a").progress == {"fraction": 1.0}  # type: ignore[union-attr]
    assert store.find_active_job("same").id == "j_c"  # type: ignore[union-attr]
    assert {j.id for j in store.jobs_in_states(("queued",))} == {"j_c"}
    assert [j.id for j in store.jobs_in_states(("detecting", "done"))] == ["j_a", "j_b"]
    store.update_job("j_missing", state="done")  # silently ignored
    assert store.delete_job("j_a") is True and store.delete_job("j_a") is False


def test_events_are_numbered_in_order_and_can_be_resumed(store: Storage) -> None:
    store.create_job(JobRecord(id="j", video_id="v", cache_key="k"))
    seqs = [store.append_event("j", t, {"n": i}) for i, t in enumerate(["queued", "state", "progress", "done"])]
    assert seqs == [1, 2, 3, 4]
    all_events = store.events_since("j", 0)
    assert [(s, t) for s, t, _ in all_events] == [(1, "queued"), (2, "state"), (3, "progress"), (4, "done")]
    assert all_events[2][2] == {"n": 2}
    assert [s for s, _, _ in store.events_since("j", 2)] == [3, 4]
    assert store.events_since("j", 4) == [] and store.events_since("nobody", 0) == []


def test_results(store: Storage) -> None:
    assert store.has_result("k") is False and store.load_result("k") is None
    store.save_result("k", "v", b"abc")
    assert store.has_result("k") and store.load_result("k") == b"abc"
    f = store.tmp_dir / "r.part"
    f.write_bytes(b"from a file")
    store.save_result_file("k2", "v", f)
    assert store.load_result("k2") == b"from a file" and not f.exists()
    store.save_result("k", "v", b"newer")
    assert store.load_result("k") == b"newer"


def test_junction(store: Storage) -> None:
    assert store.get_junction() is None
    store.put_junction({"name": "one"})
    store.put_junction({"name": "two", "geometry": {"stopLines": {}}})
    assert store.get_junction() == {"name": "two", "geometry": {"stopLines": {}}}


def test_purge_expired_keeps_fresh_videos_and_removes_old_ones(store: Storage) -> None:
    put(store, video(1))
    assert store.purge_expired(retention_hours=24)["videos"] == 0
    assert store.get_video(video(1).id) is not None
    time.sleep(1.1)
    assert store.purge_expired(retention_hours=0.0002)["videos"] == 1  # 0.72 s
    assert store.get_video(video(1).id) is None
    stale = store.tmp_dir / "stale.part"
    stale.write_bytes(b"x")
    old = time.time() - 7200
    import os

    os.utime(stale, (old, old))
    assert store.purge_expired(retention_hours=0)["tmp"] >= 1 and not stale.exists()


def test_interrupted_jobs_are_marked_but_waiting_ones_are_not(store: Storage) -> None:
    store.create_job(JobRecord(id="run", video_id="v", cache_key="a", state="detecting"))
    store.create_job(JobRecord(id="wait", video_id="v", cache_key="b", state="queued"))
    assert store.mark_interrupted_jobs() == 1
    job = store.get_job("run")
    assert job is not None and job.state == "error" and job.error and job.error["retryable"] is True and "again" in job.error["fix"]
    assert store.get_job("wait").state == "queued"  # type: ignore[union-attr]
    assert [t for _, t, _ in store.events_since("run", 0)] == ["error"]


def test_free_bytes_and_tmp_dir(store: Storage) -> None:
    assert store.free_bytes() > 0 and store.tmp_dir.is_dir()


def test_migration_is_valid_postgres_and_covers_every_table() -> None:
    pglast = pytest.importorskip("pglast")
    sql = (Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20261009000000_init.sql").read_text(encoding="utf-8")
    stmts = pglast.parse_sql(sql)
    assert len(stmts) >= 20
    text = sql.lower()
    for table in ("videos", "jobs", "job_events", "results", "junction"):
        assert f"create table public.{table}" in text
        assert f"alter table public.{table} enable row level security" in text  # no table is left open
    assert "set search_path = ''" in text  # the function cannot be hijacked through the search path
    assert "revoke all on function public.append_job_event" in text
