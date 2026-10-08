"""The perception pipeline: video in, PerceptionResult out. Runs in a worker process."""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .. import errors
from ..config import PIPELINE_VERSION, Settings
from ..demand.estimate import DepartRec, SatFlowResult, measure_saturation
from ..models.contracts import (
    APPROACHES,
    Departure,
    JunctionConfig,
    ModelInfo,
    Params,
    PerceptionOptions,
    PerceptionResult,
    SpeedSample,
)
from ..video.decode import DecodeStats, iter_frames, processing_scale
from ..video.probe import ProbeInfo
from .analysis import Analyzer, green_starts_from_onsets
from .detector import Detector
from .geometry import geometry_notes, validate_junction
from .tracker import Tracker

log = logging.getLogger("signaltwin.pipeline")


class Cancelled(Exception):
    """Raised inside the pipeline when the user cancels."""


@dataclass
class Progress:
    stage: str  # decoding | detecting | postprocessing
    fraction: float
    processed_s: float
    total_s: float
    fps: float
    eta_s: float | None
    message: str


ProgressFn = Callable[[Progress], None]


def _utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def choose_processing_fps(source_fps: float, options: PerceptionOptions, settings: Settings) -> tuple[float, int, list[str]]:
    """Returns (processed fps, stride in source frames, warnings). 'auto' keeps about 10 frames per second."""
    warns: list[str] = []
    ceiling = min(options.maxProcessedFps, 60.0)
    if options.stride == "auto":
        target = min(settings.target_fps, ceiling)
    else:
        target = max(0.5, source_fps / max(1, int(options.stride)))
        target = min(target, ceiling)
    target = min(target, source_fps)
    if source_fps < settings.min_fps:
        warns.append(f"The video runs at {source_fps:.1f} frames per second, below the {settings.min_fps:g} that tracking needs. Counts may be low.")
    stride = max(1, int(round(source_fps / target)))
    return target, stride, warns


def _luma(img: np.ndarray) -> float:
    small = cv2.resize(img, (64, 36), interpolation=cv2.INTER_AREA)
    return float(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).mean())


def _gray_small(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    width = 320
    height = max(2, int(round(h * width / w)))
    g = cv2.cvtColor(cv2.resize(img, (width, height), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    return np.asarray(g, dtype=np.float32)


def run_perception(
    video_path: Path,
    video_id: str,
    video_sha256: str,
    probe: ProbeInfo,
    junction: JunctionConfig,
    params: Params,
    options: PerceptionOptions,
    detector: Detector,
    settings: Settings,
    progress: ProgressFn | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> PerceptionResult:
    started = time.time()
    approaches, hg = validate_junction(junction, probe.width, probe.height)
    scale = processing_scale(probe.width, settings.max_proc_width)
    proc_fps, _stride, fps_warns = choose_processing_fps(probe.fps, options, settings)
    end_s = options.endS if options.endS is not None else probe.duration_s
    end_s = min(end_s, probe.duration_s)
    if options.startS >= end_s:
        raise errors.ApiError(
            "invalid_request", 422, "The time range is empty", "The start time is not before the end time.", "Choose a start time earlier than the end time."
        )
    total_s = end_s - options.startS
    tracker = Tracker(proc_fps)
    analyzer = Analyzer(approaches, hg, params, end_s + 2.0)  # absolute video time, so seconds before startS stay empty

    warnings: list[str] = list(probe.warnings) + fps_warns
    stats = DecodeStats()
    frames_out: list[dict[str, Any]] = []
    sample_every = max(options.frameSampleS, 1.0 / proc_fps)
    next_sample = options.startS
    luma_sum = 0.0
    luma_n = 0
    prev_gray: np.ndarray | None = None
    prev_gray_t = -1e9
    shifts: list[float] = []
    inv = 1.0 / scale
    last_report = time.time()
    n_frames = 0

    def report(stage: str, t_now: float, msg: str) -> None:
        nonlocal last_report
        if progress is None:
            return
        now = time.time()
        if stage == "detecting" and now - last_report < 0.5:
            return
        last_report = now
        done = max(0.0, t_now - options.startS)
        frac = min(1.0, done / total_s) if total_s > 0 else 1.0
        elapsed = now - started
        eta = elapsed * (1 - frac) / frac if frac > 0.02 else None
        progress(Progress(stage, frac, done, total_s, n_frames / elapsed if elapsed > 0 else 0.0, eta, msg))

    for fr in iter_frames(
        video_path,
        fps_hint=probe.fps,
        rotation=probe.rotation,
        start_offset_s=probe.start_offset_s,
        target_fps=proc_fps,
        scale=scale,
        start_s=options.startS,
        end_s=end_s,
        cancelled=cancelled,
        stats=stats,
    ):
        if cancelled and cancelled():
            raise Cancelled()
        n_frames += 1
        luma_sum += _luma(fr.image)
        luma_n += 1
        if fr.t - prev_gray_t >= 1.0:
            g = _gray_small(fr.image)
            if prev_gray is not None:
                (dx, dy), _ = cv2.phaseCorrelate(prev_gray, g)
                shifts.append(math.hypot(dx, dy) * (fr.image.shape[1] / 320.0) * inv)
            prev_gray, prev_gray_t = g, fr.t
        dets = detector.detect(fr.image, fr.t, fr.index)
        tracked = tracker.update(dets)
        # boxes back to original pixels: geometry is drawn in that space
        scaled = [type(t)(t.id, t.x1 * inv, t.y1 * inv, t.x2 * inv, t.y2 * inv, t.conf, t.cls) for t in tracked] if scale < 0.999 else tracked
        analyzer.update(fr.t, scaled)
        if fr.t + 1e-9 >= next_sample:
            frames_out.append(
                {
                    "t": round(fr.t, 3),
                    "detections": [
                        {
                            "id": t.id,
                            "cls": t.cls,
                            "x": round((t.x1 + t.x2) / 2, 1),
                            "y": round((t.y1 + t.y2) / 2, 1),
                            "w": round(t.x2 - t.x1, 1),
                            "h": round(t.y2 - t.y1, 1),
                            "conf": round(t.conf, 3),
                        }
                        for t in scaled
                    ],
                }
            )
            next_sample += sample_every
            if fr.t >= next_sample:
                next_sample = fr.t + sample_every
        report("detecting", fr.t, f"Analysing the video: {fr.t:,.0f} s of {end_s:,.0f} s")

    if cancelled and cancelled():
        raise Cancelled()
    if n_frames == 0:
        raise errors.video_unreadable("No frames could be decoded in the chosen time range.")
    report("postprocessing", end_s, "Measuring queues, speeds and saturation flow")

    out = analyzer.finish()
    cls_of = {tid: (tracker.final_class(tid) or st.cls) for tid, st in out.tracks.items()}
    pcu_of = {c: s.pcu for c, s in params.classes.items()}

    # Counts and departures with the final class of each track
    counts = [{"t": round(c.t, 3), "approach": APPROACHES[c.ap], "cls": cls_of[c.track], "line": c.line} for c in out.counts]
    deps = [
        Departure(t=round(d.t, 3), approach=APPROACHES[d.ap], cls=cls_of[d.track], pcu=pcu_of[cls_of[d.track]], sat=d.sat) for d in out.departures
    ]
    speeds = [SpeedSample(t=round(s.t, 3), approach=APPROACHES[s.ap], cls=cls_of[s.track], kmh=round(s.kmh, 2)) for s in out.speeds]
    waits = [round(w, 2) for w, _ap in sorted(out.waits)]

    # Queue in PCU uses the class at the time; recompute the rounding only
    queue = {
        "binS": 1,
        "approaches": {a: [round(v, 3) for v in out.queue_pcu[a]] for a in APPROACHES},
        "counts": {a: list(out.queue_veh[a]) for a in APPROACHES},
    }

    # Saturation flow from discharge headways
    dep_recs = [DepartRec(d.t, APPROACHES.index(d.approach), d.cls, d.pcu, d.sat) for d in deps]
    greens = green_starts_from_onsets(out.onsets, junction.observed.fourPhase)
    sat_params = params.model_copy(update={"fourPhase": junction.observed.fourPhase})
    sf: SatFlowResult = measure_saturation(dep_recs, greens, sat_params)
    sat_flow = {
        "perLane": round(sf.per_lane, 1),
        "startupLost": round(sf.startup_lost, 2),
        "headways": [round(h, 3) for h in sf.headways],
        "samples": sf.samples,
        "isDefault": sf.is_default,
        "startupLostIsDefault": bool(sf.is_default or sf.n_first == 0),
    }

    # Quality
    mean_luma = luma_sum / max(1, luma_n)
    low_light = mean_luma < 60.0
    motion_p95 = float(np.percentile(shifts, 95)) if shifts else 0.0
    q_warnings: list[str] = []
    ended = [st for st in out.tracks.values() if st.n_obs >= 3]
    border_x, border_y = 0.05 * probe.width, 0.05 * probe.height
    premature = 0
    for st in ended:
        x, y = st.last_xy
        at_edge = x < border_x or x > probe.width - border_x or y < border_y or y > probe.height - border_y
        at_end = st.last_t >= end_s - 1.0
        if not (at_edge or at_end or st.crossed_stop):
            premature += 1
    fragmentation = premature / len(ended) if ended else 0.0
    mean_conf = out.mean_conf
    if low_light:
        q_warnings.append("The video is dark. Vehicles may be missed, mostly two-wheelers.")
    if motion_p95 > 3.0:
        q_warnings.append(f"The camera moves by about {motion_p95:.1f} pixels between seconds. Lines may drift off the road.")
    if fragmentation > 0.15:
        q_warnings.append(f"About {fragmentation * 100:.0f}% of tracks stopped inside the picture. Vehicles may be counted late or missed.")
    if mean_conf and mean_conf < 0.45:
        q_warnings.append(f"The detector is not confident (average {mean_conf:.2f}). Check the camera angle and lighting.")
    if not detector.info.maps_auto_rickshaw:
        q_warnings.append("This detection model has no auto-rickshaw class, so auto-rickshaws are reported as cars or two-wheelers.")
    if hg is None:
        q_warnings.append("No calibration was given, so speeds are not measured and queue detection uses box heights per second.")
    if stats.corrupt_skipped:
        q_warnings.append(f"{stats.corrupt_skipped} damaged video packets were skipped.")
    if out.dropped_speeds:
        q_warnings.append(f"{out.dropped_speeds} speed readings above {130} km/h were discarded as errors.")
    q_warnings.extend(geometry_notes(junction.geometry))
    for ap in approaches:
        n_up = sum(1 for c in out.counts if c.ap == ap.index and c.line == "upstream")
        n_stop = sum(1 for c in out.counts if c.ap == ap.index and c.line == "stop")
        if ap.upstream is not None and n_up == 0 and total_s > 120:
            q_warnings.append(f"No vehicles were counted on the {ap.name} upstream line. Check that the line is drawn on the road.")
        if ap.stop is not None and n_stop == 0 and total_s > 120:
            q_warnings.append(f"No vehicles were counted on the {ap.name} stop line. Check that the line is drawn on the road.")
    if (sf.is_default) and total_s > 0:
        q_warnings.append("Not enough queue discharge was seen to measure saturation flow, so the default value is used.")
    risk = "low"
    if low_light or fragmentation > 0.25 or (mean_conf and mean_conf < 0.4) or motion_p95 > 8.0:
        risk = "high"
    elif fragmentation > 0.10 or (mean_conf and mean_conf < 0.55) or motion_p95 > 3.0 or not detector.info.maps_auto_rickshaw:
        risk = "medium"

    finished = time.time()
    meta = {
        "videoId": video_id,
        "sha256": video_sha256,
        "durationS": round(total_s, 3),
        "sourceFps": round(probe.fps, 3),
        "processedFps": round(proc_fps, 3),
        "stride": max(1, int(round(probe.fps / proc_fps))),
        "width": probe.width,
        "height": probe.height,
        "frameCount": n_frames,
        "model": ModelInfo(
            name=detector.info.name, version=f"{detector.info.version}+pipeline{PIPELINE_VERSION}", sha256=detector.info.sha256, device=detector.info.device
        ).model_dump(),
        "startedAt": _utc(started),
        "finishedAt": _utc(finished),
        "processingS": round(finished - started, 2),
        "warnings": warnings,
    }
    result = {
        "fps": round(min(proc_fps, 1.0 / sample_every), 3),
        "width": probe.width,
        "height": probe.height,
        "frames": frames_out,
        "counts": counts,
        "meta": meta,
        "queue": queue,
        "speeds": [s.model_dump() for s in speeds],
        "departures": [d.model_dump() for d in deps],
        "waits": waits,
        "satFlow": sat_flow,
        "quality": {
            "meanConfidence": round(mean_conf, 3),
            "trackFragmentation": round(fragmentation, 3),
            "lowLight": low_light,
            "cameraMotionPx": round(motion_p95, 2),
            "missedCountRisk": risk,
            "warnings": q_warnings,
        },
    }
    return PerceptionResult.model_validate(result)
