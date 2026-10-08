"""Jobs end to end through the HTTP API with real worker processes and a real (synthetic) video."""

from __future__ import annotations

import gzip
import json
import time
from collections import Counter
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from signaltwin_api.main import create_app
from signaltwin_api.models.contracts import PerceptionResult

from .conftest import job_request, make_settings, upload, wait_job
from .test_service import assert_problem

pytestmark = pytest.mark.slow


def read_sse(client: TestClient, job_id: str, headers: dict[str, str] | None = None) -> list[tuple[int, str, dict]]:
    out: list[tuple[int, str, dict]] = []
    with client.stream("GET", f"/v1/jobs/{job_id}/events", headers=headers or {}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        cur: dict[str, str] = {}
        for line in r.iter_lines():
            if line.startswith(":") or line.startswith("retry"):
                continue
            if line == "":
                if "event" in cur:
                    out.append((int(cur.get("id", "0")), cur["event"], json.loads(cur["data"])))
                cur = {}
                continue
            k, _, v = line.partition(": ")
            cur[k] = v
    return out


def wait_state(client: TestClient, job_id: str, state: str, timeout: float = 60.0) -> dict:
    return wait_job(client, job_id, timeout, until=(state, "error", "cancelled", "done"))


def test_happy_path_events_result_and_cache(client: TestClient, video60) -> None:
    path, truth = video60
    v = upload(client, path)
    r = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth))
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["state"] == "queued" and job["reused"] is False and job["jobId"].startswith("j_")
    done = wait_job(client, job["jobId"])
    assert done["state"] == "done" and done["fromCache"] is False and done["error"] is None

    events = read_sse(client, job["jobId"])
    types = [t for _, t, _ in events]
    ids = [i for i, _, _ in events]
    assert types[0] == "queued" and types[-1] == "done" and "progress" in types and "state" in types
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    fractions = [d["fraction"] for _, t, d in events if t == "progress" and "fraction" in d]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    # reconnect with Last-Event-ID resumes exactly after that event
    mid = ids[len(ids) // 2]
    resumed = read_sse(client, job["jobId"], {"Last-Event-ID": str(mid)})
    assert [i for i, _, _ in resumed] == [i for i in ids if i > mid]

    res = client.get(f"/v1/jobs/{job['jobId']}/result")
    assert res.status_code == 200 and res.headers["content-encoding"] == "gzip"
    result = PerceptionResult.model_validate(res.json())  # the contract the front end relies on
    assert result.meta and result.meta.videoId == v["videoId"] and result.meta.frameCount > 500
    assert result.quality and result.quality.missedCountRisk in ("low", "medium", "high")
    assert result.queue and len(result.queue.counts["N"]) >= 60
    # counts are close to the truth the video was made from
    t_up = Counter(c["approach"] for c in truth.counts if c["line"] == "upstream")
    m_up = Counter(c.approach for c in (result.counts or []) if c.line == "upstream")
    assert abs(sum(t_up.values()) - sum(m_up.values())) <= max(2, 0.08 * sum(t_up.values()))
    dl = client.get(f"/v1/jobs/{job['jobId']}/result", params={"download": "true"}, headers={"Accept-Encoding": "identity"})
    assert "attachment" in dl.headers["content-disposition"] and "content-encoding" not in dl.headers
    assert dl.json()["meta"]["videoId"] == v["videoId"]

    # the same request again is answered from the cache, immediately
    t0 = time.time()
    again = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth))
    assert again.status_code == 200 and again.json()["state"] == "done" and again.json()["fromCache"] is True
    assert time.time() - t0 < 2.0
    assert client.get(f"/v1/jobs/{again.json()['jobId']}/result").json()["meta"]["sha256"] == v["sha256"]


def test_identical_request_while_running_shares_one_job(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    a = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    b = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    assert a["jobId"] == b["jobId"] and b["reused"] is True
    other = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth, frameSampleS=0.5)).json()
    assert other["jobId"] != a["jobId"]
    client.post(f"/v1/jobs/{other['jobId']}/cancel")
    client.post(f"/v1/jobs/{a['jobId']}/cancel")


def test_cancel_stops_work_within_two_seconds(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    job = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    wait_state(client, job["jobId"], "detecting")
    time.sleep(1.0)
    run = client.app.state.ctx.jobs._running[job["jobId"]]
    t0 = time.time()
    r = client.post(f"/v1/jobs/{job['jobId']}/cancel")
    assert r.status_code == 200
    final = wait_job(client, job["jobId"], 10)
    elapsed = time.time() - t0
    assert final["state"] == "cancelled" and elapsed < 2.0, elapsed
    assert not run.proc.is_alive()
    assert_problem(client.get(f"/v1/jobs/{job['jobId']}/result"), 409, "job_cancelled")
    assert client.post(f"/v1/jobs/{job['jobId']}/cancel").json()["state"] == "cancelled"  # cancelling twice is harmless
    assert not list(client.app.state.ctx.storage.tmp_dir.glob("*.json.gz"))
    types = [t for _, t, _ in read_sse(client, job["jobId"])]
    assert types[-1] == "cancelled"
    # the server is still healthy and can run another job straight away
    assert client.get("/v1/health").json()["queue"]["running"] == 0


def test_cancel_a_queued_job(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    first = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    second = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth, frameSampleS=0.4)).json()
    assert client.post(f"/v1/jobs/{second['jobId']}/cancel").json()["state"] == "cancelled"
    client.post(f"/v1/jobs/{first['jobId']}/cancel")
    wait_job(client, first["jobId"], 10)


def test_timeout_kills_the_worker_with_a_plain_message(tmp_path: Path, video300) -> None:
    path, truth = video300
    with TestClient(create_app(make_settings(tmp_path, job_timeout_min_s=3, job_timeout_factor=0))) as c:
        v = upload(c, path)
        job = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
        final = wait_job(c, job["jobId"], 60)
        assert final["state"] == "error" and final["error"]["code"] == "timeout"
        assert final["error"]["fix"] and "shorter" in final["error"]["fix"]
        b = assert_problem(c.get(f"/v1/jobs/{job['jobId']}/result"), 504, "timeout")
        assert b["title"]
        assert c.app.state.ctx.jobs.stats()["running"] == 0


def test_memory_cap(tmp_path: Path, video60) -> None:
    path, truth = video60
    with TestClient(create_app(make_settings(tmp_path, job_memory_limit_mb=30))) as c:
        v = upload(c, path)
        job = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
        final = wait_job(c, job["jobId"], 60)
        assert final["state"] == "error" and final["error"]["code"] == "out_of_memory"
        assert_problem(c.get(f"/v1/jobs/{job['jobId']}/result"), 507, "out_of_memory")


def test_worker_crash_is_reported_with_a_reference(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    job = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    wait_state(client, job["jobId"], "detecting")
    client.app.state.ctx.jobs._running[job["jobId"]].proc.kill()  # as if the OS killed it
    final = wait_job(client, job["jobId"], 20)
    assert final["state"] == "error" and final["error"]["code"] == "job_failed"
    assert "reference" in final["error"]["fix"]


def test_queue_full(tmp_path: Path, video300) -> None:
    path, truth = video300
    with TestClient(create_app(make_settings(tmp_path, queue_max=1))) as c:
        v = upload(c, path)
        jobs = []
        for i in range(2):
            r = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth, frameSampleS=0.2 + 0.1 * i))
            assert r.status_code == 202
            jobs.append(r.json())
            if i == 0:
                wait_state(c, r.json()["jobId"], "detecting")
        r = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth, frameSampleS=0.9))
        b = assert_problem(r, 429, "queue_full")
        assert int(r.headers["retry-after"]) >= 1 and b["retryAfterS"] >= 1
        for j in jobs:
            c.post(f"/v1/jobs/{j['jobId']}/cancel")


def test_bad_requests_fail_before_any_work(client: TestClient, video60) -> None:
    path, truth = video60
    v = upload(client, path)
    assert_problem(client.post("/v1/perception/jobs", json=job_request("v_missing", truth)), 404)
    empty = {**truth.junction, "geometry": {"stopLines": {}, "upstreamLines": {}, "queueZones": {}}}
    b = assert_problem(client.post("/v1/perception/jobs", json={**job_request(v["videoId"], truth), "junction": empty}), 422, "geometry_incomplete")
    assert "Setup" in b["fix"]
    one = json.loads(json.dumps(truth.junction))
    for k in ("stopLines", "upstreamLines", "queueZones"):
        one["geometry"][k] = {a: s for a, s in one["geometry"][k].items() if a == "N"}
    assert_problem(client.post("/v1/perception/jobs", json={**job_request(v["videoId"], truth), "junction": one}), 422, "geometry_incomplete")
    bad_cal = json.loads(json.dumps(truth.junction))
    bad_cal["calibration"]["distances"] = [20, 10, 0, 10]
    assert_problem(client.post("/v1/perception/jobs", json={**job_request(v["videoId"], truth), "junction": bad_cal}), 422, "calibration_invalid")
    assert client.get("/v1/health").json()["queue"] == {"queued": 0, "running": 0, "workers": 1, "queueMax": 4}
    assert_problem(client.get("/v1/jobs/j_nope"), 404, "job_not_found")
    assert_problem(client.get("/v1/jobs/j_nope/events"), 404)
    assert_problem(client.post("/v1/jobs/j_nope/cancel"), 404)


def test_result_before_done_is_409(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    job = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    assert_problem(client.get(f"/v1/jobs/{job['jobId']}/result"), 409, "job_not_ready")
    client.post(f"/v1/jobs/{job['jobId']}/cancel")
    wait_job(client, job["jobId"], 10)


def test_deleting_the_video_stops_its_job(client: TestClient, video300) -> None:
    path, truth = video300
    v = upload(client, path)
    job = client.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
    wait_state(client, job["jobId"], "detecting")
    assert client.delete(f"/v1/videos/{v['videoId']}").status_code == 204
    assert_problem(client.get(f"/v1/jobs/{job['jobId']}"), 404)
    assert client.app.state.ctx.jobs.stats()["running"] == 0
    st = client.app.state.ctx.storage
    assert not list(st.videos_dir.glob("*")) and not list(st.results_dir.glob("*")) and not list(st.tmp_dir.glob("*.json.gz"))


def test_restart_marks_interrupted_jobs_and_requeues_waiting_ones(tmp_path: Path, video300) -> None:
    path, truth = video300
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)) as c:
        v = upload(c, path)
        running = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
        waiting = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth, frameSampleS=0.3)).json()
        wait_state(c, running["jobId"], "detecting")
    # the server stops here with one job running and one waiting
    with TestClient(create_app(settings)) as c2:
        j = c2.get(f"/v1/jobs/{running['jobId']}").json()
        assert j["state"] == "error" and j["error"]["code"] == "job_failed" and j["error"]["retryable"] is True
        assert "again" in j["error"]["fix"]
        types = [t for _, t, _ in read_sse(c2, running["jobId"])]
        assert types[-1] == "error"
        w = wait_state(c2, waiting["jobId"], "detecting")
        assert w["state"] in ("detecting", "decoding", "probing", "postprocessing", "done")
        c2.post(f"/v1/jobs/{waiting['jobId']}/cancel")


def test_results_are_deterministic(tmp_path: Path, video60) -> None:
    path, truth = video60

    def run(sub: str) -> dict:
        with TestClient(create_app(make_settings(tmp_path / sub))) as c:
            v = upload(c, path)
            job = c.post("/v1/perception/jobs", json=job_request(v["videoId"], truth)).json()
            assert wait_job(c, job["jobId"])["state"] == "done"
            raw = c.app.state.ctx.storage.load_result(c.get(f"/v1/jobs/{job['jobId']}").json() and c.app.state.ctx.storage.get_job(job["jobId"]).cache_key)
            data = json.loads(gzip.decompress(raw))
            for k in ("startedAt", "finishedAt", "processingS"):
                data["meta"].pop(k)
            return data

    a, b = run("one"), run("two")
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
