"""Demand estimation: golden parity with the browser engine, plus edge cases and properties."""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st

from signaltwin_api.demand.estimate import DepartRec, measure_saturation
from signaltwin_api.models.contracts import APPROACHES, VEHICLE_CLASSES, Params

from .test_service import assert_problem

GOLDEN = Path(__file__).parent / "golden"


def load(name: str) -> list[dict[str, Any]]:
    path = GOLDEN / name
    if not path.exists():
        pytest.skip(f"{name} missing: run `npx vite-node scripts/fixtures.ts` in the front end repo")
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


def assert_close(a: Any, b: Any, path: str = "$", tol: float = 1e-9) -> None:
    """Deep comparison. The two sides do the same arithmetic in the same order, so they match to rounding."""
    if isinstance(b, dict):
        assert isinstance(a, dict), path
        for k, v in b.items():
            assert k in a, f"{path}.{k} missing"
            assert_close(a[k], v, f"{path}.{k}", tol)
    elif isinstance(b, list):
        assert isinstance(a, list) and len(a) == len(b), f"{path}: length {len(a) if isinstance(a, list) else '?'} vs {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            assert_close(x, y, f"{path}[{i}]", tol)
    elif isinstance(b, float) or isinstance(a, float):
        assert math.isclose(a, b, rel_tol=tol, abs_tol=tol), f"{path}: {a} != {b}"
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


@pytest.mark.parametrize("case", load("demand.json"), ids=lambda c: c["name"])
def test_demand_matches_the_browser_engine(client: TestClient, case: dict[str, Any]) -> None:
    r = client.post("/v1/demand/estimate", json=case["request"])
    assert r.status_code == 200, r.text
    got = r.json()
    exp = case["expected"]
    exp = {k: v for k, v in exp.items() if k != "rawVeh"}
    assert_close(got, exp)


@pytest.mark.parametrize("case", load("saturation.json"), ids=lambda c: c["name"])
def test_saturation_matches_the_browser_engine(case: dict[str, Any]) -> None:
    deps = [DepartRec(d["t"], d["ap"], d["cls"], d["pcu"], d["sat"]) for d in case["deps"]]
    starts = [(g["t"], g["phase"]) for g in case["greenStarts"]]
    got = measure_saturation(deps, starts, Params.model_validate(case["params"]))
    exp = case["expected"]
    assert got.is_default == exp["isDefault"] and got.samples == exp["samples"]
    assert_close(got.per_lane, exp["perLane"])
    assert_close(got.startup_lost, exp["startupLost"])
    assert_close(got.headways, exp["headways"])


# ------------------------------------------------------------------ edge cases


def counts_req(rows: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {"source": {"kind": "counts", "rows": rows}, **extra}


def test_empty_counts_are_refused_with_advice(client: TestClient) -> None:
    b = assert_problem(client.post("/v1/demand/estimate", json=counts_req([])), 422, "invalid_request")
    assert "row" in b["fix"].lower()


@pytest.mark.parametrize(
    "row,needle",
    [
        ({"t": 0, "approach": "X", "cls": "car", "count": 1}, "approach"),
        ({"t": 0, "approach": "N", "cls": "tank", "count": 1}, "cls"),
        ({"t": -1, "approach": "N", "cls": "car", "count": 1}, "t"),
        ({"t": 0, "approach": "N", "cls": "car", "count": -2}, "count"),
        ({"t": "soon", "approach": "N", "cls": "car", "count": 1}, "t"),
    ],
)
def test_bad_rows_are_named(client: TestClient, row: dict[str, Any], needle: str) -> None:
    b = assert_problem(client.post("/v1/demand/estimate", json=counts_req([row])), 422)
    assert needle in b["detail"]


@pytest.mark.parametrize("extra", [{"smoothing": 0}, {"smoothing": 1.5}, {"binSeconds": 0}, {"binSeconds": -5}, {"params": {"lanes": 0}}])
def test_bad_options_are_refused(client: TestClient, extra: dict[str, Any]) -> None:
    assert_problem(client.post("/v1/demand/estimate", json=counts_req([{"t": 0, "approach": "N", "cls": "car", "count": 1}], **extra)), 422)


def test_a_result_with_no_counts_is_refused_with_advice(client: TestClient) -> None:
    body = {"source": {"kind": "perception", "result": {"fps": 5, "width": 1280, "height": 720, "frames": [{"t": 60, "detections": []}], "counts": []}}}
    b = assert_problem(client.post("/v1/demand/estimate", json=body), 422, "invalid_request")
    assert "lines" in b["fix"]


def test_perception_uses_measured_saturation_flow(client: TestClient) -> None:
    body = {
        "source": {
            "kind": "perception",
            "result": {
                "fps": 5, "width": 1280, "height": 720,
                "frames": [{"t": 0, "detections": []}, {"t": 100, "detections": []}],
                "counts": [{"t": 3, "approach": "N", "cls": "car", "line": "upstream"}],
                "satFlow": {"perLane": 1650.5, "startupLost": 2.4, "headways": [1.9, 2.1], "samples": 2, "isDefault": False},
            },
        }
    }
    b = client.post("/v1/demand/estimate", json=body).json()
    assert b["satFlow"]["perLane"] == 1650.5 and b["satFlow"]["isDefault"] is False
    assert b["profile"]["satFlowMeasured"] == 1650.5 and b["profile"]["startupLostMeasured"] == 2.4


def test_stop_line_counts_are_used_when_an_approach_has_no_upstream_counts(client: TestClient) -> None:
    ev = [{"t": 2, "approach": "N", "cls": "car", "line": "upstream"}, {"t": 4, "approach": "E", "cls": "car", "line": "stop"}]
    body = {"source": {"kind": "perception", "result": {"fps": 5, "width": 1280, "height": 720, "frames": [{"t": 30, "detections": []}], "counts": ev}}}
    b = client.post("/v1/demand/estimate", json=body).json()
    assert b["totals"] == [1, 0, 1, 0] and any("E has no upstream" in w for w in b["warnings"])


def test_large_counts_are_fast(client: TestClient) -> None:
    rows = [{"t": i * 0.5, "approach": APPROACHES[i % 4], "cls": VEHICLE_CLASSES[i % 5], "count": 1} for i in range(20000)]
    t0 = time.time()
    r = client.post("/v1/demand/estimate", json=counts_req(rows), headers={"Content-Type": "application/json"})
    assert r.status_code == 200 or r.status_code == 413  # 20k rows is about 1.5 MB, under the default 4 MB limit
    assert time.time() - t0 < 5


# ------------------------------------------------------------------ properties

row_st = st.fixed_dictionaries(
    {
        "t": st.floats(min_value=0, max_value=3600, allow_nan=False),
        "approach": st.sampled_from(APPROACHES),
        "cls": st.sampled_from(VEHICLE_CLASSES),
        "count": st.integers(min_value=0, max_value=50),
    }
)


@settings(max_examples=60, deadline=None)
@given(rows=st.lists(row_st, min_size=1, max_size=60), smoothing=st.floats(min_value=0.05, max_value=1.0), bin_s=st.sampled_from([5, 10, 15, 30, 60]))
def test_properties_hold_for_any_counts(rows: list[dict[str, Any]], smoothing: float, bin_s: int) -> None:
    from signaltwin_api.demand.service import estimate
    from signaltwin_api.models.contracts import DemandEstimateRequest

    got = estimate(DemandEstimateRequest.model_validate(counts_req(rows, smoothing=smoothing, binSeconds=bin_s)))
    total = sum(r["count"] for r in rows)
    assert sum(got.totals) == total  # nothing is lost or invented by binning
    for ap in range(4):
        assert all(r >= 0 for r in got.profile.rates[ap])
        assert math.isclose(sum(got.profile.mix[ap].values()), 1.0, rel_tol=1e-9)
        n = sum(r["count"] for r in rows if r["approach"] == APPROACHES[ap])
        assert got.totals[ap] == n
        if n == 0:
            assert all(r == 0 for r in got.profile.rates[ap])
    assert got.profile.duration == pytest.approx(len(got.profile.rates[0]) * bin_s)
    # smoothed rates never exceed the largest raw rate
    for ap in range(4):
        raw = [x for x in got.rawPcu[ap]]
        assert max(got.smoothPcu[ap], default=0) <= max(raw, default=0) + 1e-9
