"""Load test. Starts its own API (synthetic detector) and writes docs/LOAD_TEST.md.  Run from signaltwin-api:  python scripts/load_test.py

It checks that the API stays responsive while it works, not how many users one machine can serve.
"""

from __future__ import annotations

import concurrent.futures as cf
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import psutil

from signaltwin_api.testing import synth

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "docs" / "LOAD_TEST.md"
PORT = 8012
BASE = f"http://127.0.0.1:{PORT}"


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0.0


def timed(client: httpx.Client, method: str, url: str, **kw: object) -> tuple[float, int]:
    t0 = time.perf_counter()
    try:
        r = client.request(method, url, **kw)  # type: ignore[arg-type]
        return (time.perf_counter() - t0) * 1000, r.status_code
    except httpx.HTTPError:
        return (time.perf_counter() - t0) * 1000, 0


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="signaltwin-load-"))
    env = {
        "DETECTOR": "synthetic", "DATA_DIR": str(tmp / "data"), "LOG_LEVEL": "WARNING", "RATE_LIMIT_PER_MINUTE": "100000",
        "UPLOAD_LIMIT_PER_HOUR": "100000", "QUEUE_MAX": "16",
    }
    import os

    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "signaltwin_api.main:app", "--port", str(PORT), "--log-level", "warning"], cwd=ROOT, env={**os.environ, **env})
    rows: list[tuple[str, str]] = []
    try:
        for _ in range(80):
            try:
                if httpx.get(f"{BASE}/v1/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            raise SystemExit("the API did not start")
        client = httpx.Client(base_url=BASE, timeout=120, limits=httpx.Limits(max_connections=64))

        # A. many small requests at once
        with cf.ThreadPoolExecutor(32) as ex:
            res = list(ex.map(lambda i: timed(client, "GET", "/v1/health" if i % 2 else "/v1/limits"), range(400)))
        lat = [r[0] for r in res]
        bad = sum(1 for r in res if r[1] != 200)
        rows.append(("400 health and limits requests, 32 at a time", f"p50 {pct(lat, .5):.0f} ms, p95 {pct(lat, .95):.0f} ms, p99 {pct(lat, .99):.0f} ms, {bad} failures"))

        # B. concurrent uploads of different videos
        paths = []
        for i in range(8):
            p = tmp / f"v{i}.mp4"
            synth.write_video(synth.simulate(synth.SynthConfig(seconds=20, seed=100 + i)), p)
            paths.append(p)

        def up(p: Path) -> tuple[float, int]:
            return timed(client, "POST", "/v1/videos", content=p.read_bytes(), headers={"Content-Type": "application/octet-stream", "X-Filename": p.name})

        t0 = time.perf_counter()
        with cf.ThreadPoolExecutor(8) as ex:
            ups = list(ex.map(up, paths))
        rows.append(("8 videos (0.3 MB each) uploaded at once", f"{sum(1 for u in ups if u[1] == 201)} of 8 accepted, slowest {max(u[0] for u in ups):.0f} ms, all done in {time.perf_counter() - t0:.1f} s"))

        # C. responsiveness while an analysis runs
        truth = synth.simulate(synth.SynthConfig(seconds=120, seed=9))
        long = tmp / "long.mp4"
        synth.write_video(truth, long)
        vid = client.post("/v1/videos", content=long.read_bytes(), headers={"Content-Type": "application/octet-stream"}).json()["videoId"]
        job = client.post("/v1/perception/jobs", json={"videoId": vid, "junction": truth.junction, "params": {"lanes": 1}}).json()["jobId"]
        while client.get(f"/v1/jobs/{job}").json()["state"] in ("queued", "probing", "decoding"):
            time.sleep(0.2)
        with cf.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(lambda _: timed(client, "GET", "/v1/health"), range(200)))
        lat = [r[0] for r in res]
        rows.append(("200 health requests while a 120 s video is being analysed", f"p50 {pct(lat, .5):.0f} ms, p95 {pct(lat, .95):.0f} ms, max {max(lat):.0f} ms, {sum(1 for r in res if r[1] != 200)} failures"))
        t1 = time.time()
        client.post(f"/v1/jobs/{job}/cancel")
        while client.get(f"/v1/jobs/{job}").json()["state"] not in ("cancelled", "done", "error"):
            time.sleep(0.05)
        rows.append(("Cancel of the running analysis", f"{(time.time() - t1) * 1000:.0f} ms until the job reports cancelled"))

        # D. demand estimates in parallel
        body = {"source": {"kind": "counts", "rows": [{"t": i * 0.5, "approach": "NSEW"[i % 4], "cls": "car", "count": 1} for i in range(8000)]}}
        with cf.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(lambda _: timed(client, "POST", "/v1/demand/estimate", json=body), range(24)))
        lat = [r[0] for r in res]
        rows.append(("24 demand estimates of 8000 rows, 8 at a time", f"p50 {pct(lat, .5):.0f} ms, p95 {pct(lat, .95):.0f} ms, {sum(1 for r in res if r[1] != 200)} failures"))

        # E. memory of the API process after all that
        root = psutil.Process(proc.pid)
        rss = sum(p.memory_info().rss for p in [root, *root.children(recursive=True)]) / 1048576  # a venv launcher on Windows starts the real process as a child
        rows.append(("API memory after the run (API and any worker processes still alive)", f"{rss:.0f} MB"))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
    lines = [
        "# Load test",
        "",
        "Generated by `signaltwin-api/scripts/load_test.py` against a local API with the synthetic detector. It shows that the API stays responsive while it works. It is not a capacity figure for any server.",
        "",
        f"Machine: {platform.platform()}, {psutil.cpu_count(logical=False)} cores, Python {sys.version.split()[0]}.",
        "",
        "| Test | Result |",
        "| --- | --- |",
    ] + [f"| {a} | {b} |" for a, b in rows]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    _ = statistics


if __name__ == "__main__":
    main()
