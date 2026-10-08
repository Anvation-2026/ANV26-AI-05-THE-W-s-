"""The simulation and experiment endpoints."""

from __future__ import annotations

import copy
import time

import pytest
from fastapi.testclient import TestClient

from .conftest import wait_job
from .test_jobs import read_sse, wait_state
from .test_service import assert_problem
from .test_sim_parity import _strip, close, load


def test_simulate_returns_what_the_browser_returns(client: TestClient) -> None:
    case = next(c for c in load("sim.json") if c["name"] == "signaltwin, scenario B")
    r = client.post("/v1/simulate", json=case["request"])
    assert r.status_code == 200, r.text
    body = r.json()
    close(body["metrics"], case["expected"]["metrics"])
    assert body["decisions"] == case["expected"]["decisions"]
    assert len(body["queue"]) == 4 and len(body["lamps"][0]) == case["expected"]["horizon"]


def test_simulate_refuses_a_very_long_horizon_and_says_what_to_do(client: TestClient) -> None:
    case = copy.deepcopy(load("sim.json")[0]["request"])
    case["params"]["horizon"] = 20000
    b = assert_problem(client.post("/v1/simulate", json=case), 422, "simulation_too_long")
    assert "experiment" in b["fix"]


@pytest.mark.parametrize("patch,needle", [({"seed": "x"}, "seed"), ({"controller": "magic"}, "controller"), ({"params": {"lanes": 99}}, "lanes")])
def test_simulate_names_bad_input(client: TestClient, patch: dict, needle: str) -> None:
    case = copy.deepcopy(load("sim.json")[0]["request"])
    case.update(patch)
    b = assert_problem(client.post("/v1/simulate", json=case), 422)
    assert needle in b["detail"]


def test_experiment_runs_as_a_job_and_matches_the_browser(client: TestClient) -> None:
    case = next(c for c in load("experiments.json") if c["name"] == "compare, two controllers")
    r = client.post("/v1/experiments", json=case["request"])
    assert r.status_code == 202, r.text
    job = r.json()
    done = wait_job(client, job["jobId"], 60)
    assert done["state"] == "done"
    events = read_sse(client, job["jobId"])
    prog = [d for _, t, d in events if t == "progress"]
    assert prog and prog[-1]["fraction"] == 1.0 and prog[-1]["message"]
    res = client.get(f"/v1/jobs/{job['jobId']}/result").json()
    close(_strip(res), _strip(case["expected"]))
    again = client.post("/v1/experiments", json=case["request"])
    assert again.status_code == 200 and again.json()["fromCache"] is True


def test_experiment_too_large_is_refused_before_any_work(client: TestClient) -> None:
    case = copy.deepcopy(next(c for c in load("experiments.json") if c["name"] == "compare, four controllers")["request"])
    case["seeds"] = 200
    case["setup"]["params"]["horizon"] = 43200
    b = assert_problem(client.post("/v1/experiments", json=case), 422, "experiment_too_large")
    assert "fewer seeds" in b["fix"]
    assert client.get("/v1/health").json()["queue"]["queued"] == 0


def test_experiment_can_be_cancelled_quickly(client: TestClient) -> None:
    case = copy.deepcopy(next(c for c in load("experiments.json") if c["name"] == "grid search")["request"])
    case["seeds"] = 20
    case["betas"] = [1, 1.5, 2, 2.5, 3, 3.5]
    case["gammas"] = [0.25, 0.5, 0.75, 1, 1.25, 1.5]
    case["setup"]["params"]["horizon"] = 1800
    case["setup"]["baseDemand"]["rates"] = [(r * 40)[:120] for r in case["setup"]["baseDemand"]["rates"]]
    job = client.post("/v1/experiments", json=case).json()
    wait_state(client, job["jobId"], "running")
    time.sleep(0.5)
    t0 = time.time()
    client.post(f"/v1/jobs/{job['jobId']}/cancel")
    final = wait_job(client, job["jobId"], 10)
    assert final["state"] == "cancelled" and time.time() - t0 < 2.0


def test_experiment_input_is_validated(client: TestClient) -> None:
    case = copy.deepcopy(load("experiments.json")[0]["request"])
    case["kinds"] = []
    assert_problem(client.post("/v1/experiments", json=case), 422)
    case["kinds"] = ["observed"]
    case["seeds"] = 0
    assert_problem(client.post("/v1/experiments", json=case), 422)
    assert_problem(client.post("/v1/experiments", json={"type": "unknown"}), 422)


