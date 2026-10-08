"""Junction geometry: validation, calibration (pixels to metres), and line and zone tests.

All coordinates are pixels of the original video frame (after rotation), the same space the front end draws in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .. import errors
from ..models.contracts import APPROACHES, Approach, Calibration, Geometry, JunctionConfig, Line, Point

Vec = tuple[float, float]


def _xy(p: Point) -> Vec:
    return (float(p.x), float(p.y))


def mid(line: Line) -> Vec:
    return ((line.a.x + line.b.x) / 2.0, (line.a.y + line.b.y) / 2.0)


def seg_len(line: Line) -> float:
    return math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)


def polygon_area(poly: list[Vec]) -> float:
    s = 0.0
    for i, (x1, y1) in enumerate(poly):
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def point_in_polygon(p: Vec, poly: list[Vec]) -> bool:
    x, y = p
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# --------------------------------------------------------------------------- calibration


class Homography:
    """Maps a pixel to metres on the road plane."""

    def __init__(self, matrix: np.ndarray, width_m: float, height_m: float) -> None:
        self.m = matrix
        self.width_m = width_m
        self.height_m = height_m

    def to_world(self, x: float, y: float) -> Vec:
        v = self.m @ np.array([x, y, 1.0])
        if abs(v[2]) < 1e-12:
            return (math.nan, math.nan)
        return (float(v[0] / v[2]), float(v[1] / v[2]))

    def to_world_many(self, pts: np.ndarray) -> np.ndarray:
        """pts: (n, 2) pixels to (n, 2) metres."""
        if len(pts) == 0:
            return pts.reshape(0, 2)
        h = np.concatenate([pts, np.ones((len(pts), 1))], axis=1) @ self.m.T
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.asarray(h[:, :2] / h[:, 2:3])


def _cross(o: Vec, a: Vec, b: Vec) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def build_homography(cal: Calibration) -> Homography:
    """Validate the four points and distances, and build the pixel to metre map.

    The points are the corners of a real rectangle on the road, in order, with distances for
    p0-p1, p1-p2, p2-p3 and p3-p0. Opposite sides should agree; a 15 percent mismatch is allowed.
    """
    d = [float(x) for x in cal.distances]
    if any((not math.isfinite(x)) or x <= 0 for x in d):
        raise errors.calibration_invalid("Every distance must be greater than zero.")
    pts = [_xy(p) for p in cal.points]
    if len({(round(x, 1), round(y, 1)) for x, y in pts}) < 4:
        raise errors.calibration_invalid("Two of the four points are in the same place.")
    signs = [_cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]) for i in range(4)]
    if any(abs(s) < 1.0 for s in signs):
        raise errors.calibration_invalid("Three of the four points lie on one straight line.")
    if not (all(s > 0 for s in signs) or all(s < 0 for s in signs)):
        raise errors.calibration_invalid("The four points cross over each other. Mark the corners in order around the rectangle.")
    for a, b, label in ((d[0], d[2], "top and bottom"), (d[1], d[3], "left and right")):
        if abs(a - b) / max(a, b) > 0.15:
            raise errors.calibration_invalid(f"The {label} distances differ by more than 15 percent ({a:g} m and {b:g} m). Measure them again.")
    w = (d[0] + d[2]) / 2.0
    h = (d[1] + d[3]) / 2.0
    src = np.array(pts, dtype=np.float64)
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float64)
    m = cv2.getPerspectiveTransform(src.astype(np.float32), dst.astype(np.float32))
    m = np.asarray(m, dtype=np.float64)
    if not np.all(np.isfinite(m)):
        raise errors.calibration_invalid("The points do not give a usable scale.")
    return Homography(m, w, h)


def metres_per_pixel_near(hg: Homography, x: float, y: float) -> float:
    """Local scale, for translating pixel thresholds into metres."""
    a = hg.to_world(x, y)
    b = hg.to_world(x + 1.0, y)
    c = hg.to_world(x, y + 1.0)
    sx = math.hypot(b[0] - a[0], b[1] - a[1])
    sy = math.hypot(c[0] - a[0], c[1] - a[1])
    return (sx + sy) / 2.0


# --------------------------------------------------------------------------- per approach geometry


@dataclass
class ApproachGeo:
    """Everything the analysis needs to know about one approach."""

    name: Approach
    index: int
    stop: Line | None
    upstream: Line | None
    zone: list[Vec] | None
    inbound: Vec  # unit vector pointing from upstream towards the stop line (direction of travel)
    inbound_source: str  # "lines" | "zone" | "none"


def _unit(v: Vec) -> Vec:
    n = math.hypot(v[0], v[1])
    return (v[0] / n, v[1] / n) if n > 1e-9 else (0.0, 0.0)


def _centroid(poly: list[Vec]) -> Vec:
    return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))


def build_approaches(g: Geometry) -> list[ApproachGeo]:
    out: list[ApproachGeo] = []
    for i, a in enumerate(APPROACHES):
        stop = g.stopLines.get(a)
        up = g.upstreamLines.get(a)
        zpts = g.queueZones.get(a)
        zone = [_xy(p) for p in zpts] if zpts and len(zpts) >= 3 else None
        inbound: Vec = (0.0, 0.0)
        src = "none"
        if stop and up and math.dist(mid(stop), mid(up)) > 1.0:
            sm, um = mid(stop), mid(up)
            inbound = _unit((sm[0] - um[0], sm[1] - um[1]))
            src = "lines"
        elif stop and zone:
            sm, zc = mid(stop), _centroid(zone)
            if math.dist(sm, zc) > 1.0:
                inbound = _unit((sm[0] - zc[0], sm[1] - zc[1]))
                src = "zone"
        out.append(ApproachGeo(a, i, stop, up, zone, inbound, src))
    return out


def validate_geometry(g: Geometry, frame_w: float, frame_h: float) -> list[ApproachGeo]:
    """Raise geometry_incomplete if the drawing cannot support counting. Returns the usable approaches."""
    aps = build_approaches(g)
    missing: list[dict[str, str]] = []
    usable = 0
    for ap in aps:
        have_any = ap.stop or ap.upstream or ap.zone
        if not have_any:
            continue
        if not ap.stop:
            missing.append({"approach": ap.name, "shape": "stop line"})
        if ap.inbound_source == "none":
            missing.append({"approach": ap.name, "shape": "upstream line or queue zone"})
        if ap.stop and ap.inbound_source != "none":
            usable += 1
    if usable < 2:
        if not any(a.stop or a.upstream or a.zone for a in aps):
            for a in APPROACHES[:2]:
                missing.append({"approach": a, "shape": "stop line"})
        raise errors.geometry_incomplete(missing or [{"approach": "second", "shape": "approach"}])
    for ap in aps:
        for line in (ap.stop, ap.upstream):
            if line is None:
                continue
            if seg_len(line) < 2.0:
                raise errors.junction_invalid(f"The {ap.name} line is shorter than 2 pixels. Draw it again.")
            for p in (line.a, line.b):
                if not (-0.5 * frame_w <= p.x <= 1.5 * frame_w and -0.5 * frame_h <= p.y <= 1.5 * frame_h):
                    raise errors.junction_invalid(f"A {ap.name} line lies far outside the video picture. Draw the junction on the video frame.")
        if ap.zone and polygon_area(ap.zone) < 4.0:
            raise errors.junction_invalid(f"The {ap.name} queue zone has almost no area. Draw it again.")
    return [a for a in aps if a.stop and a.inbound_source != "none"]


def geometry_notes(g: Geometry) -> list[str]:
    """Plain-language notes about approaches that are drawn only partly and so are ignored."""
    notes: list[str] = []
    for ap in build_approaches(g):
        if not (ap.stop or ap.upstream or ap.zone):
            continue
        if not ap.stop:
            notes.append(f"{ap.name} has no stop line, so it was left out of the analysis.")
        elif ap.inbound_source == "none":
            notes.append(f"{ap.name} has a stop line but no upstream line or queue zone, so its direction of travel is unknown and it was left out.")
        elif ap.upstream is None:
            notes.append(f"{ap.name} has no upstream line, so its arrivals are not counted. Draw one for better demand estimates.")
        if ap.stop and ap.zone is None:
            notes.append(f"{ap.name} has no queue zone, so its queue and waiting time are not measured.")
    return notes


def validate_junction(j: JunctionConfig, frame_w: float, frame_h: float) -> tuple[list[ApproachGeo], Homography | None]:
    approaches = validate_geometry(j.geometry, frame_w, frame_h)
    hg = build_homography(j.calibration) if j.calibration else None
    return approaches, hg


# --------------------------------------------------------------------------- crossing tests


def along(line: Line, inbound: Vec, p: Vec) -> float:
    """Signed distance of p from the line in the direction of travel. Negative = before the line."""
    m = mid(line)
    return (p[0] - m[0]) * inbound[0] + (p[1] - m[1]) * inbound[1]


def lateral_fraction(line: Line, p: Vec) -> float:
    """Where p projects along the line: 0 at a, 1 at b."""
    dx, dy = line.b.x - line.a.x, line.b.y - line.a.y
    n2 = dx * dx + dy * dy
    return ((p[0] - line.a.x) * dx + (p[1] - line.a.y) * dy) / n2 if n2 > 0 else 0.5


def line_extent_ok(line: Line, p: Vec, margin: float = 0.35) -> bool:
    f = lateral_fraction(line, p)
    return -margin <= f <= 1.0 + margin
