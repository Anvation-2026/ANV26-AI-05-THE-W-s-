"""From tracked boxes to traffic measurements: counts at lines, queues, speeds, waits, departures.

Every rule here is written down in docs/PERCEPTION.md and each has a test against synthetic video with known truth.

Conventions
- Positions are the bottom-centre of the box, in pixels of the original (rotated) frame.
- An approach has a travel direction, from its upstream line (or queue zone) towards its stop line.
- A line is crossed once per track, in that direction only. The crossing has to hold for two observations
  at least 2 px past the line, and the track needs at least 3 observations, so jitter and flicker do not count.
- A vehicle is queued when its bottom-centre is inside the queue zone and it has been slower than 1 m/s for
  more than 2 s. Without calibration the speed limit is 0.15 box heights per second instead.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from ..models.contracts import APPROACHES, Approach, Params, VehicleClass
from .geometry import ApproachGeo, Homography, along, line_extent_ok, mid, point_in_polygon
from .tracker import Tracked

HYST_PX = 2.0
HYST_OBS = 2
MIN_OBS = 3
SPEED_WINDOW_S = 1.0
CROSS_SPEED_WINDOW_S = 0.6  # shorter, so the speed read at the line is not dragged back by acceleration
STATIONARY_MS = 1.0
MOVING_MS = 1.5
STATIONARY_REL = 0.15  # box heights per second, used when there is no calibration
MOVING_REL = 0.22
QUEUE_MIN_S = 2.0
ONSET_LAG_S = 0.5  # the speed window lags the true start by about half its length
REACTION_S = 1.0  # time from the lamp turning green to the first vehicle moving
MAX_KMH = 130.0


@dataclass
class Obs:
    t: float
    bx: float
    by: float
    h: float
    wx: float
    wy: float


@dataclass
class LineState:
    side: int = 0  # -1 before the line, +1 past it, 0 not decided yet
    run_side: int = 0
    run_n: int = 0
    last_neg_t: float | None = None
    last_neg_s: float = 0.0
    counted: bool = False


@dataclass
class TrackState:
    id: int
    first_t: float
    last_t: float
    n_obs: int = 0
    window: deque[Obs] = field(default_factory=lambda: deque(maxlen=40))
    lines: dict[tuple[int, str], LineState] = field(default_factory=dict)
    stationary_since: float | None = None
    queued_ap: int | None = None
    wait_start: float | None = None
    crossed_stop: bool = False
    crossed_up: bool = False
    first_xy: tuple[float, float] = (0.0, 0.0)
    last_xy: tuple[float, float] = (0.0, 0.0)
    conf_sum: float = 0.0
    cls: VehicleClass = "car"


@dataclass
class CountRec:
    t: float
    ap: int
    line: str
    track: int


@dataclass
class DepartureRec:
    t: float
    ap: int
    track: int
    sat: bool


@dataclass
class SpeedRec:
    t: float
    ap: int
    track: int
    kmh: float


@dataclass
class OnsetRec:
    t: float
    ap: int
    track: int


@dataclass
class AnalysisOutput:
    counts: list[CountRec]
    departures: list[DepartureRec]
    speeds: list[SpeedRec]
    waits: list[tuple[float, int]]  # (seconds, approach index)
    onsets: list[OnsetRec]
    queue_veh: dict[Approach, list[int]]
    queue_pcu: dict[Approach, list[float]]
    tracks: dict[int, TrackState]
    dropped_speeds: int
    mean_conf: float
    n_detections: int


class Analyzer:
    def __init__(self, approaches: list[ApproachGeo], homography: Homography | None, params: Params, duration_s: float) -> None:
        self.aps = approaches
        self.hg = homography
        self.params = params
        self.tracks: dict[int, TrackState] = {}
        self.counts: list[CountRec] = []
        self.departures: list[DepartureRec] = []
        self.speeds: list[SpeedRec] = []
        self.waits: list[tuple[float, int]] = []
        self.onsets: list[OnsetRec] = []
        self.dropped_speeds = 0
        self.bins = max(1, int(math.ceil(duration_s)))
        self.qveh: dict[Approach, list[int]] = {a: [0] * self.bins for a in APPROACHES}
        self.qpcu: dict[Approach, list[float]] = {a: [0.0] * self.bins for a in APPROACHES}
        self._seen_bin: set[int] = set()
        self._conf_sum = 0.0
        self._n_det = 0
        self._pos_this_frame: dict[int, tuple[float, float]] = {}
        self._cls_pcu = {c: s.pcu for c, s in params.classes.items()}

    # ------------------------------------------------------------------ speed
    def _speed(self, st: TrackState, window_s: float = SPEED_WINDOW_S) -> float | None:
        """Speed from a least-squares line through the last second. Metres per second, or box heights per second."""
        w = st.window
        if len(w) < 3:
            return None
        t_end = w[-1].t
        pts = [o for o in w if o.t >= t_end - window_s]
        if len(pts) < 3 or pts[-1].t - pts[0].t < min(0.4, window_s * 0.6):
            return None
        n = len(pts)
        mt = sum(o.t for o in pts) / n
        stt = sum((o.t - mt) ** 2 for o in pts)
        if stt <= 0:
            return None
        if self.hg is not None:
            xs = [o.wx for o in pts]
            ys = [o.wy for o in pts]
            if not all(math.isfinite(v) for v in xs + ys):
                return None
            sx = sum((o.t - mt) * (x - sum(xs) / n) for o, x in zip(pts, xs, strict=True)) / stt
            sy = sum((o.t - mt) * (y - sum(ys) / n) for o, y in zip(pts, ys, strict=True)) / stt
            return math.hypot(sx, sy)
        mx = sum(o.bx for o in pts) / n
        my = sum(o.by for o in pts) / n
        sx = sum((o.t - mt) * (o.bx - mx) for o in pts) / stt
        sy = sum((o.t - mt) * (o.by - my) for o in pts) / stt
        hh = sum(o.h for o in pts) / n
        return math.hypot(sx, sy) / max(hh, 1.0)

    # ------------------------------------------------------------------ one frame
    def update(self, t: float, tracked: list[Tracked]) -> None:
        self._pos_this_frame = {}
        live: list[tuple[TrackState, Tracked, float, float]] = []
        for tr in tracked:
            bx = (tr.x1 + tr.x2) / 2.0
            by = tr.y2
            st = self.tracks.get(tr.id)
            if st is None:
                st = TrackState(tr.id, t, t, first_xy=(bx, by))
                self.tracks[tr.id] = st
            wx = wy = math.nan
            if self.hg is not None:
                wx, wy = self.hg.to_world(bx, by)
            st.window.append(Obs(t, bx, by, max(1.0, tr.y2 - tr.y1), wx, wy))
            st.n_obs += 1
            st.last_t = t
            st.last_xy = (bx, by)
            st.conf_sum += tr.conf
            st.cls = tr.cls
            self._conf_sum += tr.conf
            self._n_det += 1
            self._pos_this_frame[tr.id] = (bx, by)
            live.append((st, tr, bx, by))

        for st, tr, bx, by in live:
            self._lines(st, tr, bx, by, t)
        for st, tr, bx, by in live:
            self._queue_state(st, tr, bx, by, t)
        self._sample_queue(t)

    # ------------------------------------------------------------------ crossings
    def _lines(self, st: TrackState, tr: Tracked, bx: float, by: float, t: float) -> None:
        for ap in self.aps:
            for name, line in (("upstream", ap.upstream), ("stop", ap.stop)):
                if line is None:
                    continue
                ls = st.lines.setdefault((ap.index, name), LineState())
                if ls.counted:
                    continue
                s = along(line, ap.inbound, (bx, by))
                side = -1 if s <= -HYST_PX else (1 if s >= HYST_PX else 0)
                if s < 0:
                    ls.last_neg_t, ls.last_neg_s = t, s
                if side == 0:
                    continue
                if side == ls.run_side:
                    ls.run_n += 1
                else:
                    ls.run_side, ls.run_n = side, 1
                if ls.run_n < HYST_OBS:
                    continue
                prev = ls.side
                ls.side = side
                if prev == -1 and side == 1 and st.n_obs >= MIN_OBS and line_extent_ok(line, (bx, by)):
                    ls.counted = True
                    t_cross = self._cross_time(st, ls, line, ap, t)
                    self._on_cross(st, tr, ap, name, t_cross, t)

    def _cross_time(self, st: TrackState, ls: LineState, line, ap: ApproachGeo, t_now: float) -> float:  # type: ignore[no-untyped-def]
        """Interpolate when the bottom-centre met the line, between the last observation before it and the first after."""
        if ls.last_neg_t is None:
            return t_now
        t_a, s_a = ls.last_neg_t, ls.last_neg_s
        t_b = None
        s_b = 0.0
        for o in st.window:
            if o.t > t_a:
                s_o = along(line, ap.inbound, (o.bx, o.by))
                if s_o >= 0:
                    t_b, s_b = o.t, s_o
                    break
        if t_b is None or s_b - s_a <= 0:
            return t_now
        return t_a + (0.0 - s_a) / (s_b - s_a) * (t_b - t_a)

    def _on_cross(self, st: TrackState, tr: Tracked, ap: ApproachGeo, name: str, t_cross: float, t_now: float) -> None:
        self.counts.append(CountRec(t_cross, ap.index, name, st.id))
        if name == "upstream":
            st.crossed_up = True
            return
        st.crossed_stop = True
        sat = False
        if ap.zone:
            for tid, p in self._pos_this_frame.items():
                if tid != st.id and point_in_polygon(p, ap.zone):
                    sat = True
                    break
        self.departures.append(DepartureRec(t_cross, ap.index, st.id, sat))
        if st.wait_start is not None and st.queued_ap == ap.index:
            self.waits.append((max(0.0, t_cross - st.wait_start), ap.index))
        v = self._speed(st, CROSS_SPEED_WINDOW_S)
        if v is not None and self.hg is not None:
            kmh = v * 3.6
            if 0.0 <= kmh <= MAX_KMH:
                self.speeds.append(SpeedRec(t_cross, ap.index, st.id, kmh))
            else:
                self.dropped_speeds += 1

    # ------------------------------------------------------------------ queue
    def _queue_state(self, st: TrackState, tr: Tracked, bx: float, by: float, t: float) -> None:
        v = self._speed(st)
        if v is None:
            return
        stat_thr = STATIONARY_MS if self.hg is not None else STATIONARY_REL
        move_thr = MOVING_MS if self.hg is not None else MOVING_REL
        in_zone_ap = -1
        for ap in self.aps:
            if ap.zone and point_in_polygon((bx, by), ap.zone):
                in_zone_ap = ap.index
                break
        if v < stat_thr:
            if st.stationary_since is None:
                st.stationary_since = max(st.first_t, t - ONSET_LAG_S)
        elif v >= move_thr:
            if st.queued_ap is not None and st.stationary_since is not None and not st.crossed_stop:
                self.onsets.append(OnsetRec(max(st.stationary_since, t - ONSET_LAG_S - 0.5), st.queued_ap, st.id))
            st.stationary_since = None
            # queued_ap and wait_start stay set: the vehicle has left the zone by the time its stop-line crossing is confirmed
        if in_zone_ap >= 0 and st.stationary_since is not None and t - st.stationary_since > QUEUE_MIN_S and st.queued_ap is None:
            st.queued_ap = in_zone_ap
            st.wait_start = st.stationary_since

    def _is_queued_now(self, st: TrackState, ap_index: int, bx: float, by: float, t: float) -> bool:
        ap = self.aps_by_index(ap_index)
        if ap is None or not ap.zone or st.stationary_since is None:
            return False
        return t - st.stationary_since > QUEUE_MIN_S and point_in_polygon((bx, by), ap.zone)

    def aps_by_index(self, i: int) -> ApproachGeo | None:
        for a in self.aps:
            if a.index == i:
                return a
        return None

    def _sample_queue(self, t: float) -> None:
        b = min(self.bins - 1, max(0, int(math.floor(t))))
        counts = {a.index: 0 for a in self.aps}
        pcu = {a.index: 0.0 for a in self.aps}
        for tid, (bx, by) in self._pos_this_frame.items():
            st = self.tracks[tid]
            for ap in self.aps:
                if ap.zone and self._is_queued_now(st, ap.index, bx, by, t):
                    counts[ap.index] += 1
                    pcu[ap.index] += self._cls_pcu.get(self._vote_cls(st), 1.0)
                    break
        for ap in self.aps:
            self.qveh[ap.name][b] = counts[ap.index]
            self.qpcu[ap.name][b] = round(pcu[ap.index], 3)
        self._seen_bin.add(b)

    def _vote_cls(self, st: TrackState) -> VehicleClass:
        return st.cls

    # ------------------------------------------------------------------ done
    def finish(self) -> AnalysisOutput:
        # carry the last value forward through seconds that had no frame
        last = -1
        for b in range(self.bins):
            if b in self._seen_bin:
                last = b
            elif last >= 0:
                for a in APPROACHES:
                    self.qveh[a][b] = self.qveh[a][last]
                    self.qpcu[a][b] = self.qpcu[a][last]
        mean_conf = self._conf_sum / self._n_det if self._n_det else 0.0
        return AnalysisOutput(
            counts=sorted(self.counts, key=lambda c: (c.t, c.ap, c.track)),
            departures=sorted(self.departures, key=lambda d: (d.t, d.ap, d.track)),
            speeds=sorted(self.speeds, key=lambda s: (s.t, s.ap, s.track)),
            waits=self.waits,
            onsets=sorted(self.onsets, key=lambda o: (o.t, o.ap, o.track)),
            queue_veh=self.qveh,
            queue_pcu=self.qpcu,
            tracks=self.tracks,
            dropped_speeds=self.dropped_speeds,
            mean_conf=mean_conf,
            n_detections=self._n_det,
        )


def green_starts_from_onsets(onsets: list[OnsetRec], four_phase: bool, gap_s: float = 6.0) -> list[tuple[float, int]]:
    """Infer when each phase turned green: the first queued vehicle starting to move, minus the driver reaction time.

    Onsets of one approach that are close together belong to the same green. Approaches of one phase that start
    within 4 s of each other are merged.
    """
    phases = [[0], [1], [2], [3]] if four_phase else [[0, 1], [2, 3]]
    phase_of = {ap: pi for pi, aps in enumerate(phases) for ap in aps}
    per_ap: dict[int, list[float]] = {}
    for o in onsets:
        per_ap.setdefault(o.ap, []).append(o.t)
    starts: list[tuple[float, int]] = []
    for ap, times in per_ap.items():
        times.sort()
        cluster_start = times[0]
        prev = times[0]
        for x in times[1:]:
            if x - prev > gap_s:
                starts.append((cluster_start - REACTION_S, phase_of[ap]))
                cluster_start = x
            prev = x
        starts.append((cluster_start - REACTION_S, phase_of[ap]))
    starts.sort()
    merged: list[tuple[float, int]] = []
    for t, p in starts:
        if merged and merged[-1][1] == p and t - merged[-1][0] <= 4.0:
            continue
        merged.append((max(0.0, t), p))
    return merged


__all__ = ["Analyzer", "AnalysisOutput", "green_starts_from_onsets", "mid"]
