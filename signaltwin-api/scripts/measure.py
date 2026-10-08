"""Measures the perception pipeline and writes docs/MEASUREMENTS.md. Run from signaltwin-api:  python scripts/measure.py

What it measures, and what it does not:
- Accuracy against synthetic ground truth. This checks the counting, queue, wait, speed and saturation logic.
  It says nothing about how well a model finds vehicles in real footage.
- Speed and memory with the real YOLO model on CPU, on a 1280 x 720 clip.
"""

from __future__ import annotations

import collections
import platform
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import psutil

from signaltwin_api.config import Settings
from signaltwin_api.demand.estimate import DepartRec, measure_saturation
from signaltwin_api.models.contracts import APPROACHES, JunctionConfig, Params, PerceptionOptions
from signaltwin_api.perception.detector import SyntheticDetector, YoloDetector, file_sha256
from signaltwin_api.perception.pipeline import run_perception
from signaltwin_api.testing import synth
from signaltwin_api.video.probe import probe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "docs" / "MEASUREMENTS.md"


class PeakRss:
    def __init__(self) -> None:
        self.peak = 0
        self._stop = threading.Event()
        self._p = psutil.Process()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.peak = max(self.peak, self._p.memory_info().rss)
            time.sleep(0.1)

    def __enter__(self) -> PeakRss:
        self._t.start()
        return self

    def __exit__(self, *a: object) -> None:
        self._stop.set()
        self._t.join()


def accuracy(seconds: float, seed: int, tmp: Path) -> dict[str, float]:
    cfg = synth.SynthConfig(seconds=seconds, seed=seed)
    truth = synth.simulate(cfg)
    path = tmp / f"s{seed}.mp4"
    synth.write_video(truth, path)
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    info = probe(path, s)
    j = JunctionConfig.model_validate(truth.junction)
    params = Params(lanes=1)
    res = run_perception(path, "v_m", "0" * 64, info, j, params, PerceptionOptions(), SyntheticDetector(), s)

    out: dict[str, float] = {}
    for line in ("upstream", "stop"):
        t = sum(1 for c in truth.counts if c["line"] == line)
        m = sum(1 for c in (res.counts or []) if c.line == line)
        out[f"count_{line}_truth"] = t
        out[f"count_{line}_measured"] = m
    tc = collections.Counter((c["approach"], c["line"]) for c in truth.counts)
    mc = collections.Counter((c.approach, c.line) for c in (res.counts or []))
    out["count_abs_error_per_line_mean"] = sum(abs(tc[k] - mc[k]) for k in tc) / max(1, len(tc))
    tcls = collections.Counter((c["line"], c["cls"]) for c in truth.counts)
    mcls = collections.Counter((c.line, c.cls) for c in (res.counts or []))
    out["class_abs_error_total"] = sum(abs(tcls[k] - mcls[k]) for k in set(tcls) | set(mcls))
    n = int(seconds)
    q_err = [abs(truth.queue_veh[a][i] - (res.queue.counts[a][i] if res.queue else 0)) for a in APPROACHES for i in range(n)]
    out["queue_mae_vehicles"] = float(np.mean(q_err))
    out["queue_max_truth"] = max(max(truth.queue_veh[a][:n]) for a in APPROACHES)
    tw = [w["seconds"] for w in truth.waits]
    mw = res.waits or []
    out["waits_truth"] = len(tw)
    out["waits_measured"] = len(mw)
    out["wait_mean_truth_s"] = statistics.mean(tw) if tw else 0
    out["wait_mean_measured_s"] = statistics.mean(mw) if mw else 0
    sp_t = [d["kmh"] for d in truth.departures]
    sp_m = [x.kmh for x in (res.speeds or [])]
    out["speed_mean_truth_kmh"] = statistics.mean(sp_t) if sp_t else 0
    out["speed_mean_measured_kmh"] = statistics.mean(sp_m) if sp_m else 0
    out["departures_truth"] = len(truth.departures)
    out["departures_measured"] = len(res.departures or [])
    out["sat_flags_truth"] = sum(d["sat"] for d in truth.departures)
    out["sat_flags_measured"] = sum(d.sat for d in (res.departures or []))
    t_deps = [DepartRec(d["t"], APPROACHES.index(d["approach"]), d["cls"], d["pcu"], d["sat"]) for d in truth.departures]
    tsf = measure_saturation(t_deps, truth.green_starts, params)
    out["satflow_truth"] = tsf.per_lane
    out["satflow_measured"] = res.satFlow.perLane if res.satFlow else 0
    out["satflow_truth_isdefault"] = float(tsf.is_default)
    out["startup_truth_s"] = tsf.startup_lost
    out["startup_measured_s"] = res.satFlow.startupLost if res.satFlow else 0
    return out


def speed(tmp: Path) -> dict[str, float | str]:
    weights = ROOT / "models" / "yolo11n.pt"
    if not weights.exists():
        return {}
    truth = synth.simulate(synth.SynthConfig(seconds=120, seed=3))
    path = tmp / "speed.mp4"
    synth.write_video(truth, path)
    s = Settings(model_weights=str(weights), device="cpu", detector="yolo", _env_file=None)  # type: ignore[call-arg]
    info = probe(path, s)
    j = JunctionConfig.model_validate(truth.junction)
    det = YoloDetector(s)
    with PeakRss() as pr:
        t0 = time.time()
        res = run_perception(path, "v_s", file_sha256(path), info, j, Params(lanes=1), PerceptionOptions(), det, s)
        wall = time.time() - t0
    frames = res.meta.frameCount if res.meta else 0
    return {
        "clip_seconds": 120,
        "resolution": "1280x720",
        "processed_frames": frames,
        "wall_seconds": round(wall, 1),
        "realtime_factor": round(120 / wall, 2),
        "ms_per_frame": round(1000 * wall / max(1, frames), 1),
        "peak_rss_mb": round(pr.peak / 1048576),
        "device": det.info.device,
    }


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        rows = [accuracy(300, seed, tmp) for seed in (7, 21, 33)]
        sp = speed(tmp)
    keys = list(rows[0])
    mean = {k: statistics.mean(r[k] for r in rows) for k in keys}
    lines = [
        "# Measurements",
        "",
        "Generated by `signaltwin-api/scripts/measure.py`. Numbers are from one run on the machine below; they will differ on yours.",
        "",
        f"Machine: {platform.platform()}, {psutil.cpu_count(logical=False)} cores, {round(psutil.virtual_memory().total / 2**30)} GB, Python {sys.version.split()[0]}.",
        "",
        "## What these numbers are",
        "",
        "Accuracy is measured against a **synthetic** junction with exact ground truth (`signaltwin_api/testing/synth.py`): rectangles on a plan view, "
        "coloured by class, with a non-ML blob detector. It tests the counting, queue, wait, speed and saturation logic and the video path (decode, scaling, tracking). "
        "It does **not** measure how well YOLO finds vehicles in real footage. No labelled real clip was available, so real-footage accuracy is **not measured**.",
        "",
        "## Accuracy against synthetic ground truth (3 clips of 300 s)",
        "",
        "| Quantity | Truth (mean) | Measured (mean) |",
        "| --- | --- | --- |",
    ]
    pairs = [
        ("Upstream-line counts", "count_upstream_truth", "count_upstream_measured"),
        ("Stop-line counts", "count_stop_truth", "count_stop_measured"),
        ("Departures", "departures_truth", "departures_measured"),
        ("Departures flagged saturated", "sat_flags_truth", "sat_flags_measured"),
        ("Vehicles with a measured wait", "waits_truth", "waits_measured"),
        ("Mean wait (s)", "wait_mean_truth_s", "wait_mean_measured_s"),
        ("Mean speed at the stop line (km/h)", "speed_mean_truth_kmh", "speed_mean_measured_kmh"),
        ("Saturation flow (PCU/h/lane)", "satflow_truth", "satflow_measured"),
        ("Start-up lost time (s)", "startup_truth_s", "startup_measured_s"),
    ]
    for label, a, b in pairs:
        lines.append(f"| {label} | {mean[a]:.1f} | {mean[b]:.1f} |")
    lines += [
        "",
        f"Mean absolute count error per approach and line: {mean['count_abs_error_per_line_mean']:.2f} vehicles. "
        f"Mean absolute queue error: {mean['queue_mae_vehicles']:.3f} vehicles (largest queue in truth {mean['queue_max_truth']:.1f}).",
        "",
        "Per clip:",
        "",
        "| Clip seed | Upstream truth/measured | Stop truth/measured | Queue MAE (veh) | Mean wait truth/measured (s) |",
        "| --- | --- | --- | --- | --- |",
    ]
    for seed, r in zip((7, 21, 33), rows, strict=True):
        lines.append(
            f"| {seed} | {r['count_upstream_truth']:.0f} / {r['count_upstream_measured']:.0f} | {r['count_stop_truth']:.0f} / {r['count_stop_measured']:.0f} | "
            f"{r['queue_mae_vehicles']:.3f} | {r['wait_mean_truth_s']:.1f} / {r['wait_mean_measured_s']:.1f} |"
        )
    lines += ["", "## Speed and memory with the real model (YOLO11n, CPU)", ""]
    if sp:
        lines += [
            "Run on a 120 s, 1280 x 720 synthetic clip so the cost of decoding, inference, tracking and analysis is representative (the model finds no vehicles in rectangles, so tracking cost is lower than on real traffic).",
            "",
            "| Measure | Value |",
            "| --- | --- |",
        ] + [f"| {k.replace('_', ' ')} | {v} |" for k, v in sp.items()]
    else:
        lines.append("models/yolo11n.pt was not found, so speed was not measured.")
    lines += [
        "",
        "## Frame-rate sensitivity (synthetic, exact detections)",
        "",
        "The tracker matches boxes between frames, so it needs enough frames per second. From `tests/test_analysis.py` on a 240 s clip with perfect detections: "
        "counts are exact at 12.5 frames per second, within 2 percent at 8.3, and within 12 percent at 5. The pipeline processes about 10 frames per second by default and warns below 5.",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
