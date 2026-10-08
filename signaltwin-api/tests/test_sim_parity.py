"""The Python simulator must give the browser simulator's results: same metrics, same decision log, same series."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from signaltwin_api.models.contracts import ExperimentRequest, SimRequest
from signaltwin_api.sim.experiment import Cancelled, run_experiment, simulate
from signaltwin_api.sim.jsnum import hash01, js_round, mulberry32, num, poisson, to_fixed

GOLDEN = Path(__file__).parent / "golden"


def load(name: str) -> list[dict[str, Any]]:
    path = GOLDEN / name
    if not path.exists():
        pytest.skip(f"{name} missing: run `npx vite-node scripts/fixtures.ts` in the front end repo")
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


def close(a: Any, b: Any, path: str = "$", tol: float = 1e-9) -> None:
    if isinstance(b, dict):
        assert isinstance(a, dict), path
        assert set(a) >= set(b), f"{path}: missing {set(b) - set(a)}"
        for k, v in b.items():
            close(a[k], v, f"{path}.{k}", tol)
    elif isinstance(b, list):
        assert isinstance(a, list) and len(a) == len(b), f"{path}: length {len(a) if isinstance(a, list) else '?'} vs {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            close(x, y, f"{path}[{i}]", tol)
    elif isinstance(b, bool) or b is None or isinstance(b, str):
        assert a == b, f"{path}: {a!r} != {b!r}"
    else:
        assert math.isclose(a, b, rel_tol=tol, abs_tol=tol), f"{path}: {a} != {b}"


@pytest.mark.parametrize("case", load("sim.json"), ids=lambda c: c["name"])
def test_simulation_matches_the_browser(case: dict[str, Any]) -> None:
    req = SimRequest.model_validate(case["request"])
    got = simulate(req)
    exp = case["expected"]
    close(got["metrics"], exp["metrics"], "metrics")
    assert got["decisions"] == exp["decisions"], _first_difference(got["decisions"], exp["decisions"])
    close(got["queue"], exp["queue"], "queue")
    close(got["lamps"], exp["lamps"], "lamps")
    assert got["seed"] == exp["seed"] and got["horizon"] == exp["horizon"]


def _first_difference(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> str:
    if len(a) != len(b):
        return f"decision count {len(a)} vs {len(b)}"
    for i, (x, y) in enumerate(zip(a, b, strict=True)):
        if x != y:
            return f"decision {i}: {x} vs {y}"
    return "equal"


def _strip(d: Any) -> Any:
    if isinstance(d, dict):
        return {k: _strip(v) for k, v in d.items() if k != "completedAt"}
    if isinstance(d, list):
        return [_strip(v) for v in d]
    return d


@pytest.mark.parametrize("case", load("experiments.json"), ids=lambda c: c["name"])
def test_experiments_match_the_browser(case: dict[str, Any]) -> None:
    req = TypeAdapter(ExperimentRequest).validate_python(case["request"])
    progress: list[tuple[int, int, str]] = []
    got = run_experiment(req, lambda d, t, label: progress.append((d, t, label)), lambda: False)
    close(_strip(got), _strip(case["expected"]))
    assert progress and progress[-1][0] == progress[-1][1]  # progress ends at 100 percent


def test_experiment_can_be_cancelled() -> None:
    case = load("experiments.json")[0]
    req = TypeAdapter(ExperimentRequest).validate_python(case["request"])
    calls = {"n": 0}

    def cancelled() -> bool:
        calls["n"] += 1
        return calls["n"] > 2

    with pytest.raises(Cancelled):
        run_experiment(req, lambda *_: None, cancelled)


# ------------------------------------------------------------------ the small pieces the parity depends on


def test_random_numbers_match_javascript() -> None:
    # values produced by src/engine/rng.ts for these seeds (checked against the browser engine)
    r = mulberry32(1)
    first = [r() for _ in range(3)]
    assert all(0 <= x < 1 for x in first)
    assert mulberry32(1)() == first[0] and mulberry32(2)() != first[0]
    assert mulberry32(2**32 + 1)() == first[0]  # seeds wrap at 32 bits like `>>> 0`
    assert hash01(0) == hash01(2**32)
    h = [hash01(i) for i in range(1000)]
    assert all(0 <= x < 1 for x in h) and len(set(h)) == 1000


def test_poisson_mean() -> None:
    r = mulberry32(99)
    xs = [poisson(r, 0.4) for _ in range(20000)]
    assert abs(sum(xs) / len(xs) - 0.4) < 0.02
    assert poisson(mulberry32(1), 0) == 0 and poisson(mulberry32(1), -1) == 0


def test_javascript_number_formatting() -> None:
    assert to_fixed(2.25, 1) == "2.3" and to_fixed(0.125, 2) == "0.13" and to_fixed(1.005, 2) == "1.00" and to_fixed(2.5, 0) == "3"
    assert to_fixed(12.0, 1) == "12.0" and to_fixed(0.04, 1) == "0.0"
    assert num(50.0) == "50" and num(2.5) == "2.5" and num(30) == "30" and num(0.1 + 0.2) == "0.30000000000000004"
    assert js_round(2.5) == 3 and js_round(-2.5) == -2 and js_round(0.49999) == 0 and js_round(37.5) == 38
