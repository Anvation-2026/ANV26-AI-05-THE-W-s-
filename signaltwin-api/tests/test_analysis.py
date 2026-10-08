"""Counting, queue, speed and wait rules, tested on exact ground truth and on hand-built tracks."""

from __future__ import annotations

import collections
import math
import random
from collections.abc import Callable

import pytest

from signaltwin_api.models.contracts import APPROACHES, JunctionConfig, Params
from signaltwin_api.perception.analysis import AnalysisOutput, Analyzer
from signaltwin_api.perception.detector import RawDet
from signaltwin_api.perception.geometry import validate_junction
from signaltwin_api.perception.tracker import Tracked, Tracker
from signaltwin_api.testing import synth

PAD = 1.8  # the pipeline default
JUNCTION = JunctionConfig.model_validate(synth.junction_json())
APS, HG = validate_junction(JUNCTION, 1280, 720)
STOP_Y_N = 270.0  # north stop line, pixels
UP_Y_N = STOP_Y_N - 30 * 6
LANE_X_N = 658.0


def tr(i: int, bx: float, by: float, cls: str = "car", w: float = 10.0, h: float = 25.0) -> Tracked:
    return Tracked(i, bx - w / 2, by - h, bx + w / 2, by, 0.9, cls)  # type: ignore[arg-type]


def run_paths(paths: dict[int, Callable[[float], tuple[float, float] | None]], seconds: float, fps: float = 10.0, hg=HG, params=None) -> AnalysisOutput:
    an = Analyzer(APS, hg, params or Params(lanes=1), seconds + 2)
    for k in range(int(seconds * fps)):
        t = k / fps
        frame = []
        for i, f in paths.items():
            p = f(t)
            if p is not None:
                frame.append(tr(i, *p))
        an.update(t, frame)
    return an.finish()


def north_down(y0: float, v_ms: float, t0: float = 0.0, x: float = LANE_X_N):
    return lambda t: (x, y0 + 6 * v_ms * (t - t0)) if t >= t0 else None


def counts_of(out: AnalysisOutput) -> collections.Counter:
    return collections.Counter((APPROACHES[c.ap], c.line) for c in out.counts)


# ------------------------------------------------------------------ rules on hand-built tracks


def test_a_vehicle_driving_in_is_counted_once_on_each_line() -> None:
    out = run_paths({1: north_down(20, 10)}, 12)
    assert counts_of(out) == {("N", "upstream"): 1, ("N", "stop"): 1}
    up = next(c for c in out.counts if c.line == "upstream")
    assert up.t == pytest.approx((UP_Y_N - 20) / 60, abs=0.06)  # interpolated, not rounded to a frame
    assert len(out.departures) == 1 and out.departures[0].sat is False


def test_driving_the_wrong_way_is_not_counted() -> None:
    out = run_paths({1: lambda t: (LANE_X_N, 400 - 60 * t)}, 6)
    assert counts_of(out) == {}


def test_a_track_born_past_the_line_is_not_counted_there() -> None:
    out = run_paths({1: north_down(UP_Y_N + 40, 10)}, 8)
    assert counts_of(out) == {("N", "stop"): 1}


def test_a_flicker_of_two_observations_is_not_counted() -> None:
    f = lambda t: (LANE_X_N, STOP_Y_N - 10 + 30 * t) if t < 0.2 else None  # noqa: E731 - 2 frames only
    assert counts_of(run_paths({1: f}, 3)) == {}


def test_jitter_around_a_line_does_not_count_and_wobbling_counts_once() -> None:
    rng = random.Random(3)
    jitter = lambda t: (LANE_X_N, STOP_Y_N - 1.2 + rng.uniform(-1.5, 1.5))  # noqa: E731 - sits on the line, wobbles inside 2 px
    assert counts_of(run_paths({1: jitter}, 10)) == {}
    # a vehicle that crawls over the line while wobbling by 4 px goes over once and is counted once
    crawl = lambda t: (LANE_X_N, STOP_Y_N - 30 + 5 * t + 4 * math.sin(t * 9))  # noqa: E731
    assert counts_of(run_paths({1: crawl}, 12)).get(("N", "stop"), 0) == 1


def test_crossing_outside_the_lines_extent_is_ignored() -> None:
    far_left = north_down(20, 10, x=LANE_X_N - 120)  # in the other lane of the road, outside the line's width
    assert counts_of(run_paths({1: far_left}, 12)) == {}


def test_queue_wait_and_saturated_departures() -> None:
    # two vehicles stand in the zone for 12 s, then leave one after the other
    def v1(t: float):
        if t < 3:
            return (LANE_X_N, STOP_Y_N - 12 - 6 * (3 - t) ** 2 * 0.5) if False else (LANE_X_N, STOP_Y_N - 12 - 60 * max(0, 2 - t))
        if t < 15:
            return (LANE_X_N, STOP_Y_N - 12)
        return (LANE_X_N, STOP_Y_N - 12 + 6 * 4 * (t - 15))

    def v2(t: float):
        if t < 15:
            return (LANE_X_N, STOP_Y_N - 12 - 6 * 6) if t > 1 else None
        return (LANE_X_N, STOP_Y_N - 12 - 36 + 6 * 4 * (t - 15)) if t < 17.5 else (LANE_X_N, STOP_Y_N - 12 - 36 + 6 * 4 * 2.5 + 6 * 8 * (t - 17.5))

    out = run_paths({1: v1, 2: v2}, 30)
    assert max(out.queue_veh["N"]) == 2
    assert out.queue_veh["N"][10] == 2 and out.queue_veh["N"][1] == 0 and out.queue_veh["N"][28] == 0
    assert len(out.waits) == 2
    w1 = min(out.waits)[0]
    assert w1 == pytest.approx(15 - 2.0, abs=1.5)  # stationary from about t=2 until it crosses a little after t=15
    deps = sorted(out.departures, key=lambda d: d.t)
    assert deps[0].sat is True  # the second vehicle was still queued when the first left
    assert deps[1].sat is False


def test_queue_works_without_calibration() -> None:
    def v(t: float):
        return (LANE_X_N, STOP_Y_N - 20) if t > 1 else (LANE_X_N, STOP_Y_N - 20 - 60 * (1 - t))

    with_cal = run_paths({1: v}, 12)
    no_cal = run_paths({1: v}, 12, hg=None)
    assert with_cal.queue_veh["N"][8] == 1 and no_cal.queue_veh["N"][8] == 1


def test_speed_is_measured_in_kmh_and_absurd_speeds_are_dropped() -> None:
    out = run_paths({1: north_down(100, 10)}, 12)  # 10 m/s = 36 km/h
    assert len(out.speeds) == 1 and out.speeds[0].kmh == pytest.approx(36.0, abs=1.0)
    fast = run_paths({1: north_down(20, 60)}, 4, fps=25)  # 216 km/h: a tracking error, not a speed
    assert fast.speeds == [] and fast.dropped_speeds == 1
    assert run_paths({1: north_down(100, 10)}, 12, hg=None).speeds == []  # no calibration, no speeds


def test_overlapping_approaches_do_not_mix() -> None:
    out = run_paths({1: north_down(20, 10), 2: lambda t: (622.0, 450 - 6 * 10 * t + 600) if False else (622.0, 700 - 60 * t)}, 12)
    c = counts_of(out)
    assert c[("N", "stop")] == 1 and c[("S", "stop")] == 1 and c[("S", "upstream")] == 1


# ------------------------------------------------------------------ against exact truth


def feed_truth(truth: synth.GroundTruth, *, miss: float = 0.0, jitter: float = 0.0, seed: int = 5, step: int = 2) -> tuple[AnalysisOutput, Tracker]:
    rng = random.Random(seed)
    tracker = Tracker(25 / step, pad=PAD)
    an = Analyzer(APS, HG, Params(lanes=1), truth.config["seconds"] + 2)
    for i in range(0, len(truth.frames), step):
        dets = []
        for v in truth.frames[i]:
            if miss and rng.random() < miss:
                continue
            x1, y1, x2, y2 = v["box"]
            if jitter:
                dx, dy = rng.gauss(0, jitter), rng.gauss(0, jitter)
                x1, x2, y1, y2 = x1 + dx, x2 + dx, y1 + dy, y2 + dy
            dets.append(RawDet(x1, y1, x2, y2, 0.9, v["cls"]))
        an.update(i / truth.config["fps"], tracker.update(dets))
    return an.finish(), tracker


def truth_counter(truth: synth.GroundTruth) -> collections.Counter:
    return collections.Counter((c["approach"], c["line"]) for c in truth.counts)


@pytest.fixture(scope="module")
def truth240() -> synth.GroundTruth:
    return synth.simulate(synth.SynthConfig(seconds=240, seed=21))


def test_perfect_detections_give_exact_counts_departures_and_waits(truth240: synth.GroundTruth) -> None:
    out, _ = feed_truth(truth240)
    assert counts_of(out) == truth_counter(truth240)
    assert len(out.departures) == len(truth240.departures)
    assert sum(d.sat for d in out.departures) == sum(d["sat"] for d in truth240.departures)
    assert len(out.waits) == len(truth240.waits)
    assert sum(w for w, _ in out.waits) / len(out.waits) == pytest.approx(sum(w["seconds"] for w in truth240.waits) / len(truth240.waits), abs=0.3)
    for a in APPROACHES:
        t = truth240.queue_veh[a][:240]
        m = out.queue_veh[a][:240]
        assert sum(abs(x - y) for x, y in zip(t, m, strict=True)) / 240 < 0.1
    # speeds: the measured speed at the stop line is within 2 km/h on average
    mean_t = sum(d["kmh"] for d in truth240.departures) / len(truth240.departures)
    mean_m = sum(s.kmh for s in out.speeds) / len(out.speeds)
    assert mean_m == pytest.approx(mean_t, abs=2.0)


def test_noisy_detections_keep_counts_within_five_percent(truth240: synth.GroundTruth) -> None:
    out, _ = feed_truth(truth240, miss=0.05, jitter=1.5)
    t, m = truth_counter(truth240), counts_of(out)
    for line in ("upstream", "stop"):
        tt = sum(v for (a, ln), v in t.items() if ln == line)
        mm = sum(v for (a, ln), v in m.items() if ln == line)
        assert abs(tt - mm) / tt <= 0.05, (line, tt, mm)
    assert abs(len(out.waits) - len(truth240.waits)) <= 0.15 * len(truth240.waits)


def test_heavy_misses_degrade_gracefully_and_never_overcount(truth240: synth.GroundTruth) -> None:
    out, _ = feed_truth(truth240, miss=0.25, jitter=2.0)
    t, m = truth_counter(truth240), counts_of(out)
    tt = sum(v for (a, ln), v in t.items() if ln == "stop")
    mm = sum(v for (a, ln), v in m.items() if ln == "stop")
    assert 0.75 * tt <= mm <= 1.05 * tt, (tt, mm)  # may lose some, must not invent many


def test_counts_do_not_depend_on_frame_rate(truth240: synth.GroundTruth) -> None:
    base = counts_of(feed_truth(truth240, step=2)[0])  # 12.5 frames per second
    assert sum(base.values()) == sum(truth_counter(truth240).values())
    for step, tolerance in ((3, 0.02), (5, 0.12)):  # 8.3 and 5 frames per second
        slow = counts_of(feed_truth(truth240, step=step)[0])
        assert abs(sum(slow.values()) - sum(base.values())) <= tolerance * sum(base.values()), (step, slow, base)


def test_class_is_the_vote_of_the_whole_track() -> None:
    t = Tracker(10)
    last = None
    for k in range(30):
        cls = "truck" if k % 6 == 0 else "bus"  # a few wrong frames
        last = t.update([RawDet(100 + 5 * k, 100, 140 + 5 * k, 160, 0.8, cls)])  # type: ignore[arg-type]
    assert last and last[0].cls == "bus" and t.final_class(last[0].id) == "bus"
