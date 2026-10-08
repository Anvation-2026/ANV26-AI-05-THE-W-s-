"""Service basics: health, limits, errors, CORS, auth, rate limit, body limit."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from signaltwin_api.main import create_app

from .conftest import make_settings

PROBLEM_KEYS = {"type", "code", "status", "title", "detail", "fix"}


def assert_problem(r, status: int, code: str | None = None) -> dict:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert set(body) >= PROBLEM_KEYS, body
    assert body["status"] == status
    assert body["fix"] and body["detail"] and body["title"]
    assert "Traceback" not in r.text and "File \"" not in r.text
    if code:
        assert body["code"] == code
    return body


def test_health_is_open_and_reports_state(client: TestClient) -> None:
    r = client.get("/v1/health")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok" and b["version"] and b["model"]["available"] is True
    assert b["queue"]["workers"] == 1
    assert "X-Correlation-Id" in r.headers or "x-correlation-id" in r.headers


def test_health_degraded_when_model_missing(tmp_path: Path) -> None:
    s = make_settings(tmp_path, detector="yolo", model_weights=str(tmp_path / "nope.pt"))
    with TestClient(create_app(s)) as c:
        b = c.get("/v1/health").json()
        assert b["status"] == "degraded" and b["model"]["available"] is False and "missing" in b["message"]


def test_limits(client: TestClient) -> None:
    b = client.get("/v1/limits").json()
    assert b["maxUploadMb"] == 800 and b["minDurationS"] == 3 and "mp4" in b["acceptedFormats"]


def test_unknown_route_is_problem_json(client: TestClient) -> None:
    assert_problem(client.get("/v1/nothing"), 404, "not_found")


def test_wrong_method_is_problem_json(client: TestClient) -> None:
    assert_problem(client.put("/v1/health"), 405, "method_not_allowed")


def test_validation_error_is_plain(client: TestClient) -> None:
    b = assert_problem(client.post("/v1/perception/jobs", json={"videoId": 5}), 422)
    assert "videoId" in b["detail"] or "junction" in b["detail"]


def test_correlation_id_is_echoed_and_sanitised(client: TestClient) -> None:
    r = client.get("/v1/health", headers={"X-Correlation-Id": "abc-123"})
    assert r.headers["x-correlation-id"] == "abc-123"
    r = client.get("/v1/health", headers={"X-Correlation-Id": "bad id with spaces\t"})
    assert r.headers["x-correlation-id"] != "bad id with spaces\t" and len(r.headers["x-correlation-id"]) == 12


def test_cors_allows_the_front_end_and_rejects_others(client: TestClient) -> None:
    ok = client.options("/v1/videos", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-filename,content-type"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "x-filename" in ok.headers["access-control-allow-headers"].lower()
    bad = client.options("/v1/videos", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
    r = client.get("/v1/health", headers={"Origin": "http://localhost:5173"})
    assert "x-correlation-id" in r.headers["access-control-expose-headers"].lower()


def test_api_key_is_required_when_configured(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, api_key="s3cret"))) as c:
        assert c.get("/v1/health").status_code == 200  # health stays open
        assert c.get("/v1/health").json()["authRequired"] is True
        assert_problem(c.get("/v1/limits"), 401, "unauthorized")
        assert_problem(c.get("/v1/limits", headers={"X-API-Key": "wrong"}), 401)
        assert c.get("/v1/limits", headers={"X-API-Key": "s3cret"}).status_code == 200
        assert c.get("/v1/limits?api_key=s3cret").status_code == 200  # for <video> and <img> that cannot send headers


def test_rate_limit_returns_429_with_retry_after(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, rate_limit_per_minute=5))) as c:
        codes = [c.get("/v1/limits").status_code for _ in range(8)]
        assert codes[:5] == [200] * 5 and 429 in codes[5:]
        r = c.get("/v1/limits")
        body = assert_problem(r, 429)
        assert int(r.headers["retry-after"]) >= 1 and body["retryAfterS"] >= 1


def test_json_body_over_limit_is_rejected(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(tmp_path, max_json_kb=1))) as c:
        r = c.post("/v1/demand/estimate", content=b"{" + b" " * 5000 + b"}", headers={"Content-Type": "application/json"})
        assert_problem(r, 413, "request_too_large")


def test_junction_round_trip(client: TestClient) -> None:
    assert_problem(client.get("/v1/junction"), 404)
    j = {"id": "j1", "name": "Test junction", "source": "video", "geometry": {}, "observed": {"greens": [30, 30], "yellow": 3, "allRed": 2, "fourPhase": False}}
    r = client.put("/v1/junction", json=j)
    assert r.status_code == 200
    assert client.get("/v1/junction").json()["name"] == "Test junction"
    assert_problem(client.put("/v1/junction", json={**j, "name": ""}), 422)
