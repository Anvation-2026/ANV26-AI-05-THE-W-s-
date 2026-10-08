"""Multi-object tracking with ByteTrack (from the `supervision` package)."""

from __future__ import annotations

import warnings
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from ..models.contracts import VEHICLE_CLASSES, VehicleClass
from .detector import RawDet


@dataclass(frozen=True)
class Tracked:
    id: int
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float
    cls: VehicleClass  # the class this track has been given most weight for so far


class Tracker:
    """Wraps ByteTrack and keeps one stable class per track by confidence-weighted vote.

    Track ids are small integers that restart for every video, so results are repeatable.
    """

    def __init__(
        self, fps: float, activation: float = 0.35, lost_buffer_s: float = 2.0, match_threshold: float = 0.8, pad: float = 1.8
    ) -> None:
        self.pad = pad  # boxes are enlarged by this factor for matching only, so small fast boxes still overlap between frames
        import supervision as sv

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)  # ByteTrack is deprecated in supervision 0.28+, pinned below 0.31
            self._bt = sv.ByteTrack(
                track_activation_threshold=activation,
                lost_track_buffer=max(5, int(round(lost_buffer_s * fps))),
                minimum_matching_threshold=match_threshold,
                frame_rate=max(1, int(round(fps))),
                minimum_consecutive_frames=1,
            )
        self._sv = sv
        self._votes: dict[int, dict[VehicleClass, float]] = defaultdict(lambda: defaultdict(float))

    def update(self, dets: list[RawDet]) -> list[Tracked]:
        sv = self._sv
        if dets:
            xyxy = np.array([self._grow(d) for d in dets], dtype=np.float32)
            conf = np.array([d.conf for d in dets], dtype=np.float32)
            cid = np.array([VEHICLE_CLASSES.index(d.cls) for d in dets], dtype=int)
            sd = sv.Detections(xyxy=xyxy, confidence=conf, class_id=cid)
        else:
            sd = sv.Detections.empty()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            out = self._bt.update_with_detections(sd)
        res: list[Tracked] = []
        if out.tracker_id is None or len(out) == 0:
            return res
        for i in range(len(out)):
            tid = int(out.tracker_id[i])
            cls = VEHICLE_CLASSES[int(out.class_id[i])] if out.class_id is not None else "car"
            conf_i = float(out.confidence[i]) if out.confidence is not None else 0.5
            votes = self._votes[tid]
            votes[cls] += conf_i
            best = max(VEHICLE_CLASSES, key=lambda c: (votes.get(c, 0.0), -VEHICLE_CLASSES.index(c)))
            x1, y1, x2, y2 = self._shrink(tuple(float(v) for v in out.xyxy[i]))
            res.append(Tracked(tid, x1, y1, x2, y2, conf_i, best))
        res.sort(key=lambda t: t.id)
        return res

    def _grow(self, d: RawDet) -> list[float]:
        if self.pad == 1.0:
            return [d.x1, d.y1, d.x2, d.y2]
        cx, cy, hw, hh = (d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, (d.x2 - d.x1) / 2 * self.pad, (d.y2 - d.y1) / 2 * self.pad
        return [cx - hw, cy - hh, cx + hw, cy + hh]

    def _shrink(self, b: tuple[float, ...]) -> tuple[float, float, float, float]:
        if self.pad == 1.0:
            return (b[0], b[1], b[2], b[3])
        cx, cy, hw, hh = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[2] - b[0]) / 2 / self.pad, (b[3] - b[1]) / 2 / self.pad
        return (cx - hw, cy - hh, cx + hw, cy + hh)

    def final_class(self, track_id: int) -> VehicleClass | None:
        votes = self._votes.get(track_id)
        if not votes:
            return None
        return max(VEHICLE_CLASSES, key=lambda c: (votes.get(c, 0.0), -VEHICLE_CLASSES.index(c)))
