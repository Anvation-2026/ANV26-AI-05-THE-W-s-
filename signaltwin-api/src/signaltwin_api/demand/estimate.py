"""Demand estimation. A line-for-line port of src/engine/demand.ts so both sides give the same numbers.

Parity with the TypeScript code is enforced by tests/golden/*.json, which are generated from the front end.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

from ..models.contracts import APPROACHES, VEHICLE_CLASSES, CountsRow, Params, VehicleClass

Mix = dict[VehicleClass, float]


def js_round(x: float) -> int:
    """JavaScript Math.round: halves round toward +infinity (Python's round() rounds halves to even)."""
    return math.floor(x + 0.5)


def avg_pcu(mix: Mix, p: Params) -> float:
    s = 0.0
    for c in VEHICLE_CLASSES:
        s += mix[c] * p.classes[c].pcu
    return s


def sat_pcu_per_sec(p: Params) -> float:
    return (p.satFlowPerLane * p.lanes) / 3600


def bins_for(horizon: float, bin_seconds: float) -> int:
    return max(1, math.ceil(horizon / bin_seconds))


def phases_for(four_phase: bool) -> list[list[int]]:
    return [[0], [1], [2], [3]] if four_phase else [[0, 1], [2, 3]]


@dataclass
class ArriveRec:
    t: float
    ap: int
    cls: VehicleClass


@dataclass
class DepartRec:
    t: float
    ap: int
    cls: VehicleClass
    pcu: float
    sat: bool


@dataclass
class BinnedCounts:
    bin_seconds: float
    bins: int
    counts: list[list[list[float]]]  # [approach][bin][classIndex]


def _empty_counts(bins: int) -> list[list[list[float]]]:
    return [[[0.0 for _ in VEHICLE_CLASSES] for _ in range(bins)] for _ in range(4)]


def bin_arrivals(recs: Iterable[ArriveRec], duration: float, bin_seconds: float) -> BinnedCounts:
    bins = bins_for(duration, bin_seconds)
    counts = _empty_counts(bins)
    for r in recs:
        b = min(bins - 1, math.floor(r.t / bin_seconds))
        counts[r.ap][b][VEHICLE_CLASSES.index(r.cls)] += 1
    return BinnedCounts(bin_seconds, bins, counts)


def bin_counts_rows(rows: Iterable[CountsRow], bin_seconds: float) -> tuple[BinnedCounts, float]:
    rows = list(rows)
    duration = max([0.0] + [r.t for r in rows]) + bin_seconds
    bins = bins_for(duration, bin_seconds)
    counts = _empty_counts(bins)
    for r in rows:
        ap = APPROACHES.index(r.approach)
        b = min(bins - 1, math.floor(r.t / bin_seconds))
        counts[ap][b][VEHICLE_CLASSES.index(r.cls)] += r.count
    return BinnedCounts(bin_seconds, bins, counts), duration


@dataclass
class EstimatedDemand:
    bin_seconds: float
    duration: float
    rates: list[list[float]]  # smoothed vehicles per second
    mix: list[Mix]
    raw_pcu: list[list[float]]
    smooth_pcu: list[list[float]]
    raw_veh: list[list[float]]
    totals: list[float]


def estimate_demand(b: BinnedCounts, p: Params, alpha: float | None = None) -> EstimatedDemand:
    a = p.smoothing if alpha is None else alpha
    raw_veh: list[list[float]] = []
    raw_pcu: list[list[float]] = []
    smooth_veh: list[list[float]] = []
    smooth_pcu: list[list[float]] = []
    mixes: list[Mix] = []
    totals: list[float] = []
    for ap in range(4):
        rv: list[float] = []
        rp: list[float] = []
        cls = [0.0 for _ in VEHICLE_CLASSES]
        for bin_ in range(b.bins):
            c = b.counts[ap][bin_]
            n = 0.0
            pcu = 0.0
            for i, x in enumerate(c):
                n += x
                pcu += x * p.classes[VEHICLE_CLASSES[i]].pcu
            rv.append(n / b.bin_seconds)
            rp.append(pcu / b.bin_seconds)
            for i, x in enumerate(c):
                cls[i] += x
        sv: list[float] = []
        sp: list[float] = []
        for i, v in enumerate(rv):
            sv.append(v if i == 0 else a * v + (1 - a) * sv[i - 1])
            sp.append(rp[i] if i == 0 else a * rp[i] + (1 - a) * sp[i - 1])
        tot = 0.0
        for x in cls:
            tot += x
        totals.append(tot)
        mixes.append({c: (cls[i] / tot if tot > 0 else 1 / len(VEHICLE_CLASSES)) for i, c in enumerate(VEHICLE_CLASSES)})
        raw_veh.append(rv)
        raw_pcu.append(rp)
        smooth_veh.append(sv)
        smooth_pcu.append(sp)
    return EstimatedDemand(b.bin_seconds, b.bins * b.bin_seconds, smooth_veh, mixes, raw_pcu, smooth_pcu, raw_veh, totals)


@dataclass
class SatFlowResult:
    per_lane: float
    startup_lost: float
    headways: list[float]
    samples: int
    is_default: bool
    n_first: int = 0  # how many green starts had a first departure to measure start-up lost time from


def measure_saturation(deps: list[DepartRec], green_starts: list[tuple[float, int]], p: Params) -> SatFlowResult:
    """Port of measureSaturation. `green_starts` is a list of (time, phase index)."""
    headways: list[float] = []
    pcu_sum = 0.0
    time_sum = 0.0
    by_ap: list[list[DepartRec]] = [[], [], [], []]
    for d in deps:
        by_ap[d.ap].append(d)
    for lst in by_ap:
        streak: list[DepartRec] = []

        def flush() -> None:
            nonlocal streak, pcu_sum, time_sum
            if len(streak) >= 4:
                span = streak[-1].t - streak[0].t
                if span > 0:
                    pcu = 0.0
                    for d in streak[1:]:
                        pcu += d.pcu
                    pcu_sum += pcu
                    time_sum += span
                for i in range(1, len(streak)):
                    headways.append(streak[i].t - streak[i - 1].t)
            streak = []

        for d in lst:
            if streak and d.t - streak[-1].t > 4:
                flush()
            streak.append(d)
            if not d.sat:
                flush()
        flush()
    if time_sum < 30 or len(headways) < 20:
        return SatFlowResult(p.satFlowPerLane, p.startupLost, headways, len(headways), True)
    per_approach = (pcu_sum / time_sum) * 3600
    firsts: list[float] = []
    phases = phases_for(p.fourPhase)
    for g_t, g_phase in green_starts:
        aps = phases[g_phase] if 0 <= g_phase < len(phases) else []
        for ap in aps:
            first = next((d for d in by_ap[ap] if d.t >= g_t), None)
            if first is not None and first.t - g_t < 12:
                firsts.append(first.t - g_t)
    mean_first = sum(firsts) / len(firsts) if firsts else p.startupLost + 1
    hw = 3600 / per_approach
    lost = max(0.5, min(5.0, mean_first - hw))
    return SatFlowResult(per_approach / p.lanes, lost, headways, len(headways), False, len(firsts))
