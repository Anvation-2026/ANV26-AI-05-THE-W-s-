"""Metrics and statistics. Port of src/engine/metrics.ts."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from .engine import Sim

METRIC_KEYS = [
    "avgDelayVeh",
    "avgDelayPerson",
    "p95Delay",
    "longestRed",
    "longestWait",
    "throughputVeh",
    "throughputPeople",
    "maxQueue",
    "jain",
]
ALL_KEYS = METRIC_KEYS + ["served"]


def percentile(sorted_xs: list[float], p: float) -> float:
    if not sorted_xs:
        return 0.0
    idx = min(len(sorted_xs) - 1, max(0, math.ceil(p * len(sorted_xs)) - 1))
    return sorted_xs[idx]


def jain_index(xs: list[float]) -> float:
    v = [x for x in xs if math.isfinite(x)]
    if not v:
        return 1.0
    s = 0.0
    s2 = 0.0
    for x in v:
        s += x
    for x in v:
        s2 += x * x
    if s2 == 0:
        return 1.0
    return (s * s) / (len(v) * s2)


def compute_metrics(sim: Sim) -> dict[str, float]:
    t = sim.t
    waits = list(sim.waits)
    extra_sum = [0.0] * 4
    extra_cnt = [0] * 4
    pw = sim.people_wait
    pc = sim.people_count
    longest = 0.0
    for w in waits:
        longest = max(longest, w)
    for ap in range(4):
        for v in sim.queue[ap]:
            w = t - v.queue_t
            waits.append(w)
            extra_sum[ap] += w
            extra_cnt[ap] += 1
            pw += w * v.people
            pc += v.people
            if w > longest:
                longest = w
    waits.sort()
    n = len(waits)
    total = 0.0
    for w in waits:
        total += w
    per_ap: list[float] = []
    for ap in range(4):
        c = sim.wait_count[ap] + extra_cnt[ap]
        if c > 0:
            per_ap.append((sim.wait_sum[ap] + extra_sum[ap]) / c)
    hours = max(1, t) / 3600
    return {
        "avgDelayVeh": total / n if n else 0,
        "avgDelayPerson": pw / pc if pc else 0,
        "p95Delay": percentile(waits, 0.95),
        "longestRed": max(sim.max_red),
        "longestWait": longest,
        "throughputVeh": sim.served / hours,
        "throughputPeople": sim.served_people / hours,
        "maxQueue": max(sim.max_queue),
        "jain": jain_index(per_ap),
        "served": sim.served,
    }


T_TABLE = [
    (1, 12.706), (2, 4.303), (3, 3.182), (4, 2.776), (5, 2.571), (6, 2.447), (7, 2.365), (8, 2.306), (9, 2.262),
    (10, 2.228), (12, 2.179), (15, 2.131), (19, 2.093), (20, 2.086), (24, 2.064), (29, 2.045), (30, 2.042), (60, 2.0),
]


def t_critical(df: int) -> float:
    if df < 1:
        return 0.0
    for d, t in T_TABLE:
        if df <= d:
            return t
    return 1.96


def stat(xs: list[float]) -> dict[str, float]:
    n = len(xs)
    if n == 0:
        return {"mean": 0, "ci": 0, "n": 0}
    s = 0.0
    for x in xs:
        s += x
    mean = s / n
    if n == 1:
        return {"mean": mean, "ci": 0, "n": n}
    ss = 0.0
    for x in xs:
        ss += (x - mean) ** 2
    sd = math.sqrt(ss / (n - 1))
    return {"mean": mean, "ci": (t_critical(n - 1) * sd) / math.sqrt(n), "n": n}


def stat_set(ms: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    return {k: stat([m[k] for m in ms]) for k in ALL_KEYS}


def paired_stats(base: list[dict[str, float]], other: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    n = min(len(base), len(other))
    for k in ALL_KEYS:
        diffs: list[float] = []
        base_mean = 0.0
        for i in range(n):
            diffs.append(other[i][k] - base[i][k])
            base_mean += base[i][k]
        base_mean /= max(1, n)
        s = stat(diffs)
        out[k] = {**s, "pct": (s["mean"] / base_mean) * 100 if base_mean != 0 else 0}
    return out


def build_comparison(scenario_id: str, horizon: float, per: dict[str, list[dict[str, float]]], paired_against: str = "webster") -> dict[str, Any]:
    stats = {k: stat_set(ms) for k, ms in per.items()}
    paired: dict[str, Any] = {}
    base = per.get(paired_against)
    if base is not None:
        for k, ms in per.items():
            if k != paired_against:
                paired[k] = paired_stats(base, ms)
    first = next(iter(per.values()), [])
    return {
        "scenarioId": scenario_id,
        "seeds": len(first),
        "horizon": horizon,
        "perController": per,
        "stats": stats,
        "paired": paired,
        "completedAt": datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    }
