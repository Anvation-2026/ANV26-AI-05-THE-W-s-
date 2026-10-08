"""Follows a moving camera so that fixed lines stay on the road.

Corners of the picture are tracked from one frame to the next with optical flow. The median movement of those corners is the
camera's movement, because the road, kerbs and buildings outnumber the vehicles. Areas where vehicles were detected are left out
when picking corners. The movements are added up, so the result is how far the picture has moved since the first frame, in
pixels. Detections are shifted back by that amount before they are tested against the lines.

Limits: it follows sideways and up-and-down movement only, not zoom or tilt, and small errors add up slowly over a long clip.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import cv2
import numpy as np

MAX_W = 640  # work on a copy no wider than this
MIN_POINTS = 12  # fewer tracked corners than this and the frame is skipped (the last movement is kept)
DEAD_ZONE_PX = 0.4  # smaller total shifts are noise, not motion


class CameraTracker:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self._prev: np.ndarray | None = None
        self._scale = 1.0
        self._x = 0.0
        self._y = 0.0
        self.history: list[float] = []

    def update(self, image: np.ndarray, vehicle_boxes: Sequence[tuple[float, float, float, float]] = ()) -> tuple[float, float]:
        """How far this frame has moved from the first, in pixels of `image`.

        `vehicle_boxes` are the (x1, y1, x2, y2) boxes found in the previous frame, in pixels of `image`; corners inside them are ignored.
        """
        h, w = image.shape[:2]
        s = min(1.0, MAX_W / w)
        g = cv2.cvtColor(cv2.resize(image, (max(2, round(w * s)), max(2, round(h * s))), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if self._prev is not None and self._prev.shape == g.shape:
            mask = np.full(g.shape, 255, np.uint8)
            for x1, y1, x2, y2 in vehicle_boxes:
                pad = 3
                cv2.rectangle(mask, (int(x1 * s) - pad, int(y1 * s) - pad), (int(x2 * s) + pad, int(y2 * s) + pad), 0, -1)
            pts = cv2.goodFeaturesToTrack(self._prev, maxCorners=300, qualityLevel=0.01, minDistance=8, mask=mask)
            if pts is not None and len(pts) >= MIN_POINTS:
                new, status, _ = cv2.calcOpticalFlowPyrLK(self._prev, g, pts, None, winSize=(21, 21), maxLevel=3)  # type: ignore[call-overload]
                if new is not None and status is not None:
                    good = status.reshape(-1) == 1
                    if int(good.sum()) >= MIN_POINTS:
                        d = (new.reshape(-1, 2)[good] - pts.reshape(-1, 2)[good])
                        med = np.median(d, axis=0)
                        # corners that move with the camera agree with the median; the rest are vehicles or bad matches
                        keep = np.hypot(*(d - med).T) < 1.5
                        if int(keep.sum()) >= MIN_POINTS:
                            med = np.median(d[keep], axis=0)
                        # the picture moving by +d means the camera moved by -d, but we report how far the picture moved
                        self._x += float(med[0]) / s
                        self._y += float(med[1]) / s
        self._prev = g
        dx, dy = self._x, self._y
        if math.hypot(dx, dy) < DEAD_ZONE_PX:
            dx, dy = 0.0, 0.0
        self.history.append(math.hypot(dx, dy))
        return (dx, dy) if self.enabled else (0.0, 0.0)

    def p95(self) -> float:
        return float(np.percentile(self.history, 95)) if self.history else 0.0
