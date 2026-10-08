"""Upload, preview frame, streaming and deletion, with every bad-file case from the specification."""

from __future__ import annotations

from pathlib import Path

import av
import numpy as np
import pytest
from fastapi.testclient import TestClient

from signaltwin_api.main import create_app
from signaltwin_api.testing import synth

from .conftest import make_settings, upload
from .test_service import assert_problem


def post_raw(client: TestClient, data: bytes, name: str = "clip.mp4"):
    return client.post("/v1/videos", content=data, headers={"Content-Type": "application/octet-stream", "X-Filename": name})


def test_upload_returns_metadata_and_dedupes(client: TestClient, video60) -> None:
    path, _ = video60
    first = post_raw(client, path.read_bytes())
    assert first.status_code == 201
    b = first.json()
    assert b["videoId"].startswith("v_") and len(b["sha256"]) == 64
    assert (b["width"], b["height"], b["fps"], b["codec"]) == (1280, 720, 25.0, "h264")
    assert b["durationS"] == pytest.approx(60.0, abs=0.1) and b["deduplicated"] is False and b["hasAudio"] is False
    again = post_raw(client, path.read_bytes(), "renamed.mp4")
    assert again.status_code == 200 and again.json()["videoId"] == b["videoId"] and again.json()["deduplicated"] is True
    files = list((client.app.state.ctx.storage.videos_dir).glob("*"))
    assert len(files) == 1
    assert not list(client.app.state.ctx.storage.tmp_dir.glob("up_*"))  # nothing left behind


def test_multipart_upload_works_too(client: TestClient, video60) -> None:
    path, _ = video60
    r = client.post("/v1/videos", files={"file": ("my clip.mp4", path.read_bytes(), "video/mp4")})
    assert r.status_code == 201 and r.json()["filename"] == "my clip.mp4"
    bad = client.post("/v1/videos", files={"other": ("x.mp4", b"abc", "video/mp4")})
    assert_problem(bad, 422, "invalid_request")


def test_filename_is_sanitised(client: TestClient, video60) -> None:
    path, _ = video60
    r = post_raw(client, path.read_bytes(), "..%2F..%2Fetc%2Fpasswd.mp4")
    assert r.json()["filename"] == "passwd.mp4"
    assert ".." not in str(list(client.app.state.ctx.storage.videos_dir.glob("*")))


def test_empty_file(client: TestClient) -> None:
    assert_problem(post_raw(client, b""), 422, "video_unreadable")


def test_text_file_with_video_extension(client: TestClient) -> None:
    b = assert_problem(post_raw(client, b"this is not a video at all" * 100, "movie.mp4"), 415, "unsupported_format")
    assert "MP4" in b["fix"]


def test_truncated_video(client: TestClient, video60) -> None:
    path, _ = video60
    data = path.read_bytes()
    assert_problem(post_raw(client, data[: int(len(data) * 0.4)]), 422, "video_unreadable")


def test_audio_only_file(client: TestClient, tmp_path: Path) -> None:
    p = tmp_path / "a.wav"
    c = av.open(str(p), "w")
    s = c.add_stream("pcm_s16le", rate=8000)
    s.layout = "mono"
    frame = av.AudioFrame.from_ndarray(np.zeros((1, 8000), dtype=np.int16), format="s16", layout="mono")
    frame.sample_rate = 8000
    for _ in range(5):
        for pkt in s.encode(frame):
            c.mux(pkt)
    for pkt in s.encode():
        c.mux(pkt)
    c.close()
    assert_problem(post_raw(client, p.read_bytes(), "audio.mp4"), 422, "no_video_stream")


def test_too_short(client: TestClient, tmp_path: Path) -> None:
    truth = synth.simulate(synth.SynthConfig(seconds=2, seed=1))
    p = tmp_path / "short.mp4"
    synth.write_video(truth, p)
    assert_problem(post_raw(client, p.read_bytes()), 422, "video_too_short")


def test_too_long_and_too_wide(tmp_path: Path, video60) -> None:
    path, _ = video60
    with TestClient(create_app(make_settings(tmp_path / "a", max_duration_s=30))) as c:
        assert_problem(post_raw(c, path.read_bytes()), 422, "video_too_long")
    with TestClient(create_app(make_settings(tmp_path / "b", max_width=1000))) as c:
        b = assert_problem(post_raw(c, path.read_bytes()), 413, "video_too_large")
        assert "1000" in b["detail"]


def test_over_size_limit_with_and_without_content_length(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, max_upload_mb=1))) as c:
        big = b"\x00\x00\x00\x18ftypmp42" + b"\x01" * (4 * 1024 * 1024)
        assert_problem(post_raw(c, big), 413, "video_too_large")  # declared length
        chunks = (big[i : i + 65536] for i in range(0, len(big), 65536))
        r = c.post("/v1/videos", content=chunks, headers={"X-Filename": "x.mp4"})  # chunked: no length up front
        assert_problem(r, 413, "video_too_large")
        assert not list(c.app.state.ctx.storage.tmp_dir.glob("up_*"))


def test_disk_full_is_reported(client: TestClient, video60, monkeypatch: pytest.MonkeyPatch) -> None:
    path, _ = video60
    monkeypatch.setattr(client.app.state.ctx.storage, "free_bytes", lambda: 1000)
    b = assert_problem(post_raw(client, path.read_bytes()), 507)
    assert "space" in b["title"].lower()


def test_upload_rate_limit(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, upload_limit_per_hour=2))) as c:
        codes = [post_raw(c, b"junk" * 10).status_code for _ in range(3)]
        assert codes[:2] == [415, 415] and codes[2] == 429


def test_frame_endpoint(client: TestClient, video60) -> None:
    v = upload(client, video60[0])
    r = client.get(f"/v1/videos/{v['videoId']}/frame", params={"t": 5, "width": 640})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    import cv2

    img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (360, 640)
    full = client.get(f"/v1/videos/{v['videoId']}/frame", params={"t": 0})
    assert cv2.imdecode(np.frombuffer(full.content, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (720, 1280)
    assert_problem(client.get(f"/v1/videos/{v['videoId']}/frame", params={"t": 999}), 422, "invalid_request")
    assert_problem(client.get(f"/v1/videos/{v['videoId']}/frame", params={"t": 1, "width": 5}), 422)
    assert_problem(client.get("/v1/videos/v_missing/frame"), 404, "job_not_found")


def test_stream_supports_range(client: TestClient, video60) -> None:
    v = upload(client, video60[0])
    r = client.get(f"/v1/videos/{v['videoId']}/stream", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100
    assert r.headers["content-range"].startswith("bytes 0-99/")
    assert r.headers["content-type"] == "video/mp4"


def test_delete_removes_everything(client: TestClient, video60) -> None:
    v = upload(client, video60[0])
    vid = v["videoId"]
    assert client.delete(f"/v1/videos/{vid}").status_code == 204
    assert_problem(client.get(f"/v1/videos/{vid}"), 404)
    assert_problem(client.delete(f"/v1/videos/{vid}"), 404)
    st = client.app.state.ctx.storage
    assert not list(st.videos_dir.glob("*")) and not list(st.results_dir.glob("*"))
    again = post_raw(client, video60[0].read_bytes())  # can be uploaded again afterwards
    assert again.status_code == 201


def test_concurrent_identical_uploads_store_one_copy(client: TestClient, video60) -> None:
    import concurrent.futures as cf

    data = video60[0].read_bytes()
    with cf.ThreadPoolExecutor(4) as ex:
        results = list(ex.map(lambda _: post_raw(client, data), range(4)))
    assert {r.json()["videoId"] for r in results} and len({r.json()["videoId"] for r in results}) == 1
    assert all(r.status_code in (200, 201) for r in results)
    assert len(list(client.app.state.ctx.storage.videos_dir.glob("*"))) == 1


