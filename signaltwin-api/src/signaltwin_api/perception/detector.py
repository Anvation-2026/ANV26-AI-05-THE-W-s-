"""Vehicle detectors behind one small interface, so the model can be swapped without touching the pipeline."""

from __future__ import annotations

import hashlib
import logging
import random
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import cv2
import numpy as np

from .. import errors
from ..config import Settings
from ..models.contracts import VEHICLE_CLASSES, VehicleClass

log = logging.getLogger("signaltwin.detector")


@dataclass(frozen=True)
class RawDet:
    """One detection in processing-image pixels."""

    x1: float
    y1: float
    x2: float
    y2: float
    conf: float
    cls: VehicleClass


@dataclass(frozen=True)
class DetectorInfo:
    name: str
    version: str
    sha256: str
    device: str
    maps_auto_rickshaw: bool  # whether the model can tell auto-rickshaws from cars


class Detector(Protocol):
    info: DetectorInfo

    def detect(self, image: np.ndarray, t: float, frame_index: int) -> list[RawDet]: ...

    def close(self) -> None: ...


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- YOLO

# COCO ids of vehicles we care about. Auto-rickshaws have no COCO class: with the stock model they are
# reported as cars (or motorcycles), and the quality report says so.
_COCO_TO_CLASS: dict[int, VehicleClass] = {1: "twoWheeler", 2: "car", 3: "twoWheeler", 5: "bus", 7: "truck"}
_NAME_TO_CLASS: dict[str, VehicleClass] = {
    "bicycle": "twoWheeler",
    "motorcycle": "twoWheeler",
    "motorbike": "twoWheeler",
    "two-wheeler": "twoWheeler",
    "twowheeler": "twoWheeler",
    "scooter": "twoWheeler",
    "car": "car",
    "auto": "autoRickshaw",
    "auto-rickshaw": "autoRickshaw",
    "autorickshaw": "autoRickshaw",
    "rickshaw": "autoRickshaw",
    "tuk-tuk": "autoRickshaw",
    "bus": "bus",
    "truck": "truck",
    "lorry": "truck",
    "van": "car",  # VisDrone and similar aerial datasets
    "motor": "twoWheeler",
    "tricycle": "autoRickshaw",
    "awning-tricycle": "autoRickshaw",
}


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda:0"
    except Exception:  # noqa: BLE001 - torch is optional at import time
        pass
    return "cpu"


class YoloDetector:
    """Ultralytics YOLO. Note: Ultralytics is AGPL-3.0. See README for the licence implications."""

    def __init__(self, settings: Settings, weights: str | None = None, confidence: float | None = None) -> None:
        path_str = weights or settings.model_weights_5class or settings.model_weights
        path = Path(path_str)
        if not path.exists():
            raise errors.model_unavailable(f"The model file {path_str} was not found.")
        try:
            from ultralytics import YOLO  # type: ignore[attr-defined]  # imported late: heavy
        except ImportError as e:  # pragma: no cover - depends on install
            raise errors.model_unavailable("The detection library is not installed (install the 'vision' extra).") from e
        try:
            self.model = YOLO(str(path))
        except Exception as e:  # noqa: BLE001 - any load failure is a model problem for the user
            raise errors.model_unavailable(f"The model file {path_str} could not be loaded.") from e
        self.device = resolve_device(settings.device)
        self.conf = confidence if confidence is not None else settings.confidence
        self.iou = settings.iou
        names = getattr(self.model, "names", {}) or {}
        self.class_map: dict[int, VehicleClass] = {}
        for idx, name in names.items():
            mapped = _NAME_TO_CLASS.get(str(name).lower().replace("_", "-"))
            if mapped is None:
                mapped = _COCO_TO_CLASS.get(int(idx)) if len(names) >= 80 else None
            if mapped is not None:
                self.class_map[int(idx)] = mapped
        if not self.class_map:
            raise errors.model_unavailable("The model does not detect any vehicle classes.")
        self.info = DetectorInfo(
            name=path.stem,
            version=getattr(__import__("ultralytics"), "__version__", "unknown"),
            sha256=file_sha256(path),
            device=self.device,
            maps_auto_rickshaw="autoRickshaw" in self.class_map.values(),
        )

    def detect(self, image: np.ndarray, t: float, frame_index: int) -> list[RawDet]:
        results: Any = self.model.predict(
            image,
            conf=self.conf,
            iou=self.iou,
            classes=list(self.class_map.keys()),
            device=self.device,
            verbose=False,
            imgsz=max(320, min(1280, int(max(image.shape[:2]) // 32 * 32))),
        )
        res = results[0]
        out: list[RawDet] = []
        boxes = res.boxes
        if boxes is None or len(boxes) == 0:
            return out
        xyxy = boxes.xyxy.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
        cls = boxes.cls.cpu().numpy().astype(int)
        for (x1, y1, x2, y2), c, k in zip(xyxy, conf, cls, strict=True):
            mapped = self.class_map.get(int(k))
            if mapped is None or x2 - x1 < 2 or y2 - y1 < 2:
                continue
            out.append(RawDet(float(x1), float(y1), float(x2), float(y2), float(c), mapped))
        return out

    def close(self) -> None:
        self.model = None  # type: ignore[assignment]


# --------------------------------------------------------------------------- test doubles


class ScriptedDetector:
    """Returns detections computed by a function of time. Used to test the rest of the pipeline exactly.

    `source(t, frame_index)` gives ground-truth boxes; `miss_rate` drops some of them and `jitter_px` moves
    the rest, both from a seeded generator so a run is repeatable.
    """

    def __init__(
        self,
        source: Callable[[float, int], list[RawDet]],
        *,
        miss_rate: float = 0.0,
        jitter_px: float = 0.0,
        seed: int = 1,
        name: str = "scripted",
    ) -> None:
        self.source = source
        self.miss_rate = miss_rate
        self.jitter_px = jitter_px
        self.rng = random.Random(seed)
        self.info = DetectorInfo(name, "1", hashlib.sha256(name.encode()).hexdigest(), "cpu", True)

    def detect(self, image: np.ndarray, t: float, frame_index: int) -> list[RawDet]:
        out: list[RawDet] = []
        for d in self.source(t, frame_index):
            if self.miss_rate > 0 and self.rng.random() < self.miss_rate:
                continue
            if self.jitter_px > 0:
                j = self.jitter_px
                dx, dy = self.rng.gauss(0, j), self.rng.gauss(0, j)
                d = RawDet(d.x1 + dx, d.y1 + dy, d.x2 + dx, d.y2 + dy, d.conf, d.cls)
            out.append(d)
        return out

    def close(self) -> None:
        return None


# Colours the synthetic test videos paint vehicles with (BGR), one per class.
SYNTH_COLOURS: dict[VehicleClass, tuple[int, int, int]] = {
    "twoWheeler": (40, 200, 255),
    "car": (60, 200, 60),
    "autoRickshaw": (200, 120, 40),
    "bus": (40, 40, 230),
    "truck": (220, 60, 200),
}


class SyntheticDetector:
    """Finds the coloured rectangles painted by scripts/make_test_video.py. It reads the pixels, so a test
    through it exercises decoding, scaling, tracking and counting for real. It is not a vehicle detector."""

    def __init__(self, min_area: float = 16.0, hue_tolerance: int = 10, min_saturation: int = 90) -> None:
        self.min_area = min_area
        self.min_sat = min_saturation
        self.tol = hue_tolerance
        self.info = DetectorInfo("synthetic-blobs", "1", hashlib.sha256(b"synthetic-blobs").hexdigest(), "cpu", True)
        # match on hue and saturation: video compression blurs the colour of small objects towards grey but keeps the hue
        self._hue = {c: int(cv2.cvtColor(np.array([[v]], dtype=np.uint8), cv2.COLOR_BGR2HSV)[0, 0, 0]) for c, v in SYNTH_COLOURS.items()}

    def detect(self, image: np.ndarray, t: float, frame_index: int) -> list[RawDet]:
        out: list[RawDet] = []
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        coloured = (hsv[:, :, 1] >= self.min_sat) & (hsv[:, :, 2] >= 70)
        if not coloured.any():
            return out
        hue = hsv[:, :, 0].astype(np.int16)
        for cls in VEHICLE_CLASSES:
            d = np.abs(hue - self._hue[cls])
            d = np.minimum(d, 180 - d)
            mask = (coloured & (d <= self.tol)).astype(np.uint8)
            if not mask.any():
                continue
            n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
            for i in range(1, n):
                x, y, w, h, area = stats[i]
                if area >= self.min_area:
                    out.append(RawDet(float(x), float(y), float(x + w), float(y + h), 0.9, cls))
        return out

    def close(self) -> None:
        return None


def make_detector(settings: Settings, weights: str | None = None, confidence: float | None = None) -> Detector:
    kind = settings.detector
    if kind == "synthetic":
        return SyntheticDetector()
    if kind == "stub":
        return ScriptedDetector(lambda t, i: [], name="empty-stub")
    return YoloDetector(settings, weights=weights, confidence=confidence)
