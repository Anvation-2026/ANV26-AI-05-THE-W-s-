"""Smoke tests with the real YOLO model. They prove the integration works (weights load, classes map, the pipeline runs);
they are not an accuracy measurement. Run with:  pytest -m real_yolo

Needs the weights in models/yolo11n.pt and a network connection for the one public sample picture (skipped otherwise).
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

import cv2
import numpy as np
import pytest

from signaltwin_api.config import Settings
from signaltwin_api.models.contracts import VEHICLE_CLASSES, JunctionConfig, Params, PerceptionOptions
from signaltwin_api.perception.detector import YoloDetector, file_sha256
from signaltwin_api.perception.pipeline import run_perception
from signaltwin_api.testing import synth
from signaltwin_api.video.probe import probe

pytestmark = pytest.mark.real_yolo

WEIGHTS = Path(__file__).resolve().parents[1] / "models" / "yolo11n.pt"
BUS_URL = "https://ultralytics.com/images/bus.jpg"


@pytest.fixture(scope="module")
def bus_image(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    if not WEIGHTS.exists():
        pytest.skip("models/yolo11n.pt is missing")
    cache = Path(__file__).resolve().parents[1] / "data" / "test-assets"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / "bus.jpg"
    if not path.exists():
        try:
            urllib.request.urlretrieve(BUS_URL, path)  # noqa: S310 - fixed https URL
        except OSError:
            pytest.skip("the sample picture could not be downloaded")
    img = cv2.imread(str(path))
    assert img is not None
    return img


def settings() -> Settings:
    return Settings(model_weights=str(WEIGHTS), device="cpu", detector="yolo", _env_file=None)  # type: ignore[call-arg]


def test_yolo_finds_the_bus_and_ignores_people(bus_image: np.ndarray) -> None:
    det = YoloDetector(settings())
    assert det.info.name == "yolo11n" and det.info.sha256 == file_sha256(WEIGHTS) and det.info.device == "cpu"
    assert det.info.maps_auto_rickshaw is False  # the stock model has no such class, and the quality report says so
    dets = det.detect(bus_image, 0.0, 0)
    assert any(d.cls == "bus" and d.conf > 0.5 for d in dets), dets
    assert {d.cls for d in dets} <= set(VEHICLE_CLASSES)  # the people in the picture are not vehicles
    assert all(0 <= d.x1 < d.x2 <= bus_image.shape[1] + 1 and 0 <= d.y1 < d.y2 <= bus_image.shape[0] + 1 for d in dets)


def test_missing_weights_are_reported_plainly(tmp_path: Path) -> None:
    from signaltwin_api import errors

    with pytest.raises(errors.ApiError) as e:
        YoloDetector(Settings(model_weights=str(tmp_path / "nope.pt"), _env_file=None))  # type: ignore[call-arg]
    assert e.value.code == "model_unavailable" and e.value.status == 503 and e.value.fix


def test_corrupt_weights_are_reported_plainly(tmp_path: Path) -> None:
    from signaltwin_api import errors

    bad = tmp_path / "bad.pt"
    bad.write_bytes(b"this is not a model")
    with pytest.raises(errors.ApiError) as e:
        YoloDetector(Settings(model_weights=str(bad), _env_file=None))  # type: ignore[call-arg]
    assert e.value.code == "model_unavailable"


def test_pipeline_runs_end_to_end_with_the_real_model(bus_image: np.ndarray, tmp_path: Path) -> None:
    import av

    h, w = bus_image.shape[:2]
    w -= w % 2
    h -= h % 2
    path = tmp_path / "bus.mp4"
    c = av.open(str(path), "w")
    s = c.add_stream("libx264", rate=10)
    s.width, s.height, s.pix_fmt = w, h, "yuv420p"
    for _ in range(50):  # five seconds of a still picture
        for pkt in s.encode(av.VideoFrame.from_ndarray(bus_image[:h, :w], format="bgr24")):
            c.mux(pkt)
    for pkt in s.encode():
        c.mux(pkt)
    c.close()
    cfg = settings()
    info = probe(path, cfg)
    junction = JunctionConfig.model_validate(synth.junction_json())
    res = run_perception(path, "v_bus", file_sha256(path), info, junction, Params(), PerceptionOptions(frameSampleS=0.2), YoloDetector(cfg), cfg)
    assert res.meta and res.meta.model.name == "yolo11n" and res.meta.model.sha256 == file_sha256(WEIGHTS)
    assert res.meta.frameCount >= 40
    seen = {d.cls for f in res.frames for d in f.detections}
    assert "bus" in seen, seen
    assert res.quality and any("auto-rickshaw" in x for x in res.quality.warnings)  # the honest model limitation is stated
