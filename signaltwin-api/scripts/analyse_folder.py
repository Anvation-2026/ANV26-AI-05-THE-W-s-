"""Analyses a folder of videos with hand-placed counting lines and writes results, annotated videos and a summary.

Usage (from signaltwin-api):  python scripts/analyse_folder.py N:/ANVATION/Videos

The lines for each clip are in the CLIPS table below, drawn by looking at a sample frame. No ground truth exists for these
clips, so the output is what the pipeline measured, not a verified accuracy.
"""

from __future__ import annotations

import collections
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import av
import cv2
import numpy as np

from signaltwin_api.config import Settings
from signaltwin_api.models.contracts import APPROACHES, JunctionConfig, Params, PerceptionOptions
from signaltwin_api.perception.detector import YoloDetector, file_sha256
from signaltwin_api.perception.pipeline import run_perception
from signaltwin_api.video.decode import iter_frames
from signaltwin_api.video.probe import probe

ROOT = Path(__file__).resolve().parents[1]


def line(a: tuple[float, float], b: tuple[float, float]) -> dict[str, Any]:
    return {"a": {"x": a[0], "y": a[1]}, "b": {"x": b[0], "y": b[1]}}


def zone(*pts: tuple[float, float]) -> list[dict[str, float]]:
    return [{"x": x, "y": y} for x, y in pts]


def junction(name: str, w: int, h: int, d: float, stops: dict, ups: dict, zones: dict) -> dict[str, Any]:
    return {
        "id": name, "name": name, "source": "video", "videoSize": {"w": w, "h": h, "duration": d},
        "geometry": {"stopLines": stops, "upstreamLines": ups, "queueZones": zones}, "calibration": None,
        "observed": {"greens": [30, 30], "yellow": 3, "allRed": 2, "fourPhase": False}, "updatedAt": "2026-10-09T00:00:00Z",
    }


# N heads down the picture, S up it, E left, W right, whatever the compass says: the names only label the approaches.
CLIPS: dict[str, dict[str, Any]] = {
    "bangalore": {
        "match": "bangalore", "model": "yolo11m", "label": "Bangalore flyover, elevated view of a congested road",
        "junction": junction(
            "bangalore", 898, 506, 16,
            {"N": line((450, 330), (898, 330)), "S": line((0, 330), (300, 330))},
            {"N": line((480, 200), (800, 200)), "S": line((80, 220), (300, 220))},
            {"N": zone((455, 205), (800, 205), (898, 325), (450, 325)), "S": zone((80, 225), (300, 225), (300, 325), (0, 325))},
        ),
    },
    "delhi": {
        "match": "delhi", "model": "yolo11m", "label": "Delhi highway, elevated view, two carriageways",
        "junction": junction(
            "delhi", 898, 506, 6,
            {"N": line((560, 340), (850, 340)), "S": line((110, 150), (380, 150))},
            {"N": line((480, 150), (690, 150)), "S": line((30, 350), (440, 350))},
            {"N": zone((485, 155), (690, 155), (850, 335), (560, 335)), "S": zone((40, 345), (440, 345), (375, 155), (115, 155))},
        ),
    },
    "timelapse": {
        "match": "time-lapse", "model": "aerial/visdrone-yolo11s", "label": "Time-lapse drone view of a large multi-lane junction",
        "junction": junction(
            "timelapse", 596, 336, 13,
            {"N": line((200, 125), (250, 125)), "S": line((290, 255), (335, 255))},
            {"N": line((175, 25), (245, 25)), "S": line((295, 325), (345, 325))},
            {"N": zone((180, 30), (245, 30), (250, 120), (200, 120)), "S": zone((295, 320), (345, 320), (335, 260), (290, 260))},
        ),
    },
    "topdown": {"match": "top-down", "model": "aerial/visdrone-yolo11s", "label": "Top-down drone view of an intersection", "junction": None},
}


def saved_junction(name: str) -> dict[str, Any]:
    """The junction drawn in the app for the top-down clip, read from the server's own job records."""
    db = sqlite3.connect(ROOT / "data" / "signaltwin.db")
    for (j,) in db.execute("select json from jobs order by created_at desc"):
        req = json.loads(j)["request"]
        if req.get("junction", {}).get("name") == name:
            return req["junction"]
    raise SystemExit(f"no saved junction called {name!r}")


def draw(img: np.ndarray, frame: dict[str, Any] | None, j: dict[str, Any], counts: dict[str, int], t: float) -> np.ndarray:
    out = img.copy()
    g = j["geometry"]
    for ap, ln in g["upstreamLines"].items():
        cv2.line(out, (int(ln["a"]["x"]), int(ln["a"]["y"])), (int(ln["b"]["x"]), int(ln["b"]["y"])), (0, 255, 255), 2)
    for ap, ln in g["stopLines"].items():
        cv2.line(out, (int(ln["a"]["x"]), int(ln["a"]["y"])), (int(ln["b"]["x"]), int(ln["b"]["y"])), (0, 0, 255), 2)
    for ap, z in g["queueZones"].items():
        cv2.polylines(out, [np.array([[p["x"], p["y"]] for p in z], np.int32)], True, (255, 200, 0), 1)
    if frame:
        for d in frame["detections"]:
            x1, y1, x2, y2 = int(d["x"] - d["w"] / 2), int(d["y"] - d["h"] / 2), int(d["x"] + d["w"] / 2), int(d["y"] + d["h"] / 2)
            cv2.rectangle(out, (x1, y1), (x2, y2), (60, 255, 60), 1)
            cv2.putText(out, str(d["id"]), (x1, max(8, y1 - 2)), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 255, 60), 1)
    txt = f"t {t:5.1f}s   crossed upstream line: " + "  ".join(f"{a} {counts.get(a + ':upstream', 0)}" for a in APPROACHES if a in g["stopLines"]) + "   stop line: " + "  ".join(f"{a} {counts.get(a + ':stop', 0)}" for a in APPROACHES if a in g["stopLines"])
    cv2.rectangle(out, (0, 0), (out.shape[1], 18), (0, 0, 0), -1)
    cv2.putText(out, txt, (4, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1)
    return out


def render(video: Path, res: Any, j: dict[str, Any], probe_info: Any, out_path: Path) -> None:
    frames = [f.model_dump() for f in res.frames]
    times = np.array([f["t"] for f in frames])
    events = sorted(((c.t, f"{c.approach}:{c.line}") for c in (res.counts or [])))
    container = av.open(str(out_path), "w")
    stream = container.add_stream("libx264", rate=10)
    stream.width, stream.height, stream.pix_fmt = probe_info.width, probe_info.height, "yuv420p"
    stream.options = {"crf": "20"}
    for fr in iter_frames(video, fps_hint=probe_info.fps, rotation=probe_info.rotation, start_offset_s=probe_info.start_offset_s, target_fps=10, scale=1.0):
        i = int(np.argmin(np.abs(times - fr.t))) if len(times) else -1
        f = frames[i] if i >= 0 and abs(times[i] - fr.t) < 0.3 else None
        counts: dict[str, int] = collections.Counter()
        for et, key in events:
            if et <= fr.t:
                counts[key] += 1
        img = draw(fr.image, f, j, counts, fr.t)
        for pkt in stream.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
            container.mux(pkt)
    for pkt in stream.encode():
        container.mux(pkt)
    container.close()


def main() -> None:
    folder = Path(sys.argv[1])
    out_dir = folder / "results"
    out_dir.mkdir(exist_ok=True)
    summary: list[dict[str, Any]] = []
    for key, spec in CLIPS.items():
        files = [p for p in folder.iterdir() if p.is_file() and spec["match"] in p.name.lower()]
        if not files:
            print("missing", key)
            continue
        video = files[0]
        j = spec["junction"] or saved_junction("traffic")
        weights = ROOT / "models" / f"{spec['model']}.pt"
        s = Settings(model_weights=str(weights), device="cpu", detector="yolo", _env_file=None)  # type: ignore[call-arg]
        info = probe(video, s)
        det = YoloDetector(s)
        t0 = time.time()
        res = run_perception(video, key, file_sha256(video), info, JunctionConfig.model_validate(j), Params(lanes=2), PerceptionOptions(frameSampleS=0.1), det, s)
        took = time.time() - t0
        n = [len(f.detections) for f in res.frames]
        counts = collections.Counter((c.approach, c.line) for c in (res.counts or []))
        classes = collections.Counter(c.cls for c in (res.counts or []) if c.line == "upstream")
        row = {
            "clip": key, "file": video.name, "what": spec["label"], "model": spec["model"], "resolution": f"{info.width}x{info.height}", "seconds": round(info.duration_s, 1),
            "analysis_s": round(took, 1), "detections_per_frame": round(sum(n) / max(1, len(n)), 1), "tracks": len({d.id for f in res.frames for d in f.detections}),
            "upstream": {a: counts[(a, "upstream")] for a in j["geometry"]["stopLines"]}, "stop": {a: counts[(a, "stop")] for a in j["geometry"]["stopLines"]},
            "classes_upstream": dict(classes), "queue_max_vehicles": {a: max(v) for a, v in (res.queue.counts if res.queue else {}).items() if a in j["geometry"]["stopLines"]},
            "waits_measured": len(res.waits or []), "mean_wait_s": round(float(np.mean(res.waits)), 1) if res.waits else None,
            "saturation_flow": None if (res.satFlow is None or res.satFlow.isDefault) else round(res.satFlow.perLane),
            "risk": res.quality.missedCountRisk if res.quality else None, "warnings": res.quality.warnings if res.quality else [],
        }
        summary.append(row)
        (out_dir / f"{key}.result.json").write_text(res.model_dump_json(exclude_none=True), encoding="utf-8")
        render(video, res, j, info, out_dir / f"{key}.annotated.mp4")
        print(key, json.dumps({k: row[k] for k in ("detections_per_frame", "upstream", "stop", "queue_max_vehicles", "risk")}))
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
