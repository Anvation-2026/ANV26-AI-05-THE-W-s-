"""Demand profiles for scenarios and the Webster fixed-time plan. Port of the matching parts of src/engine/demand.ts."""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..demand.estimate import avg_pcu, bins_for, sat_pcu_per_sec
from ..models.contracts import DemandProfile, Params, Scenario
from .engine import phases_for
from .jsnum import js_round


def mean_pcu_rates(profile: DemandProfile, p: Params) -> list[float]:
    out: list[float] = []
    for ap, r in enumerate(profile.rates):
        total = 0.0
        for x in r:
            total += x
        mean = total / max(1, len(r))
        out.append(mean * avg_pcu(profile.mix[ap], p))
    return out


def phase_flow_ratios(pcu_rates: list[float], p: Params) -> list[float]:
    s = sat_pcu_per_sec(p)
    return [max(pcu_rates[a] for a in aps) / s for aps in phases_for(p.fourPhase)]


def scenario_profile(base: DemandProfile, sc: Scenario, p: Params, horizon: float | None = None) -> DemandProfile:
    horizon = p.horizon if horizon is None else horizon
    bins = bins_for(horizon, base.binSeconds)
    base_means = mean_pcu_rates(base, p)
    y = 0.0
    for v in phase_flow_ratios(base_means, p):
        y += v
    k = sc.targetY / y if y > 0 else 1
    rates: list[list[float]] = []
    for ap, r in enumerate(base.rates):
        row: list[float] = []
        mult = sc.multipliers[ap] if ap < len(sc.multipliers) else 1
        for b in range(bins):
            t = (b + 0.5) * base.binSeconds
            v = r[min(len(r) - 1, b)] * k * mult
            for s in sc.surges:
                if s["approach"] == ap and s["from"] <= t < s["to"]:
                    v *= s["mult"]
            row.append(v)
        rates.append(row)
    return DemandProfile(
        binSeconds=base.binSeconds,
        duration=horizon,
        rates=rates,
        mix=[dict(m) for m in base.mix],
        satFlowMeasured=base.satFlowMeasured,
        satFlowIsDefault=base.satFlowIsDefault,
        startupLostMeasured=base.startupLostMeasured,
    )


@dataclass
class WebsterPlan:
    cycle: int
    greens: list[float]
    y: list[float]
    Y: float
    lost: float
    over_capacity: bool


def webster_plan(profile: DemandProfile, p: Params) -> WebsterPlan:
    phases = phases_for(p.fourPhase)
    win = max(1, js_round(60 / profile.binSeconds))
    peaks: list[float] = []
    for ap, r in enumerate(profile.rates):
        best = 0.0
        for i in range(len(r) - win + 1):
            s = 0.0
            for j in range(win):
                s += r[i + j]
            best = max(best, s / win)
        if len(r) < win:
            tot = 0.0
            for x in r:
                tot += x
            best = tot / max(1, len(r))
        peaks.append(best * avg_pcu(profile.mix[ap], p))
    s = sat_pcu_per_sec(p)
    y = [max(peaks[a] for a in aps) / s for aps in phases]
    big_y = 0.0
    for v in y:
        big_y += v
    lost = len(phases) * (p.startupLost + p.yellow + p.allRed)
    over = big_y >= 0.9
    yc = min(big_y, 0.9)
    c0 = min(120.0, max(30.0, (1.5 * lost + 5) / (1 - yc)))
    greens: list[float] = []
    for yi in y:
        eff = ((c0 - lost) * yi) / max(1e-6, big_y)
        greens.append(max(p.minGreen, min(p.maxGreen, js_round(eff + p.startupLost - p.yellow))))
    cycle = js_round(sum_(greens) + len(phases) * (p.yellow + p.allRed))
    return WebsterPlan(cycle, greens, y, big_y, lost, over)


def sum_(xs: list[float]) -> float:
    t = 0.0
    for x in xs:
        t += x
    return t


__all__ = ["WebsterPlan", "math", "mean_pcu_rates", "phase_flow_ratios", "scenario_profile", "webster_plan"]
