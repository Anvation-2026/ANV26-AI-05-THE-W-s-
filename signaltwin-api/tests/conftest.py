from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from signaltwin_api.config import Settings, reset_settings_cache
from signaltwin_api.main import create_app
from signaltwin_api.testing import synth


def make_settings(tmp: Path, **over: object) -> Settings:
    base: dict[str, object] = {
        "data_dir": tmp / "data",
        "detector": "synthetic",
        "workers": 1,
        "queue_max": 4,
        "rate_limit_per_minute": 100000,
        "upload_limit_per_hour": 100000,
        "allowed_origins": "http://localhost:5173,http://127.0.0.1:5173",
        "log_level": "WARNING",
        "_env_file": None,
    }
    base.update(over)
    return Settings(**base)  # type: ignore[arg-type]


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("media")


@pytest.fixture(scope="session")
def video60(media_dir: Path) -> tuple[Path, synth.GroundTruth]:
    truth = synth.simulate(synth.SynthConfig(seconds=60, seed=11))
    p = media_dir / "synth60.mp4"
    synth.write_video(truth, p)
    return p, truth


@pytest.fixture(scope="session")
def video300(media_dir: Path) -> tuple[Path, synth.GroundTruth]:
    truth = synth.simulate(synth.SynthConfig(seconds=300, seed=7))
    p = media_dir / "synth300.mp4"
    synth.write_video(truth, p)
    return p, truth


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture()
def client(settings: Settings) -> Iterator[TestClient]:
    reset_settings_cache()
    with TestClient(create_app(settings)) as c:
        yield c


def upload(client: TestClient, path: Path, name: str | None = None) -> dict:
    r = client.post("/v1/videos", content=path.read_bytes(), headers={"Content-Type": "application/octet-stream", "X-Filename": name or path.name})
    assert r.status_code in (200, 201), r.text
    return r.json()


def job_request(video_id: str, truth: synth.GroundTruth, **opts: object) -> dict:
    return {"videoId": video_id, "junction": truth.junction, "params": {"lanes": 1}, "options": opts}


def wait_job(client: TestClient, job_id: str, timeout: float = 240.0, until: tuple[str, ...] = ("done", "error", "cancelled")) -> dict:
    end = time.time() + timeout
    last: dict = {}
    while time.time() < end:
        last = client.get(f"/v1/jobs/{job_id}").json()
        if last["state"] in until:
            return last
        time.sleep(0.25)
    raise AssertionError(f"job did not finish: {json.dumps(last)[:300]}")
